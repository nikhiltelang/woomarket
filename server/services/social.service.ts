/**
 * Facebook Messenger and Instagram Direct through a connected Facebook Page.
 *
 * Webhooks arrive on the same Meta callback as WhatsApp (object "page" or "instagram"),
 * conversations land in the tenant's inbox (type "messenger" / "instagram"), and agents reply
 * through the Page's Send API within Meta's 24-hour window (7 days with the Human Agent tag).
 */
import crypto from "node:crypto";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { HUMAN_AGENT_WINDOW_MS, SOCIAL_LABELS, SOCIAL_WINDOW_MS, type PublicSocialAccount, type SocialPlatform } from "@shared/social";
import { conversations, messages, socialAccounts, webhookDedup, type Conversation, type Message, type SocialAccount } from "@shared/schema";
import { db } from "../db";
import { config } from "../config";
import { decryptStoredSecret, encryptStoredSecret } from "../lib/crypto";
import { AppError, unprocessable } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { realtime } from "./realtime";
import { emit } from "./webhooks.service";

const log = childLogger("social");

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

export class GraphError extends Error {
  constructor(
    message: string,
    public code?: number,
    public subcode?: number,
  ) {
    super(message);
  }
}

const graphUrl = (path: string) => `${config.WHATSAPP_GRAPH_URL.replace(/\/$/, "")}/${config.WHATSAPP_API_VERSION}/${path.replace(/^\//, "")}`;

/** Overridable in tests. */
export const graph = {
  async call<T>(method: "GET" | "POST", path: string, token: string, body?: unknown): Promise<T> {
    const url = new URL(graphUrl(path));
    url.searchParams.set("access_token", token);
    const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number; error_subcode?: number } };
    if (!res.ok || json.error) throw new GraphError(json.error?.message ?? `Meta returned ${res.status}`, json.error?.code, json.error?.error_subcode);
    return json;
  },
};

const isSimulatedToken = (t: string) => t === "simulator" || config.WHATSAPP_SIMULATE;

interface PageInfo {
  id: string;
  name: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
}

/** Looks up the Page (and its Instagram account) with the token. */
export async function fetchPage(pageId: string, token: string): Promise<PageInfo> {
  if (isSimulatedToken(token)) return { id: pageId, name: `Test Page ${pageId.slice(-4)}`, instagram_business_account: { id: `17${pageId.slice(-12).padStart(12, "0")}`, username: `testshop${pageId.slice(-4)}` } };
  return graph.call<PageInfo>("GET", `${pageId}?fields=id,name,picture{url},instagram_business_account{id,username,profile_picture_url}`, token);
}

/** Subscribes the Page to this app's webhooks (needed before Meta sends anything). */
export async function subscribePage(pageId: string, token: string): Promise<void> {
  if (isSimulatedToken(token)) return;
  await graph.call("POST", `${pageId}/subscribed_apps?subscribed_fields=messages,message_echoes,message_deliveries,message_reads,messaging_postbacks`, token);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const socialAccountsRepository = {
  list(userId: string) {
    return db.select().from(socialAccounts).where(eq(socialAccounts.userId, userId)).orderBy(desc(socialAccounts.createdAt));
  },
  async find(id: string): Promise<SocialAccount | undefined> {
    const [row] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, id)).limit(1);
    return row;
  },
  async byExternal(platform: SocialPlatform, externalId: string): Promise<SocialAccount | undefined> {
    const [row] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.platform, platform), eq(socialAccounts.externalId, externalId))).limit(1);
    return row;
  },
  async upsert(v: Omit<typeof socialAccounts.$inferInsert, "id">): Promise<SocialAccount> {
    const existing = await this.byExternal(v.platform as SocialPlatform, v.externalId);
    if (existing) {
      await db.update(socialAccounts).set(v).where(eq(socialAccounts.id, existing.id));
      return (await this.find(existing.id))!;
    }
    const id = crypto.randomUUID();
    await db.insert(socialAccounts).values({ ...v, id });
    return (await this.find(id))!;
  },
  async update(id: string, patch: Partial<typeof socialAccounts.$inferInsert>) {
    await db.update(socialAccounts).set(patch).where(eq(socialAccounts.id, id));
    return this.find(id);
  },
  async delete(id: string) {
    await db.delete(socialAccounts).where(eq(socialAccounts.id, id));
  },
};

export function publicAccount(a: SocialAccount): PublicSocialAccount {
  return {
    id: a.id,
    platform: a.platform as SocialPlatform,
    channelId: a.channelId,
    pageId: a.pageId,
    externalId: a.externalId,
    name: a.name,
    username: a.username,
    pictureUrl: a.pictureUrl,
    simulated: a.simulated,
    humanAgentTag: a.humanAgentTag,
    enabled: a.enabled,
    status: a.status,
    lastError: a.lastError,
    connectedAt: a.connectedAt?.toISOString() ?? null,
  };
}

/** Verifies the token, subscribes the Page and saves a Messenger and/or Instagram account. */
export async function connectPage(tenantId: string, input: { channelId: string; pageId: string; accessToken: string; messenger: boolean; instagram: boolean; humanAgentTag: boolean }) {
  let page: PageInfo;
  try {
    page = await fetchPage(input.pageId, input.accessToken);
    await subscribePage(input.pageId, input.accessToken);
  } catch (err) {
    throw unprocessable(`Meta didn't accept the Page or token: ${(err as Error).message}`, "META_REJECTED");
  }
  const simulated = isSimulatedToken(input.accessToken);
  const common = { userId: tenantId, channelId: input.channelId, pageId: page.id, accessToken: encryptStoredSecret(input.accessToken), simulated, humanAgentTag: input.humanAgentTag, enabled: true, status: "connected", lastError: null, connectedAt: new Date() };
  const saved: SocialAccount[] = [];
  for (const platform of ["messenger", "instagram"] as const) {
    if (!input[platform]) continue;
    const externalId = platform === "messenger" ? page.id : page.instagram_business_account?.id;
    if (!externalId) {
      if (input.messenger) continue;
      throw unprocessable("This Page has no Instagram professional account linked. Link one in Meta Business Suite, then connect again.", "NO_INSTAGRAM");
    }
    const owner = await socialAccountsRepository.byExternal(platform, externalId);
    if (owner && owner.userId !== tenantId) throw unprocessable(`This ${SOCIAL_LABELS[platform]} account is already connected to another workspace.`, "ALREADY_CONNECTED");
    saved.push(
      await socialAccountsRepository.upsert({
        ...common,
        platform,
        externalId,
        name: platform === "messenger" ? page.name : (page.instagram_business_account?.username ? `@${page.instagram_business_account.username}` : page.name),
        username: platform === "instagram" ? (page.instagram_business_account?.username ?? null) : null,
        pictureUrl: platform === "messenger" ? (page.picture?.data?.url ?? null) : (page.instagram_business_account?.profile_picture_url ?? null),
      }),
    );
  }
  if (!saved.length) throw unprocessable("Choose Messenger, Instagram or both.");
  return saved;
}

const tokenOf = (a: SocialAccount) => decryptStoredSecret(a.accessToken);

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: { mid: string; text?: string; is_echo?: boolean; attachments?: { type: string; payload?: { url?: string } }[]; reply_to?: { mid?: string } };
  postback?: { mid?: string; title?: string; payload?: string };
  delivery?: { mids?: string[]; watermark?: number };
  read?: { watermark?: number; mid?: string };
}

/** Best-effort profile name (Meta only shares it with the right permissions). */
async function profileName(a: SocialAccount, userId: string): Promise<string | null> {
  if (a.simulated) return `${a.platform === "instagram" ? "IG" : "FB"} user ${userId.slice(-4)}`;
  try {
    if (a.platform === "messenger") {
      const p = await graph.call<{ first_name?: string; last_name?: string; name?: string }>("GET", `${userId}?fields=first_name,last_name,name`, tokenOf(a));
      return p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null);
    }
    const p = await graph.call<{ name?: string; username?: string }>("GET", `${userId}?fields=name,username`, tokenOf(a));
    return p.name || (p.username ? `@${p.username}` : null);
  } catch (err) {
    log.debug({ err: (err as Error).message }, "Profile lookup failed");
    return null;
  }
}

async function conversationFor(a: SocialAccount, userId: string, at: Date): Promise<{ conversation: Conversation; created: boolean }> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.socialAccountId, a.id), eq(conversations.sessionId, userId)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (existing) return { conversation: existing, created: false };
  const conversation = await conversationsRepository.create({
    channelId: a.channelId,
    contactId: null,
    contactPhone: null,
    contactName: (await profileName(a, userId)) ?? `${SOCIAL_LABELS[a.platform as SocialPlatform]} user ${userId.slice(-4)}`,
    type: a.platform,
    sessionId: userId,
    socialAccountId: a.id,
    status: "open",
    unreadCount: 0,
    lastMessageAt: at,
  });
  return { conversation, created: true };
}

function describeMessage(m: NonNullable<MessagingEvent["message"]>): { content: string; type: string; mediaUrl: string | null } {
  if (m.text) return { content: m.text, type: "text", mediaUrl: null };
  const att = m.attachments?.[0];
  if (att) return { content: `[${att.type}]`, type: ["image", "video", "audio", "file"].includes(att.type) ? att.type : "text", mediaUrl: att.payload?.url ?? null };
  return { content: "[message]", type: "text", mediaUrl: null };
}

async function handleMessage(a: SocialAccount, ev: MessagingEvent) {
  const m = ev.message ?? (ev.postback ? { mid: ev.postback.mid ?? `pb_${crypto.randomUUID()}`, text: ev.postback.title ?? ev.postback.payload } : null);
  if (!m?.mid) return;
  const [dedup] = await db.insert(webhookDedup).ignore().values({ wamid: m.mid.slice(0, 255) });
  if (dedup.affectedRows === 0) return;
  const echo = Boolean(ev.message?.is_echo);
  // Echoes are the Page's own messages; our sends are already recorded (the dedup above caught them).
  const customerId = echo ? ev.recipient?.id : ev.sender?.id;
  if (!customerId) return;
  const at = ev.timestamp ? new Date(ev.timestamp) : new Date();
  const { conversation, created } = await conversationFor(a, customerId, at);
  const { content, type, mediaUrl } = describeMessage(m);
  const message = await messagesRepository.create({
    conversationId: conversation.id,
    whatsappMessageId: m.mid,
    fromUser: !echo,
    direction: echo ? "outbound" : "inbound",
    content,
    type,
    fromType: echo ? "agent" : "contact",
    messageType: type,
    mediaUrl,
    status: echo ? "sent" : "received",
    timestamp: at,
    metadata: { platform: a.platform, ...(echo ? { source: "meta_inbox" } : {}), ...(ev.postback ? { postback: ev.postback.payload ?? null } : {}) },
  });
  await conversationsRepository.recordMessage(conversation.id, { text: content, at, inbound: !echo });
  const fresh = await conversationsRepository.findById(conversation.id);
  if (created) realtime.toChannel(a.channelId, "conversation_created", { conversation: fresh });
  realtime.toChannel(a.channelId, "new_message", { conversationId: conversation.id, message });
  realtime.toChannel(a.channelId, "conversation_updated", { conversation: fresh });
  if (!echo) {
    if (fresh?.assignedTo) realtime.toUser(fresh.assignedTo, "notification:new", { type: "message", title: `New ${SOCIAL_LABELS[a.platform as SocialPlatform]} message from ${fresh.contactName}`, body: content.slice(0, 120), conversationId: conversation.id });
    emit(a.userId, "message.received", { messageId: m.mid, channel: a.platform, channelId: a.channelId, conversationId: conversation.id, contact: { id: null, name: fresh?.contactName ?? null, platformUserId: customerId }, type, text: content, account: { id: a.id, name: a.name }, receivedAt: at.toISOString() });
  }
}

/** Delivery and read receipts: everything we sent up to the watermark (or the given mid). */
async function handleReceipt(a: SocialAccount, ev: MessagingEvent) {
  const customerId = ev.sender?.id;
  if (!customerId) return;
  const [conv] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.socialAccountId, a.id), eq(conversations.sessionId, customerId))).limit(1);
  if (!conv) return;
  const now = new Date();
  const read = Boolean(ev.read);
  const until = ev.read?.watermark ?? ev.delivery?.watermark;
  const conds = [eq(messages.conversationId, conv.id), eq(messages.direction, "outbound"), inArray(messages.status, read ? ["sent", "delivered"] : ["sent"])];
  if (ev.read?.mid) conds.push(eq(messages.whatsappMessageId, ev.read.mid));
  else if (ev.delivery?.mids?.length) conds.push(inArray(messages.whatsappMessageId, ev.delivery.mids));
  else if (until) conds.push(lte(messages.createdAt, new Date(until)));
  await db
    .update(messages)
    .set(read ? { status: "read", readAt: now } : { status: "delivered", deliveredAt: now })
    .where(and(...conds));
  realtime.toChannel(a.channelId, read ? "messages_read" : "messages_delivered", { conversationId: conv.id });
}

/** Handles a Meta webhook payload with object "page" (Messenger) or "instagram". */
export async function processSocialPayload(payload: { object?: string; entry?: { id: string; messaging?: MessagingEvent[] }[] }): Promise<void> {
  const platform: SocialPlatform | null = payload.object === "page" ? "messenger" : payload.object === "instagram" ? "instagram" : null;
  if (!platform) return;
  for (const entry of payload.entry ?? []) {
    const a = await socialAccountsRepository.byExternal(platform, String(entry.id));
    if (!a || !a.enabled) {
      log.debug({ platform, id: entry.id }, "Webhook for an unknown or disabled account ignored");
      continue;
    }
    for (const ev of entry.messaging ?? []) {
      try {
        if (ev.message || ev.postback) await handleMessage(a, ev);
        else if (ev.delivery || ev.read) await handleReceipt(a, ev);
      } catch (err) {
        log.error({ err: (err as Error).message, platform }, "Social webhook event failed");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/** Which kind of send Meta allows now: a normal reply, a Human Agent tagged one, or none. */
export function replyPolicy(c: Pick<Conversation, "lastIncomingMessageAt">, humanAgentTag: boolean, now = Date.now()): "response" | "human_agent" | "closed" {
  const last = c.lastIncomingMessageAt?.getTime();
  if (!last) return "closed";
  if (now - last < SOCIAL_WINDOW_MS) return "response";
  if (humanAgentTag && now - last < HUMAN_AGENT_WINDOW_MS) return "human_agent";
  return "closed";
}

export type SocialContent = { text: string } | { imageUrl: string };

export async function sendSocialReply(a: SocialAccount, c: Conversation, content: SocialContent, sender: { id: string; username: string }): Promise<Message> {
  const image = "imageUrl" in content ? content.imageUrl : null;
  const text = image ? "[image]" : (content as { text: string }).text;
  const kind = image ? "image" : "text";
  const policy = replyPolicy(c, a.humanAgentTag);
  if (policy === "closed") {
    throw new AppError(422, `${SOCIAL_LABELS[a.platform as SocialPlatform]} only allows replies within 24 hours of the customer's last message${a.humanAgentTag ? " (7 days with the Human Agent tag)" : ""}. Wait for them to write again.`, "WINDOW_CLOSED");
  }
  const now = new Date();
  let mid: string;
  try {
    if (a.simulated) mid = `m_sim_${crypto.randomUUID()}`;
    else {
      const message = image ? { attachment: { type: "image", payload: { url: image, is_reusable: false } } } : { text };
      const body = { recipient: { id: c.sessionId }, messaging_type: policy === "human_agent" ? "MESSAGE_TAG" : "RESPONSE", ...(policy === "human_agent" ? { tag: "HUMAN_AGENT" } : {}), message };
      mid = (await graph.call<{ message_id: string }>("POST", `${a.pageId}/messages`, tokenOf(a), body)).message_id;
    }
  } catch (err) {
    const reason = (err as Error).message;
    if (err instanceof GraphError && (err.code === 190 || err.code === 10)) await socialAccountsRepository.update(a.id, { status: "error", lastError: reason.slice(0, 500) });
    const failed = await messagesRepository.create({ conversationId: c.id, fromUser: false, direction: "outbound", content: text, type: kind, fromType: "agent", messageType: kind, mediaUrl: image, status: "failed", timestamp: now, errorMessage: reason, metadata: { sentBy: sender.id, sentByName: sender.username, platform: a.platform } });
    realtime.toChannel(c.channelId, "new_message", { conversationId: c.id, message: failed });
    throw new AppError(502, `${SOCIAL_LABELS[a.platform as SocialPlatform]} rejected the message: ${reason}`, "SEND_FAILED");
  }
  // Meta echoes our own sends back; recording the id first makes the echo a no-op.
  await db.insert(webhookDedup).ignore().values({ wamid: mid.slice(0, 255) });
  const message = await messagesRepository.create({
    conversationId: c.id,
    whatsappMessageId: mid,
    fromUser: false,
    direction: "outbound",
    content: text,
    type: kind,
    fromType: "agent",
    messageType: kind,
    mediaUrl: image,
    status: "sent",
    timestamp: now,
    metadata: { sentBy: sender.id, sentByName: sender.username, platform: a.platform, ...(policy === "human_agent" ? { tag: "HUMAN_AGENT" } : {}) },
  });
  await conversationsRepository.recordMessage(c.id, { text, at: now, inbound: false });
  const fresh = await conversationsRepository.findById(c.id);
  realtime.toChannel(c.channelId, "new_message", { conversationId: c.id, message });
  realtime.toChannel(c.channelId, "conversation_updated", { conversation: fresh });
  return message;
}

/** Simulator: feeds a fake incoming message through the real webhook handler. */
export async function simulateInbound(a: SocialAccount, input: { text: string; senderId?: string }) {
  const senderId = input.senderId ?? String(crypto.randomInt(10_000_000, 99_999_999)) + String(crypto.randomInt(10_000_000, 99_999_999));
  await processSocialPayload({
    object: a.platform === "messenger" ? "page" : "instagram",
    entry: [{ id: a.externalId, messaging: [{ sender: { id: senderId }, recipient: { id: a.externalId }, timestamp: Date.now(), message: { mid: `m_sim_in_${crypto.randomUUID()}`, text: input.text } }] }],
  });
  return { senderId };
}
