/**
 * WhatsApp Embedded Signup and Coexistence.
 *
 * The browser opens Meta's popup (FB.login with the superadmin's configuration). Meta returns a
 * short-lived code (30 s) plus the WABA and phone number ids; the server exchanges the code for
 * the business's token, subscribes the app to the WABA and then either registers the number
 * (new Cloud API number) or, for a number that stays on the WhatsApp Business app (Coexistence),
 * asks Meta to sync its contacts and chat history, which arrive as webhooks.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { COEXISTENCE_SYNC_WINDOW_MS, type ChannelOnboarding, type CompleteSignupInput, type PublicSignupConfig } from "@shared/whatsapp-signup";
import { channels, conversations, webhookDedup, type Channel, type Conversation } from "@shared/schema";
import { config } from "../config";
import { db } from "../db";
import { decryptStoredSecret, encryptStoredSecret } from "../lib/crypto";
import { AppError, conflict, unprocessable } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { channelAccessToken, channelsRepository } from "../repositories/channels.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { pauseAfterAgentReply } from "./chatbot.service";
import { assertWithinPlan } from "../middlewares/subscription";
import { realtime } from "./realtime";
import { systemConfig } from "./system-config.service";
import { whatsappFactory } from "./whatsapp";
import { describe, type InboundMessage } from "./whatsapp/describe";

const log = childLogger("whatsapp-signup");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SignupSettings {
  enabled: boolean;
  appId: string;
  appSecret: string | null;
  configId: string;
  coexistence: boolean;
  /** Everything needed for the real popup is set. */
  configured: boolean;
}

export async function signupSettings(): Promise<SignupSettings> {
  const s = (await systemConfig.get()).extensionSettings?.whatsappSignup;
  const appSecret = s?.appSecret ? decryptStoredSecret(s.appSecret) : (config.WHATSAPP_APP_SECRET ?? null);
  const appId = s?.appId ?? "";
  const configId = s?.configId ?? "";
  return { enabled: Boolean(s?.enabled), appId, appSecret, configId, coexistence: s?.coexistence ?? true, configured: Boolean(s?.enabled && appId && configId && appSecret) };
}

/** Development servers without a Meta app get a simulated flow so the feature can be tried. */
export async function publicSignupConfig(): Promise<PublicSignupConfig> {
  const s = await signupSettings();
  const simulated = !s.configured && !config.isProduction;
  return { enabled: s.configured || simulated, appId: s.configured ? s.appId : null, configId: s.configured ? s.configId : null, graphVersion: config.WHATSAPP_API_VERSION, coexistence: s.configured ? s.coexistence : true, simulated };
}

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

export class MetaError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
  }
}

export const metaGraph = {
  async call<T>(method: "GET" | "POST", path: string, opts: { token?: string; query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${config.WHATSAPP_GRAPH_URL.replace(/\/$/, "")}/${config.WHATSAPP_API_VERSION}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(20_000) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number; error_user_msg?: string } };
    if (!res.ok || json.error) throw new MetaError(json.error?.error_user_msg ?? json.error?.message ?? `Meta returned ${res.status}`, json.error?.code);
    return json;
  },
};

interface PhoneInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  platform_type?: string;
  code_verification_status?: string;
}

// ---------------------------------------------------------------------------
// Completing the signup
// ---------------------------------------------------------------------------

export interface SignupResult {
  channel: Channel;
  created: boolean;
  /** Something that didn't stop the connection but needs attention. */
  warnings: string[];
  /** Two-step verification PIN set while registering a new number (shown once). */
  pin: string | null;
}

const randomPin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
const toE164 = (display: string | undefined, fallback: string) => (display ? `+${display.replace(/\D/g, "")}` : fallback);

/** Finishes Embedded Signup for the tenant: creates (or reconnects) the channel. */
export async function completeSignup(tenantId: string, input: CompleteSignupInput, now = new Date()): Promise<SignupResult> {
  const cfg = await publicSignupConfig();
  if (!cfg.enabled) throw unprocessable("Connecting with Facebook isn't set up on this platform yet.", "SIGNUP_DISABLED");
  if (cfg.simulated) return simulatedSignup(tenantId, input, now);
  const s = await signupSettings();
  const warnings: string[] = [];

  const existing = await channelsRepository.findByPhoneNumberId(input.phoneNumberId);
  if (existing && existing.createdBy !== tenantId) throw conflict("This WhatsApp number is already connected to another account.", "NUMBER_IN_USE");
  if (!existing) await assertWithinPlan(tenantId, "channel");

  let token: string;
  try {
    token = (await metaGraph.call<{ access_token: string }>("GET", "oauth/access_token", { query: { client_id: s.appId, client_secret: s.appSecret!, code: input.code } })).access_token;
  } catch (err) {
    throw new AppError(422, `Meta didn't accept the signup (${(err as Error).message}). The code is only valid for 30 seconds: please try again.`, "CODE_EXCHANGE_FAILED");
  }

  // The token only reaches assets the business shared, so these calls also prove ownership.
  const numbers = await metaGraph.call<{ data: PhoneInfo[] }>("GET", `${input.wabaId}/phone_numbers`, { token, query: { fields: "id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status" } }).catch((err: Error) => {
    throw new AppError(422, `Couldn't read the WhatsApp Business Account: ${err.message}`, "WABA_UNREADABLE");
  });
  const phone = numbers.data.find((p) => p.id === input.phoneNumberId);
  if (!phone) throw unprocessable("That phone number isn't in the WhatsApp Business Account you shared.", "PHONE_NOT_IN_WABA");

  await metaGraph.call("POST", `${input.wabaId}/subscribed_apps`, { token }).catch((err: Error) => warnings.push(`Webhooks couldn't be switched on for this account (${err.message}). Incoming messages may not arrive.`));

  let pin: string | null = null;
  const onboarding: ChannelOnboarding = { mode: input.mode, onboardedAt: now.toISOString(), businessId: input.businessId ?? null };
  if (input.mode === "cloud") {
    // A Coexistence number is already registered by the WhatsApp Business app: never register it.
    pin = randomPin();
    try {
      await metaGraph.call("POST", `${input.phoneNumberId}/register`, { token, body: { messaging_product: "whatsapp", pin } });
    } catch (err) {
      pin = null;
      warnings.push(`Meta couldn't register the number yet (${(err as Error).message}). If it already uses two-step verification, enter its PIN under Channel settings or contact support.`);
    }
  }

  const values = {
    name: (input.name || phone.verified_name || phone.display_phone_number || "WhatsApp").slice(0, 100),
    phoneNumberId: input.phoneNumberId,
    whatsappBusinessAccountId: input.wabaId,
    phoneNumber: toE164(phone.display_phone_number, ""),
    accessToken: token,
    appId: s.appId,
    connectionMethod: "embedded",
    isCoexistence: input.mode === "coexistence",
    businessId: input.businessId ?? null,
    twoStepPin: pin ? encryptStoredSecret(pin) : (existing?.twoStepPin ?? null),
    onboarding: onboarding as unknown as Record<string, unknown>,
    isActive: true,
  };
  let channel = existing ? (await channelsRepository.update(existing.id, values))! : await channelsRepository.create({ ...values, createdBy: tenantId });

  if (input.mode === "coexistence") {
    channel = await requestCoexistenceSync(channel, now);
    const o = channel.onboarding as unknown as ChannelOnboarding;
    for (const k of ["contacts", "history"] as const) if (o[k]?.error) warnings.push(`The ${k === "contacts" ? "contact" : "chat history"} sync couldn't start (${o[k]!.error}). Try “Sync again” within 24 hours.`);
  }
  const health = await whatsappFactory.create(channel).checkHealth().catch(() => null);
  if (health) await channelsRepository.recordHealth(channel.id, health.status, health.details);
  log.info({ tenantId, channelId: channel.id, mode: input.mode, reconnected: Boolean(existing) }, "WhatsApp number connected with Embedded Signup");
  return { channel: (await channelsRepository.findById(channel.id))!, created: !existing, warnings, pin };
}

/** Coexistence: asks Meta to send the app's contacts and chat history (allowed for 24 hours after onboarding). */
export async function requestCoexistenceSync(channel: Channel, now = new Date()): Promise<Channel> {
  const o = { ...((channel.onboarding ?? {}) as unknown as ChannelOnboarding) };
  if (!channel.isCoexistence) throw unprocessable("Only numbers connected from the WhatsApp Business app can sync.", "NOT_COEXISTENCE");
  if (o.onboardedAt && now.getTime() - Date.parse(o.onboardedAt) > COEXISTENCE_SYNC_WINDOW_MS) {
    throw unprocessable("Meta only allows syncing within 24 hours of connecting. Disconnect and connect the number again to sync.", "SYNC_WINDOW_CLOSED");
  }
  const at = now.toISOString();
  if (channel.connectionMethod === "simulator") {
    o.contacts = { requestedAt: at, requestId: `sim_${crypto.randomUUID().slice(0, 8)}`, imported: o.contacts?.imported ?? 0 };
    o.history = { requestedAt: at, requestId: `sim_${crypto.randomUUID().slice(0, 8)}`, imported: o.history?.imported ?? 0, phase: null, progress: 0 };
    const saved = (await channelsRepository.update(channel.id, { onboarding: o as unknown as Record<string, unknown> }))!;
    simulateCoexistenceWebhooks(saved);
    return saved;
  }
  const token = channelAccessToken(channel);
  for (const [key, syncType] of [["contacts", "smb_app_state_sync"], ["history", "history"]] as const) {
    try {
      const r = await metaGraph.call<{ request_id?: string }>("POST", `${channel.phoneNumberId}/smb_app_data`, { token, body: { messaging_product: "whatsapp", sync_type: syncType } });
      o[key] = { ...(o[key] ?? { imported: 0 }), requestedAt: at, requestId: r.request_id ?? null, error: null } as never;
    } catch (err) {
      o[key] = { ...(o[key] ?? { imported: 0 }), requestedAt: at, error: (err as Error).message } as never;
    }
  }
  return (await channelsRepository.update(channel.id, { onboarding: o as unknown as Record<string, unknown> }))!;
}

/** No Meta app on a development server: a simulator channel stands in for the connected number. */
async function simulatedSignup(tenantId: string, input: CompleteSignupInput, now: Date): Promise<SignupResult> {
  const existing = await channelsRepository.findByPhoneNumberId(input.phoneNumberId);
  if (existing && existing.createdBy !== tenantId) throw conflict("This WhatsApp number is already connected to another account.", "NUMBER_IN_USE");
  if (!existing) await assertWithinPlan(tenantId, "channel");
  const onboarding: ChannelOnboarding = { mode: input.mode, onboardedAt: now.toISOString(), businessId: input.businessId ?? null };
  const pin = input.mode === "cloud" ? randomPin() : null;
  const values = {
    name: input.name || (input.mode === "coexistence" ? "WhatsApp Business app (test)" : "WhatsApp (test signup)"),
    phoneNumberId: input.phoneNumberId,
    whatsappBusinessAccountId: input.wabaId,
    phoneNumber: `+1555${input.phoneNumberId.slice(-7)}`,
    accessToken: "simulator",
    connectionMethod: "simulator",
    isCoexistence: input.mode === "coexistence",
    businessId: input.businessId ?? null,
    twoStepPin: pin ? encryptStoredSecret(pin) : null,
    onboarding: onboarding as unknown as Record<string, unknown>,
    isActive: true,
  };
  let channel = existing ? (await channelsRepository.update(existing.id, values))! : await channelsRepository.create({ ...values, createdBy: tenantId });
  if (input.mode === "coexistence") channel = await requestCoexistenceSync(channel, now);
  const health = await whatsappFactory.create(channel).checkHealth();
  await channelsRepository.recordHealth(channel.id, health.status, health.details);
  return { channel: (await channelsRepository.findById(channel.id))!, created: !existing, warnings: ["Test mode: no Meta app is configured, so this is a simulated number."], pin };
}

// ---------------------------------------------------------------------------
// Coexistence webhooks
// ---------------------------------------------------------------------------

const digits = (s: string | undefined | null) => (s ?? "").replace(/\D/g, "");

async function contactAndConversation(channel: Channel, waId: string, name: string | null, at: Date): Promise<{ conversation: Conversation; contactId: string }> {
  const phone = `+${digits(waId)}`;
  let contact = await contactsRepository.findByPhone(channel.id, phone);
  if (!contact) contact = await contactsRepository.create({ channelId: channel.id, tenantId: channel.createdBy, name: name || phone, phone, source: "whatsapp_app", lastContact: at });
  let conversation = await conversationsRepository.findByChannelAndPhone(channel.id, phone);
  if (!conversation) {
    conversation = await conversationsRepository.create({ channelId: channel.id, contactId: contact.id, contactPhone: phone, contactName: contact.name, status: "open", unreadCount: 0 });
    realtime.toChannel(channel.id, "conversation_created", { conversation });
  }
  return { conversation, contactId: contact.id };
}

/** Records a message once (by WhatsApp id). Returns false for duplicates. */
async function firstTime(wamid: string): Promise<boolean> {
  const [res] = await db.insert(webhookDedup).ignore().values({ wamid: wamid.slice(0, 255) });
  return res.affectedRows === 1;
}

/** Moves the conversation's "last message" forward only (history arrives out of order). */
async function touchConversation(c: Conversation, text: string, at: Date, inbound: boolean) {
  const patch: Partial<typeof conversations.$inferInsert> = {};
  if (!c.lastMessageAt || c.lastMessageAt < at) Object.assign(patch, { lastMessageAt: at, lastMessageText: text.slice(0, 500) });
  if (inbound && (!c.lastIncomingMessageAt || c.lastIncomingMessageAt < at)) patch.lastIncomingMessageAt = at;
  if (Object.keys(patch).length) await db.update(conversations).set(patch).where(eq(conversations.id, c.id));
}

async function updateOnboarding(channelId: string, fn: (o: ChannelOnboarding) => ChannelOnboarding) {
  const ch = await channelsRepository.findById(channelId);
  if (!ch) return;
  const next = fn({ ...((ch.onboarding ?? { mode: "coexistence", onboardedAt: new Date().toISOString() }) as unknown as ChannelOnboarding) });
  await db.update(channels).set({ onboarding: next as unknown as Record<string, unknown> }).where(eq(channels.id, channelId));
  realtime.toChannel(channelId, "channel_updated", { channelId });
}

interface HistoryChunk {
  metadata?: { phase?: number; chunk_order?: number; progress?: number };
  threads?: { id: string; messages?: (InboundMessage & { history_context?: { status?: string } })[] }[];
  errors?: { code?: number; title?: string; message?: string }[];
}

/** `history` webhook: past chats from the WhatsApp Business app (no automations or chatbot run). */
export async function handleHistory(channel: Channel, value: { history?: HistoryChunk[] }): Promise<number> {
  const business = digits(channel.phoneNumber);
  let imported = 0;
  let last: HistoryChunk["metadata"] | undefined;
  let declined = false;
  for (const chunk of value.history ?? []) {
    if (chunk.errors?.length) declined = true;
    last = chunk.metadata ?? last;
    for (const thread of chunk.threads ?? []) {
      for (const m of thread.messages ?? []) {
        if (!m.id || !(await firstTime(m.id))) continue;
        const at = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
        const inbound = digits(m.from) !== business && digits(m.from) === digits(thread.id);
        const { conversation } = await contactAndConversation(channel, thread.id, null, at);
        const { content, media } = describe(m);
        await messagesRepository.create({
          conversationId: conversation.id,
          whatsappMessageId: m.id,
          fromUser: inbound,
          direction: inbound ? "inbound" : "outbound",
          content,
          type: m.type,
          fromType: inbound ? "contact" : "agent",
          messageType: m.type,
          mediaId: media?.id ?? null,
          mediaMimeType: media?.mime ?? null,
          status: (m.history_context?.status ?? (inbound ? "received" : "sent")).toLowerCase(),
          timestamp: at,
          metadata: { source: "history" },
        });
        await touchConversation(conversation, content, at, inbound);
        imported++;
      }
    }
  }
  await updateOnboarding(channel.id, (o) => ({
    ...o,
    history: { requestedAt: o.history?.requestedAt ?? new Date().toISOString(), requestId: o.history?.requestId ?? null, imported: (o.history?.imported ?? 0) + imported, phase: last?.phase ?? o.history?.phase ?? null, progress: last?.progress ?? o.history?.progress ?? null, ...(declined ? { declined: true } : {}) },
  }));
  return imported;
}

interface StateSync {
  type?: string;
  action?: string;
  contact?: { full_name?: string; first_name?: string; phone_number?: string };
}

/** `smb_app_state_sync` webhook: the app's contacts (added or renamed). They don't start automations. */
export async function handleStateSync(channel: Channel, value: { state_sync?: StateSync[] }): Promise<number> {
  let n = 0;
  for (const s of value.state_sync ?? []) {
    if (s.type !== "contact" || !s.contact?.phone_number || s.action === "remove") continue;
    const phone = `+${digits(s.contact.phone_number)}`;
    if (phone.length < 6) continue;
    const name = (s.contact.full_name || s.contact.first_name || "").trim();
    const existing = await contactsRepository.findByPhone(channel.id, phone);
    if (!existing) {
      await contactsRepository.create({ channelId: channel.id, tenantId: channel.createdBy, name: name || phone, phone, source: "whatsapp_app" });
      n++;
    } else if (name && (existing.name === existing.phone || !existing.name)) {
      await contactsRepository.update(existing.id, { name });
    }
  }
  await updateOnboarding(channel.id, (o) => ({ ...o, contacts: { requestedAt: o.contacts?.requestedAt ?? new Date().toISOString(), requestId: o.contacts?.requestId ?? null, imported: (o.contacts?.imported ?? 0) + n } }));
  return n;
}

interface Echo extends InboundMessage {
  to: string;
}

/** `smb_message_echoes` webhook: a reply typed in the WhatsApp Business app. It shows in the inbox and pauses the chatbot. */
export async function handleEchoes(channel: Channel, value: { message_echoes?: Echo[] }): Promise<number> {
  let n = 0;
  for (const m of value.message_echoes ?? []) {
    if (!m.id || !m.to || !(await firstTime(m.id))) continue;
    const at = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
    const { conversation } = await contactAndConversation(channel, m.to, null, at);
    const { content, media } = describe(m);
    const message = await messagesRepository.create({
      conversationId: conversation.id,
      whatsappMessageId: m.id,
      fromUser: false,
      direction: "outbound",
      content,
      type: m.type,
      fromType: "agent",
      messageType: m.type,
      mediaId: media?.id ?? null,
      mediaMimeType: media?.mime ?? null,
      status: "sent",
      timestamp: at,
      metadata: { source: "business_app", sentByName: "WhatsApp Business app" },
    });
    await conversationsRepository.recordMessage(conversation.id, { text: content, at, inbound: false });
    await pauseAfterAgentReply(channel.createdBy, conversation.id, at);
    const fresh = await conversationsRepository.findById(conversation.id);
    realtime.toChannel(channel.id, "new_message", { conversationId: conversation.id, message });
    realtime.toChannel(channel.id, "conversation_updated", { conversation: fresh });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

/** Plays back Meta's contact and history webhooks for a simulated Coexistence number. */
function simulateCoexistenceWebhooks(channel: Channel) {
  const business = digits(channel.phoneNumber);
  const meta = { display_phone_number: business, phone_number_id: channel.phoneNumberId };
  const people = [
    { name: "Meera Kapoor", wa: `91981${business.slice(-7)}` },
    { name: "Arjun Rao", wa: `91982${business.slice(-7)}` },
  ];
  const ts = (minsAgo: number) => String(Math.floor(Date.now() / 1000) - minsAgo * 60);
  const payload = (field: string, value: Record<string, unknown>) => ({ object: "whatsapp_business_account", entry: [{ id: channel.whatsappBusinessAccountId, changes: [{ field, value: { messaging_product: "whatsapp", metadata: meta, ...value } }] }] });
  const contacts = payload("smb_app_state_sync", { state_sync: people.map((p) => ({ type: "contact", action: "add", contact: { full_name: p.name, first_name: p.name.split(" ")[0], phone_number: p.wa }, metadata: { timestamp: ts(0) } })) });
  const history = payload("history", {
    history: [
      {
        metadata: { phase: 0, chunk_order: 1, progress: 100 },
        threads: people.map((p, i) => ({
          id: p.wa,
          messages: [
            { from: p.wa, id: `wamid.SIM.HIST.${channel.id.slice(0, 8)}.${i}.1`, timestamp: ts(120 - i), type: "text", text: { body: i ? "Is the blue kurta back in stock?" : "Hi! Can I book a table for Friday?" }, history_context: { status: "READ" } },
            { from: business, id: `wamid.SIM.HIST.${channel.id.slice(0, 8)}.${i}.2`, timestamp: ts(110 - i), type: "text", text: { body: i ? "Yes, all sizes are back." : "Of course, for how many people?" }, history_context: { status: "DELIVERED" } },
          ],
        })),
      },
    ],
  });
  void import("./whatsapp/simulator-client").then(({ emitSimulated }) => {
    emitSimulated(800, contacts);
    emitSimulated(1500, history);
  });
}
