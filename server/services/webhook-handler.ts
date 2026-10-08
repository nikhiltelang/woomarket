import crypto from "node:crypto";
import { processSocialPayload } from "./social.service";
import type { WebhookEvent } from "@shared/webhooks";
import { emit } from "./webhooks.service";
import { contactData, emitForChannel } from "./webhook-events";
import { webhookDedup, type Channel, type Conversation, type Message } from "@shared/schema";
import { db } from "../db";
import { config } from "../config";
import { channelsRepository } from "../repositories/channels.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { campaignsRepository } from "../repositories/campaigns.repository";
import { templatesRepository } from "../repositories/templates.repository";
import { childLogger } from "../lib/logger";
import { timingSafeEqualStr } from "../lib/crypto";
import { realtime } from "./realtime";
import { setSimulatorSink } from "./whatsapp/simulator-client";
import { runChatbot } from "./chatbot.service";
import { describe, type InboundMessage } from "./whatsapp/describe";
import { handleEchoes, handleHistory, handleStateSync } from "./whatsapp-signup.service";

const COEXISTENCE_FIELDS = new Set(["history", "smb_app_state_sync", "smb_message_echoes"]);

const log = childLogger("webhook");

const STATUS_RANK: Record<string, number> = { pending: 0, queued: 0, sent: 1, delivered: 2, read: 3 };

/** Verifies Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody: Buffer | undefined, header: string | undefined, secret = config.WHATSAPP_APP_SECRET) {
  if (!secret) return !config.isProduction; // unsigned webhooks are only accepted outside production
  if (!rawBody || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqualStr(header.slice(7), expected);
}

const normalizePhone = (waId: string) => `+${waId.replace(/\D/g, "")}`;

async function handleInbound(channel: Channel, msg: InboundMessage, profiles: { wa_id: string; profile?: { name?: string } }[]) {
  const [dedup] = await db.insert(webhookDedup).ignore().values({ wamid: msg.id });
  if (dedup.affectedRows === 0) {
    log.debug({ wamid: msg.id }, "Duplicate inbound message skipped");
    return;
  }

  const phone = normalizePhone(msg.from);
  const profileName = profiles.find((p) => p.wa_id === msg.from)?.profile?.name;
  const at = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();

  let contact = await contactsRepository.findByPhone(channel.id, phone);
  if (!contact) {
    contact = await contactsRepository.create({
      channelId: channel.id,
      tenantId: channel.createdBy,
      name: profileName || phone,
      phone,
      source: "whatsapp",
      lastContact: at,
    });
    emit(channel.createdBy, "contact.created", { contact: contactData(contact) });
  } else {
    await contactsRepository.update(contact.id, { lastContact: at });
  }

  let conversation: Conversation | undefined = await conversationsRepository.findByChannelAndPhone(channel.id, phone);
  let created = false;
  if (!conversation) {
    conversation = await conversationsRepository.create({
      channelId: channel.id,
      contactId: contact.id,
      contactPhone: phone,
      contactName: contact.name,
      status: "open",
      unreadCount: 0,
    });
    created = true;
  }

  const previousInboundAt = conversation.lastIncomingMessageAt ?? null;
  const { content, media, buttonId } = describe(msg);
  const message = await messagesRepository.create({
    conversationId: conversation.id,
    whatsappMessageId: msg.id,
    fromUser: true,
    direction: "inbound",
    content,
    type: msg.type,
    fromType: "contact",
    messageType: msg.type,
    mediaId: media?.id ?? null,
    mediaMimeType: media?.mime ?? null,
    mediaSha256: media?.sha ?? null,
    status: "received",
    timestamp: at,
    metadata: { context: msg.context ?? null, ...(buttonId ? { buttonId } : {}) },
  });
  await conversationsRepository.recordMessage(conversation.id, { text: content, at, inbound: true });

  // A reply to a campaign message counts towards the campaign's replied total.
  let campaignId: string | null = null;
  if (msg.context?.id) {
    const recipient = await campaignsRepository.findRecipientByWamid(msg.context.id);
    campaignId = recipient?.campaignId ?? null;
    if (recipient && recipient.status !== "replied") {
      await campaignsRepository.updateRecipient(recipient.id, { status: "replied" });
      await campaignsRepository.increment(recipient.campaignId, "repliedCount");
    }
  }
  emit(channel.createdBy, "message.received", {
    messageId: msg.id,
    channelId: channel.id,
    conversationId: conversation.id,
    contact: { id: contact.id, name: contact.name, phone },
    type: msg.type,
    text: content,
    mediaId: media?.id ?? null,
    inReplyTo: msg.context?.id ?? null,
    campaignId,
    receivedAt: at.toISOString(),
  });

  const fresh = await conversationsRepository.findById(conversation.id);
  if (created) realtime.toChannel(channel.id, "conversation_created", { conversation: fresh });
  realtime.toChannel(channel.id, "new_message", { conversationId: conversation.id, message });
  realtime.toChannel(channel.id, "conversation_updated", { conversation: fresh });
  if (fresh?.assignedTo) {
    realtime.toUser(fresh.assignedTo, "notification:new", {
      type: "message",
      title: `New message from ${fresh.contactName ?? phone}`,
      body: content.slice(0, 120),
      conversationId: conversation.id,
    });
  }

  if (fresh) {
    runChatbot({ tenantId: channel.createdBy, conversation: fresh, channel: "whatsapp", text: content, buttonId: buttonId ?? null, previousInboundAt, isNew: created, at });
  }
}

interface StatusUpdate {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

const STATUS_EVENTS: Record<string, WebhookEvent> = { sent: "message.sent", delivered: "message.delivered", read: "message.read", failed: "message.failed" };

/** Records a status update; emits a webhook event only when the status actually moved forward. */
async function handleStatus(st: StatusUpdate, channelId?: string) {
  const recipient = await campaignsRepository.findRecipientByWamid(st.id);
  const advanced = await applyStatus(st, recipient);
  const event = STATUS_EVENTS[st.status];
  if (!advanced || !event || !channelId) return;
  const error = st.errors?.[0];
  emitForChannel(channelId, event, {
    messageId: st.id,
    channelId,
    to: st.recipient_id ? `+${st.recipient_id.replace(/^\+/, "")}` : null,
    status: st.status,
    ...(error ? { error: { code: String(error.code ?? ""), message: error.error_data?.details ?? error.message ?? error.title ?? "Delivery failed" } } : {}),
    campaignId: recipient?.campaignId ?? null,
    at: (st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date()).toISOString(),
  });
}

async function applyStatus(st: StatusUpdate, recipient: Awaited<ReturnType<typeof campaignsRepository.findRecipientByWamid>>): Promise<boolean> {
  let advanced = false;
  const at = st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date();
  const error = st.errors?.[0];
  const errorText = error ? (error.error_data?.details ?? error.message ?? error.title ?? "Delivery failed") : null;

  const message: Message | undefined = await messagesRepository.findByWhatsappId(st.id);
  if (message) {
    const prev = message.status ?? "sent";
    const advance = st.status === "failed" ? prev !== "read" && prev !== "failed" : (STATUS_RANK[st.status] ?? -1) > (STATUS_RANK[prev] ?? -1);
    if (advance) {
      advanced = true;
      await messagesRepository.update(message.id, {
        status: st.status,
        ...(st.status === "delivered" ? { deliveredAt: at } : {}),
        ...(st.status === "read" ? { readAt: at, deliveredAt: message.deliveredAt ?? at } : {}),
        ...(error ? { errorCode: String(error.code ?? ""), errorMessage: errorText, errorDetails: st.errors } : {}),
      });
      const conv = message.conversationId ? await conversationsRepository.findById(message.conversationId) : undefined;
      realtime.toChannel(conv?.channelId, "message_status_update", {
        conversationId: message.conversationId,
        messageId: message.id,
        whatsappMessageId: st.id,
        status: st.status,
        error: errorText,
      });
    }
  }

  if (recipient) {
    const prev = recipient.status ?? "sent";
    if (prev === "replied" || prev === "failed") return advanced;
    const prevRank = STATUS_RANK[prev] ?? 1;
    if (st.status === "failed") {
      await campaignsRepository.updateRecipient(recipient.id, { status: "failed", errorCode: String(error?.code ?? ""), errorMessage: errorText });
      await campaignsRepository.increment(recipient.campaignId, "failedCount");
      return true;
    }
    const rank = STATUS_RANK[st.status] ?? -1;
    if (rank <= prevRank) return advanced;
    await campaignsRepository.updateRecipient(recipient.id, {
      status: st.status,
      ...(rank >= 2 ? { deliveredAt: recipient.deliveredAt ?? at } : {}),
      ...(rank >= 3 ? { readAt: at } : {}),
    });
    if (rank >= 2 && prevRank < 2) await campaignsRepository.increment(recipient.campaignId, "deliveredCount");
    if (rank >= 3 && prevRank < 3) await campaignsRepository.increment(recipient.campaignId, "readCount");
    const campaign = await campaignsRepository.findById(recipient.campaignId);
    if (campaign) realtime.toChannel(campaign.channelId, "campaign_updated", { campaign });
    return true;
  }
  return advanced;
}

async function handleTemplateStatus(value: { event?: string; message_template_id?: string | number; reason?: string }) {
  if (!value.message_template_id) return;
  const rows = await templatesRepository.findByWhatsappIdAnyChannel(String(value.message_template_id));
  const status = String(value.event ?? "").toLowerCase();
  for (const t of rows) {
    await templatesRepository.update(t.id, {
      status,
      rejectionReason: value.reason && value.reason !== "NONE" ? value.reason : null,
    });
    realtime.toChannel(t.channelId, "template_updated", { templateId: t.id, status });
  }
}

/** Processes a Meta webhook payload (or an identical simulated one). */
export async function processWebhookPayload(payload: any, onlyChannelId?: string): Promise<void> {
  // Messenger and Instagram events share the app's webhook with WhatsApp.
  if (payload?.object === "page" || payload?.object === "instagram") return processSocialPayload(payload);
  if (payload?.object !== "whatsapp_business_account") return;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (change.field === "messages") {
        const phoneNumberId = value.metadata?.phone_number_id;
        const channel = phoneNumberId ? await channelsRepository.findByPhoneNumberId(String(phoneNumberId)) : undefined;
        if (!channel || (onlyChannelId && channel.id !== onlyChannelId)) {
          log.warn({ phoneNumberId }, "Webhook for unknown or mismatched channel ignored");
          continue;
        }
        for (const msg of value.messages ?? []) await handleInbound(channel, msg, value.contacts ?? []);
        for (const st of value.statuses ?? []) await handleStatus(st, channel.id);
      } else if (change.field === "message_template_status_update") {
        await handleTemplateStatus(value);
      } else if (COEXISTENCE_FIELDS.has(change.field)) {
        // Coexistence: contacts, chat history and replies typed in the WhatsApp Business app.
        const phoneNumberId = value.metadata?.phone_number_id;
        const channel = phoneNumberId ? await channelsRepository.findByPhoneNumberId(String(phoneNumberId)) : undefined;
        if (!channel || (onlyChannelId && channel.id !== onlyChannelId)) continue;
        if (change.field === "history") await handleHistory(channel, value);
        else if (change.field === "smb_app_state_sync") await handleStateSync(channel, value);
        else await handleEchoes(channel, value);
      }
    }
  }
}

setSimulatorSink((payload) => processWebhookPayload(payload));
