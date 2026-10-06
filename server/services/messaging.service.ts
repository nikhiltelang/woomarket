import type { Channel, Contact, Conversation, Message } from "@shared/schema";
import type { z } from "zod";
import type { sendMessageSchema } from "@shared/validation";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { renderTemplateBody, templatesRepository } from "../repositories/templates.repository";
import { AppError, notFound, unprocessable } from "../lib/errors";
import { realtime } from "./realtime";
import { whatsappFactory, WhatsAppApiError } from "./whatsapp";
import type { AuthUser } from "../types";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinServiceWindow(conversation: Conversation, now = Date.now()): boolean {
  return Boolean(conversation.lastIncomingMessageAt && now - conversation.lastIncomingMessageAt.getTime() < WINDOW_MS);
}

export async function findOrCreateConversation(channel: Channel, contact: Contact): Promise<{ conversation: Conversation; created: boolean }> {
  const existing = await conversationsRepository.findByChannelAndPhone(channel.id, contact.phone);
  if (existing) return { conversation: existing, created: false };
  const conversation = await conversationsRepository.create({
    channelId: channel.id,
    contactId: contact.id,
    contactPhone: contact.phone,
    contactName: contact.name,
    status: "open",
  });
  realtime.toChannel(channel.id, "conversation_created", { conversation });
  return { conversation, created: true };
}

/**
 * Sends an agent message in a conversation. Free text is only allowed inside the
 * 24-hour customer-service window; outside it an approved template is required.
 */
export async function sendConversationMessage(
  user: AuthUser,
  channel: Channel,
  conversation: Conversation,
  input: z.infer<typeof sendMessageSchema>,
): Promise<Message> {
  if (!conversation.contactPhone) throw unprocessable("Conversation has no recipient phone number");
  const client = whatsappFactory.create(channel);

  let content: string;
  let send: () => Promise<{ messageId: string }>;
  let templateId: string | null = null;

  if (input.type === "text") {
    if (!isWithinServiceWindow(conversation)) {
      throw unprocessable(
        "The 24-hour customer service window is closed. Send an approved template to re-open the conversation.",
        "WINDOW_CLOSED",
      );
    }
    content = input.text;
    send = () => client.sendText(conversation.contactPhone!, input.text);
  } else {
    const template = await templatesRepository.findById(input.templateId);
    if (!template || template.channelId !== channel.id) throw notFound("Template");
    if (template.status !== "approved") throw unprocessable("Only approved templates can be sent", "TEMPLATE_NOT_APPROVED");
    const needed = template.bodyVariables ?? 0;
    if (input.params.length < needed) throw unprocessable(`This template needs ${needed} variable value(s)`, "TEMPLATE_PARAMS");
    content = renderTemplateBody(template.body, input.params);
    templateId = template.id;
    send = () =>
      client.sendTemplate(conversation.contactPhone!, {
        name: template.name,
        language: template.language ?? "en_US",
        params: input.params.slice(0, needed),
      });
  }

  const now = new Date();
  let message: Message;
  try {
    const { messageId } = await send();
    message = await messagesRepository.create({
      conversationId: conversation.id,
      whatsappMessageId: messageId,
      fromUser: false,
      direction: "outbound",
      content,
      type: input.type,
      fromType: "agent",
      messageType: input.type,
      status: "sent",
      timestamp: now,
      metadata: { sentBy: user.id, sentByName: user.username, templateId },
    });
    if (templateId) await templatesRepository.incrementUsage(templateId);
  } catch (err) {
    const reason = err instanceof WhatsAppApiError ? err.message : "Unexpected error while sending";
    message = await messagesRepository.create({
      conversationId: conversation.id,
      fromUser: false,
      direction: "outbound",
      content,
      type: input.type,
      fromType: "agent",
      status: "failed",
      timestamp: now,
      errorCode: err instanceof WhatsAppApiError ? String(err.code ?? "") : "internal",
      errorMessage: reason,
      metadata: { sentBy: user.id, sentByName: user.username, templateId },
    });
    realtime.toChannel(channel.id, "new_message", { conversationId: conversation.id, message });
    throw new AppError(502, `WhatsApp rejected the message: ${reason}`, "SEND_FAILED", { messageId: message.id });
  }

  await conversationsRepository.recordMessage(conversation.id, { text: content, at: now, inbound: false });
  const fresh = await conversationsRepository.findById(conversation.id);
  realtime.toChannel(channel.id, "new_message", { conversationId: conversation.id, message });
  realtime.toChannel(channel.id, "conversation_updated", { conversation: fresh });
  return message;
}
