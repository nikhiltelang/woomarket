/**
 * Chatbot and auto-replies: after each incoming message, picks at most one rule (see
 * shared/chatbot.ts) and answers on the conversation's channel. A person replying, or a hand-off,
 * pauses the bot in that conversation.
 */
import crypto from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  botSettingsSchema,
  isWithinHours,
  pickRule,
  responseAsText,
  ruleSchema,
  type BotChannel,
  type BotResponse,
  type BotSettings,
  type RuleInput,
  type TriggerType,
} from "@shared/chatbot";
import { chatbotEvents, chatbotRules, conversations, tenantSettings, type ChatbotRule, type Conversation, type Message } from "@shared/schema";
import { db } from "../db";
import { childLogger } from "../lib/logger";
import { channelsRepository } from "../repositories/channels.repository";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { usersRepository } from "../repositories/users.repository";
import { botAnswer, transcript } from "./ai/assistant.service";
import { tenantSettingsRepository } from "./delivery.service";
import { assertMessageQuota } from "./levels.service";
import { realtime } from "./realtime";
import { sendSocialReply, socialAccountsRepository } from "./social.service";
import { whatsappFactory } from "./whatsapp";

const log = childLogger("chatbot");

/** A conversation counts as new again after this much silence (for the welcome rule). */
export const NEW_SESSION_MS = 24 * 60 * 60 * 1000;
/** Loop guard: at most this many bot replies per conversation within the window. */
export const LOOP_LIMIT = 6;
export const LOOP_WINDOW_MS = 2 * 60 * 1000;
const EVENT_RETENTION_DAYS = 30;

export type Outcome = "replied" | "handoff" | "skipped" | "failed";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const chatbotRepository = {
  async settings(tenantId: string): Promise<BotSettings> {
    const [row] = await db.select({ chatbot: tenantSettings.chatbot }).from(tenantSettings).where(eq(tenantSettings.userId, tenantId)).limit(1);
    const parsed = botSettingsSchema.safeParse(row?.chatbot ?? {});
    return parsed.success ? parsed.data : botSettingsSchema.parse({});
  },
  async saveSettings(tenantId: string, s: BotSettings): Promise<void> {
    const value = s as unknown as Record<string, unknown>;
    await db.insert(tenantSettings).values({ userId: tenantId, chatbot: value }).onDuplicateKeyUpdate({ set: { chatbot: value } });
  },
  rules(tenantId: string): Promise<ChatbotRule[]> {
    return db.select().from(chatbotRules).where(eq(chatbotRules.userId, tenantId)).orderBy(asc(chatbotRules.priority), asc(chatbotRules.createdAt));
  },
  async find(id: string): Promise<ChatbotRule | undefined> {
    const [row] = await db.select().from(chatbotRules).where(eq(chatbotRules.id, id)).limit(1);
    return row;
  },
  async create(tenantId: string, input: RuleInput): Promise<ChatbotRule> {
    const id = crypto.randomUUID();
    const [{ max }] = await db.select({ max: sql<number | null>`MAX(${chatbotRules.priority})` }).from(chatbotRules).where(eq(chatbotRules.userId, tenantId));
    await db.insert(chatbotRules).values({ id, userId: tenantId, priority: (Number(max ?? 0) || 0) + 1, ...toColumns(input) });
    return (await this.find(id))!;
  },
  async update(id: string, input: RuleInput): Promise<ChatbotRule | undefined> {
    await db.update(chatbotRules).set(toColumns(input)).where(eq(chatbotRules.id, id));
    return this.find(id);
  },
  async setEnabled(id: string, enabled: boolean) {
    await db.update(chatbotRules).set({ enabled }).where(eq(chatbotRules.id, id));
  },
  async delete(id: string) {
    await db.delete(chatbotRules).where(eq(chatbotRules.id, id));
  },
  /** Saves the order the tenant arranged the rules in (ids not theirs are ignored). */
  async reorder(tenantId: string, ids: string[]) {
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(chatbotRules).set({ priority: i + 1 }).where(and(eq(chatbotRules.id, id), eq(chatbotRules.userId, tenantId)));
    });
  },
  async markTriggered(id: string, at: Date) {
    await db.update(chatbotRules).set({ timesTriggered: sql`${chatbotRules.timesTriggered} + 1`, lastTriggeredAt: at }).where(eq(chatbotRules.id, id));
  },
  async logEvent(v: Omit<typeof chatbotEvents.$inferInsert, "id">) {
    await db.insert(chatbotEvents).values({ ...v, id: crypto.randomUUID(), detail: v.detail?.slice(0, 300) ?? null, incomingText: v.incomingText?.slice(0, 300) ?? null });
  },
  recentEvents(tenantId: string, limit = 50) {
    return db
      .select({
        id: chatbotEvents.id,
        conversationId: chatbotEvents.conversationId,
        ruleId: chatbotEvents.ruleId,
        ruleName: chatbotRules.name,
        contactName: conversations.contactName,
        channel: chatbotEvents.channel,
        outcome: chatbotEvents.outcome,
        detail: chatbotEvents.detail,
        incomingText: chatbotEvents.incomingText,
        createdAt: chatbotEvents.createdAt,
      })
      .from(chatbotEvents)
      .leftJoin(chatbotRules, eq(chatbotRules.id, chatbotEvents.ruleId))
      .leftJoin(conversations, eq(conversations.id, chatbotEvents.conversationId))
      .where(eq(chatbotEvents.userId, tenantId))
      .orderBy(desc(chatbotEvents.createdAt))
      .limit(limit);
  },
  /** Bot replies in a conversation since `since` (optionally by one rule). */
  async repliesSince(conversationId: string, since: Date, ruleId?: string): Promise<number> {
    const conds = [eq(chatbotEvents.conversationId, conversationId), inArray(chatbotEvents.outcome, ["replied", "handoff"]), gte(chatbotEvents.createdAt, since)];
    if (ruleId) conds.push(eq(chatbotEvents.ruleId, ruleId));
    const [{ n }] = await db.select({ n: count() }).from(chatbotEvents).where(and(...conds));
    return n;
  },
  async patchConversation(conversationId: string, patch: Partial<typeof conversations.$inferInsert>) {
    await db.update(conversations).set(patch).where(eq(conversations.id, conversationId));
  },
  async setPause(conversationId: string, until: Date | null) {
    await db.update(conversations).set({ botPausedUntil: until }).where(eq(conversations.id, conversationId));
  },
  /** Drops old activity (cron). */
  async prune(now = new Date()) {
    const [res] = await db.delete(chatbotEvents).where(lt(chatbotEvents.createdAt, new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000)));
    return res.affectedRows;
  },
};

function toColumns(input: RuleInput) {
  return {
    name: input.name,
    enabled: input.enabled,
    channels: input.channels,
    trigger: input.trigger as Record<string, unknown>,
    response: input.response as Record<string, unknown>,
    actions: input.actions as Record<string, unknown>,
    cooldownMinutes: input.cooldownMinutes,
  };
}

/** A stored rule, validated (rules that no longer parse are skipped rather than crashing the bot). */
export function parseRule(r: ChatbotRule): (RuleInput & { id: string; priority: number }) | null {
  const parsed = ruleSchema.safeParse({ ...r, actions: r.actions ?? {} });
  return parsed.success ? { ...parsed.data, id: r.id, priority: r.priority } : null;
}

export async function botTimezone(tenantId: string, s: BotSettings): Promise<string> {
  return s.timezone || (await tenantSettingsRepository.getSending(tenantId)).timezone || "UTC";
}

/** No hours set at all means "always open" (so the away rule never fires). */
export function outsideHours(s: BotSettings, at: Date, tz: string): boolean {
  const any = Object.values(s.hours).some((ranges) => (ranges ?? []).length > 0);
  return any && !isWithinHours(s.hours, at, tz);
}

/** Members a rule may assign to: the tenant admin and their team. */
export async function isTenantMember(tenantId: string, userId: string): Promise<boolean> {
  if (userId === tenantId) return true;
  const u = await usersRepository.findById(userId);
  return Boolean(u && u.role === "team" && u.createdBy === tenantId);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface IncomingEvent {
  tenantId: string | null | undefined;
  conversation: Conversation;
  channel: BotChannel;
  text: string;
  buttonId?: string | null;
  /** When the customer last wrote before this message (null: never). */
  previousInboundAt: Date | null;
  isNew: boolean;
  at: Date;
}

export interface Decision {
  outcome: Outcome;
  ruleId: string | null;
  reason: TriggerType | null;
  detail: string;
  /** What was (or would be) sent. */
  reply: string | null;
}

/** Runs the bot for one incoming message, in the background (never throws to the caller). */
export function runChatbot(ev: IncomingEvent): void {
  if (!ev.tenantId) return;
  handleIncoming(ev).catch((err) => log.error({ err: (err as Error).message, conversationId: ev.conversation.id }, "Chatbot failed"));
}

export async function handleIncoming(ev: IncomingEvent): Promise<Decision | null> {
  const tenantId = ev.tenantId;
  if (!tenantId) return null;
  const settings = await chatbotRepository.settings(tenantId);
  if (!settings.enabled) return null;
  const c = ev.conversation;
  const base = { userId: tenantId, conversationId: c.id, channel: ev.channel, incomingText: ev.text };
  const skip = async (detail: string, ruleId: string | null = null, reason: TriggerType | null = null): Promise<Decision> => {
    await chatbotRepository.logEvent({ ...base, ruleId, outcome: "skipped", detail });
    return { outcome: "skipped", ruleId, reason, detail, reply: null };
  };

  if (c.botPausedUntil && c.botPausedUntil.getTime() > ev.at.getTime()) return skip("Paused: a teammate is handling this chat");

  const rules = (await chatbotRepository.rules(tenantId)).map(parseRule).filter((r): r is NonNullable<typeof r> => r !== null);
  if (!rules.length) return null;
  const tz = await botTimezone(tenantId, settings);
  const firstMessage = ev.isNew || !ev.previousInboundAt || ev.at.getTime() - ev.previousInboundAt.getTime() > NEW_SESSION_MS;
  const picked = pickRule(rules, { channel: ev.channel, text: ev.text, buttonId: ev.buttonId, firstMessage, outsideHours: outsideHours(settings, ev.at, tz) });
  if (!picked) return skip("No rule matched");
  const { rule, reason } = picked;

  if (rule.cooldownMinutes > 0 && (await chatbotRepository.repliesSince(c.id, new Date(ev.at.getTime() - rule.cooldownMinutes * 60_000), rule.id)) > 0) {
    return skip(`Cooldown: “${rule.name}” already answered in the last ${rule.cooldownMinutes} min`, rule.id, reason);
  }
  if ((await chatbotRepository.repliesSince(c.id, new Date(ev.at.getTime() - LOOP_WINDOW_MS))) >= LOOP_LIMIT) {
    // Probably another bot on the other end: stop answering for a while.
    await chatbotRepository.setPause(c.id, new Date(ev.at.getTime() + settings.handoffHours * 3_600_000));
    return skip(`Loop guard: ${LOOP_LIMIT} bot replies in ${LOOP_WINDOW_MS / 60_000} minutes, bot paused`, rule.id, reason);
  }

  // The reply.
  let response: Exclude<BotResponse, { type: "ai" }>;
  let handoff = rule.actions.handoff;
  let note = "";
  if (rule.response.type === "ai") {
    const answer = await aiReply(tenantId, c, rule.response.knowledge);
    if (answer.reply) response = { type: "text", text: answer.reply };
    else {
      response = { type: "text", text: rule.response.unsureText };
      handoff = true;
      note = answer.error ? ` (AI unavailable: ${answer.error})` : " (AI couldn't answer, handed off)";
    }
  } else response = rule.response;

  let sent: Message | null = null;
  try {
    sent = await sendBotMessage(tenantId, c, ev.channel, response, rule.id);
  } catch (err) {
    const detail = `Send failed: ${(err as Error).message}`;
    await chatbotRepository.logEvent({ ...base, ruleId: rule.id, outcome: "failed", detail });
    return { outcome: "failed", ruleId: rule.id, reason, detail, reply: null };
  }

  await applyActions(tenantId, c, rule.actions, handoff, settings, ev.at);
  await chatbotRepository.markTriggered(rule.id, ev.at);
  const outcome: Outcome = handoff ? "handoff" : "replied";
  const detail = `${reason.replace("_", " ")}: “${rule.name}”${note}`;
  await chatbotRepository.logEvent({ ...base, ruleId: rule.id, outcome, detail });
  const fresh = await conversationsRepository.findById(c.id);
  realtime.toChannel(c.channelId, "conversation_updated", { conversation: fresh });
  log.info({ conversationId: c.id, ruleId: rule.id, outcome }, "Chatbot answered");
  return { outcome, ruleId: rule.id, reason, detail, reply: sent?.content ?? null };
}

async function aiReply(tenantId: string, c: Conversation, knowledge: string): Promise<{ reply: string | null; error?: string }> {
  try {
    const msgs = await messagesRepository.listForConversation(c.id, 20);
    const question = [...msgs].reverse().find((m) => m.direction === "inbound")?.content ?? "";
    return await botAnswer(tenantId, { transcript: transcript(msgs), question }, knowledge);
  } catch (err) {
    return { reply: null, error: (err as Error).message };
  }
}

const optionsOf = (r: Exclude<BotResponse, { type: "ai" }>) =>
  r.type === "buttons" ? r.buttons.map((b) => ({ id: b.id, title: b.title })) : r.type === "list" ? r.rows.map((x) => ({ id: x.id, title: x.title })) : [];

/** Sends one bot message on the conversation's channel and records it. */
export async function sendBotMessage(tenantId: string, c: Conversation, channel: BotChannel, r: Exclude<BotResponse, { type: "ai" }>, ruleId: string | null): Promise<Message> {
  const options = optionsOf(r);
  const meta = { bot: true, ruleId, ...(options.length ? { options } : {}) };

  if (channel === "messenger" || channel === "instagram") {
    const account = c.socialAccountId ? await socialAccountsRepository.find(c.socialAccountId) : undefined;
    if (!account || !account.enabled) throw new Error("The Messenger/Instagram account is disconnected");
    return sendSocialReply(account, c, { text: r.text, quickReplies: options }, { bot: { ruleId } });
  }

  const now = new Date();
  let message: Message;
  if (channel === "web") {
    // The website widget shows text only: options become a numbered list.
    const text = responseAsText(r);
    message = await messagesRepository.create({ conversationId: c.id, fromUser: false, direction: "outbound", content: text, type: "text", fromType: "bot", messageType: "text", status: "sent", timestamp: now, metadata: { ...meta, channel: "web", agentDisplayName: null } });
    await conversationsRepository.recordMessage(c.id, { text, at: now, inbound: false });
  } else {
    const ch = await channelsRepository.findById(c.channelId!);
    if (!ch) throw new Error("Channel not found");
    if (!c.contactPhone) throw new Error("Conversation has no phone number");
    await assertMessageQuota(tenantId, 1);
    const client = whatsappFactory.create(ch);
    const kind = r.type === "text" ? "text" : "interactive";
    const { messageId } =
      r.type === "text"
        ? await client.sendText(c.contactPhone, r.text)
        : r.type === "buttons"
          ? await client.sendInteractive(c.contactPhone, { kind: "buttons", text: r.text, buttons: r.buttons })
          : await client.sendInteractive(c.contactPhone, { kind: "list", text: r.text, button: r.button, rows: r.rows });
    message = await messagesRepository.create({ conversationId: c.id, whatsappMessageId: messageId, fromUser: false, direction: "outbound", content: r.text, type: kind, fromType: "bot", messageType: kind, status: "sent", timestamp: now, metadata: meta });
    await conversationsRepository.recordMessage(c.id, { text: r.text, at: now, inbound: false });
  }
  realtime.toChannel(c.channelId, "new_message", { conversationId: c.id, message });
  return message;
}

async function applyActions(tenantId: string, c: Conversation, actions: RuleInput["actions"], handoff: boolean, settings: BotSettings, at: Date) {
  const patch: Partial<typeof conversations.$inferInsert> = {};
  if (actions.addTags.length) {
    const tags = [...new Set([...(c.tags ?? []), ...actions.addTags])].slice(0, 50);
    if (tags.length !== (c.tags ?? []).length) patch.tags = tags;
  }
  if (actions.assignTo && actions.assignTo !== c.assignedTo && (await isTenantMember(tenantId, actions.assignTo))) {
    patch.assignedTo = actions.assignTo;
    realtime.toUser(actions.assignTo, "notification:new", { type: "assignment", title: `Chat with ${c.contactName ?? "a customer"} assigned to you by the chatbot`, body: "", conversationId: c.id });
  }
  if (handoff) patch.botPausedUntil = new Date(at.getTime() + settings.handoffHours * 3_600_000);
  if (Object.keys(patch).length) await chatbotRepository.patchConversation(c.id, patch);
}

/** A person replied: keep the bot quiet in this conversation for a while. */
export async function pauseAfterAgentReply(tenantId: string | null | undefined, conversationId: string, at = new Date()): Promise<void> {
  if (!tenantId) return;
  try {
    const s = await chatbotRepository.settings(tenantId);
    if (!s.enabled || s.pauseAfterAgentMinutes <= 0) return;
    const until = new Date(at.getTime() + s.pauseAfterAgentMinutes * 60_000);
    // Never shortens a longer pause (a hand-off).
    await db
      .update(conversations)
      .set({ botPausedUntil: until })
      .where(and(eq(conversations.id, conversationId), sql`(${conversations.botPausedUntil} IS NULL OR ${conversations.botPausedUntil} < ${until})`));
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Couldn't pause the chatbot");
  }
}

// ---------------------------------------------------------------------------
// Test console (dry run: nothing is sent or recorded)
// ---------------------------------------------------------------------------

export interface TestInput {
  channel: BotChannel;
  text: string;
  buttonId?: string;
  firstMessage: boolean;
  /** Pretend it's this moment (for business-hours checks). */
  at?: Date;
}

export async function testChatbot(tenantId: string, input: TestInput) {
  const settings = await chatbotRepository.settings(tenantId);
  const rules = (await chatbotRepository.rules(tenantId)).map(parseRule).filter((r): r is NonNullable<typeof r> => r !== null);
  const at = input.at ?? new Date();
  const tz = await botTimezone(tenantId, settings);
  const away = outsideHours(settings, at, tz);
  const picked = pickRule(rules, { channel: input.channel, text: input.text, buttonId: input.buttonId, firstMessage: input.firstMessage, outsideHours: away });
  const base = { botEnabled: settings.enabled, outsideHours: away, timezone: tz };
  if (!picked) return { ...base, matched: null };
  const { rule, reason } = picked;
  let reply: { text: string; options: { id: string; title: string }[] };
  let handoff = rule.actions.handoff;
  let ai: { simulated: boolean; answered: boolean; error?: string } | null = null;
  if (rule.response.type === "ai") {
    try {
      const r = await botAnswer(tenantId, { transcript: `Customer: ${input.text}`, question: input.text }, rule.response.knowledge);
      ai = { simulated: r.simulated, answered: Boolean(r.reply) };
      reply = { text: r.reply ?? rule.response.unsureText, options: [] };
      if (!r.reply) handoff = true;
    } catch (err) {
      ai = { simulated: false, answered: false, error: (err as Error).message };
      reply = { text: rule.response.unsureText, options: [] };
      handoff = true;
    }
  } else {
    reply = { text: input.channel === "web" ? responseAsText(rule.response) : rule.response.text, options: input.channel === "web" ? [] : optionsOf(rule.response) };
  }
  return { ...base, matched: { ruleId: rule.id, name: rule.name, reason, reply, handoff, addTags: rule.actions.addTags, assignTo: rule.actions.assignTo ?? null, ai } };
}

