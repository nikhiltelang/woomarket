/**
 * Website chat widget: visitors start chats from a customer's website; the conversations land
 * in the shared inbox (type "web") and agents reply from there.
 */
import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { widgetSettingsSchema, whatsappLink, type PublicWidgetConfig, type VisitorMessage, type WidgetSettings } from "@shared/widget";
import { chatWidgets, messages, type ChatWidget, type Conversation, type Message } from "@shared/schema";
import { db } from "../db";
import { signToken, verifyToken } from "../lib/tokens";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { realtime } from "./realtime";
import { emit } from "./webhooks.service";
import { contactData } from "./webhook-events";

/** "+91 98123-45678" → "+919812345678" (the contact list's format). */
const normalizePhone = (p: string) => `+${p.replace(/\D/g, "")}`;

export const widgetsRepository = {
  list(userId: string) {
    return db.select().from(chatWidgets).where(eq(chatWidgets.userId, userId)).orderBy(desc(chatWidgets.createdAt));
  },
  async find(id: string): Promise<ChatWidget | undefined> {
    const [row] = await db.select().from(chatWidgets).where(eq(chatWidgets.id, id)).limit(1);
    return row;
  },
  async create(values: Omit<typeof chatWidgets.$inferInsert, "id">) {
    const id = crypto.randomUUID();
    await db.insert(chatWidgets).values({ ...values, id });
    return (await this.find(id))!;
  },
  async update(id: string, patch: Partial<typeof chatWidgets.$inferInsert>) {
    await db.update(chatWidgets).set(patch).where(eq(chatWidgets.id, id));
    return this.find(id);
  },
  async delete(id: string) {
    await db.delete(chatWidgets).where(eq(chatWidgets.id, id));
  },
};

export function widgetSettings(w: ChatWidget): WidgetSettings {
  const parsed = widgetSettingsSchema.safeParse(w.settings ?? {});
  return parsed.success ? parsed.data : widgetSettingsSchema.parse({});
}

export async function publicConfig(w: ChatWidget): Promise<PublicWidgetConfig> {
  const settings = widgetSettings(w);
  let phone = settings.whatsapp.phone;
  if (settings.whatsapp.enabled && !phone) phone = (await channelsRepository.findById(w.channelId))?.phoneNumber ?? "";
  return {
    id: w.id,
    settings: { ...settings, whatsapp: { ...settings.whatsapp, phone: "" } },
    liveChat: settings.liveChat.enabled,
    whatsappUrl: settings.whatsapp.enabled && phone ? whatsappLink(phone, settings.whatsapp.prefill) : null,
  };
}

/** Token the visitor's browser keeps for its chat: "<widgetId>:<conversationId>" signed. */
export const visitorToken = (widgetId: string, conversationId: string) => signToken("widget", `${widgetId}:${conversationId}`);

export async function conversationForToken(widget: ChatWidget, token: string | undefined): Promise<Conversation | null> {
  if (!token) return null;
  const payload = verifyToken("widget", token);
  if (!payload) return null;
  const [widgetId, conversationId] = payload.split(":");
  if (widgetId !== widget.id) return null;
  const c = await conversationsRepository.findById(conversationId);
  return c && c.type === "web" && c.channelId === widget.channelId ? c : null;
}

function toVisitor(m: Message): VisitorMessage {
  const meta = (m.metadata ?? {}) as { sentByName?: string; agentDisplayName?: string };
  return { id: m.id, from: m.direction === "inbound" ? "visitor" : "agent", text: m.content, at: (m.createdAt ?? new Date()).toISOString(), ...(m.direction === "outbound" ? { agentName: meta.agentDisplayName ?? null } : {}) };
}

async function recordInbound(widget: ChatWidget, c: Conversation, text: string, extra: Record<string, unknown> = {}) {
  const at = new Date();
  const message = await messagesRepository.create({
    conversationId: c.id,
    fromUser: true,
    direction: "inbound",
    content: text,
    type: "text",
    fromType: "contact",
    messageType: "text",
    status: "received",
    timestamp: at,
    metadata: { source: "widget", widgetId: widget.id, ...extra },
  });
  await conversationsRepository.recordMessage(c.id, { text, at, inbound: true });
  const fresh = await conversationsRepository.findById(c.id);
  realtime.toChannel(widget.channelId, "new_message", { conversationId: c.id, message });
  realtime.toChannel(widget.channelId, "conversation_updated", { conversation: fresh });
  if (fresh?.assignedTo) realtime.toUser(fresh.assignedTo, "notification:new", { type: "message", title: `New website message from ${fresh.contactName ?? "a visitor"}`, body: text.slice(0, 120), conversationId: c.id });
  emit(widget.userId, "message.received", {
    messageId: message.id,
    channel: "web",
    channelId: widget.channelId,
    conversationId: c.id,
    contact: { id: c.contactId, name: c.contactName, phone: c.contactPhone, email: (c.webVisitor as { email?: string } | null)?.email ?? null },
    type: "text",
    text,
    widgetId: widget.id,
    receivedAt: at.toISOString(),
  });
  return message;
}

/** Starts a website chat: a new inbox conversation with the visitor's first message. */
export async function startVisitorChat(widget: ChatWidget, input: { name?: string; email?: string; phone?: string; message: string; page?: string }, origin: string | null) {
  const name = input.name?.trim() || null;
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() ? normalizePhone(input.phone) : null;
  let contactId: string | null = null;
  // A phone number links the chat to a contact (and lets agents follow up on WhatsApp).
  if (phone) {
    let contact = await contactsRepository.findByPhone(widget.channelId, phone);
    if (!contact) {
      contact = await contactsRepository.create({ channelId: widget.channelId, tenantId: widget.userId, name: name ?? phone, phone, email, source: "widget", lastContact: new Date() });
      emit(widget.userId, "contact.created", { contact: contactData(contact) });
    }
    contactId = contact.id;
  }
  const shortId = crypto.randomInt(1000, 9999);
  const conversation = await conversationsRepository.create({
    channelId: widget.channelId,
    contactId,
    contactPhone: phone,
    contactName: name ?? (email ? email.split("@")[0] : `Website visitor ${shortId}`),
    status: "open",
    type: "web",
    unreadCount: 0,
    webVisitor: { name, email, phone, page: input.page?.slice(0, 500) ?? null, origin, widgetId: widget.id },
  });
  realtime.toChannel(widget.channelId, "conversation_created", { conversation });
  const message = await recordInbound(widget, conversation, input.message, { page: input.page ?? null });
  return { conversation, token: visitorToken(widget.id, conversation.id), messages: [toVisitor(message)] };
}

export async function visitorSend(widget: ChatWidget, c: Conversation, text: string) {
  return toVisitor(await recordInbound(widget, c, text));
}

/** Messages after `afterId` (all when omitted); agent messages fetched here count as delivered. */
export async function visitorMessages(c: Conversation, afterId?: string): Promise<VisitorMessage[]> {
  let after: Date | null = null;
  if (afterId) after = (await messagesRepository.findById(afterId))?.createdAt ?? null;
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, c.id), after ? gt(messages.createdAt, after) : undefined))
    .orderBy(asc(messages.createdAt))
    .limit(200);
  const visible = rows.filter((m) => m.status !== "failed");
  const fresh = visible.filter((m) => m.direction === "outbound" && m.status === "sent").map((m) => m.id);
  if (fresh.length) {
    await db.update(messages).set({ status: "delivered", deliveredAt: new Date() }).where(inArray(messages.id, fresh));
    realtime.toChannel(c.channelId, "messages_delivered", { conversationId: c.id, messageIds: fresh });
  }
  return visible.map(toVisitor);
}
