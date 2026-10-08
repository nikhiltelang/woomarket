import type { Request, Response } from "express";
import { saveImage } from "../lib/uploads";
import { publicBaseUrl } from "../lib/tokens";
import { isSocialType } from "@shared/social";
import { publicAccount, replyPolicy, socialAccountsRepository } from "../services/social.service";
import { z } from "zod";
import {
  conversationListQuery,
  conversationStatusSchema,
  sendMessageSchema,
  updateConversationSchema,
} from "@shared/validation";
import { hasPermission } from "@shared/roles";
import type { Channel, Conversation } from "@shared/schema";
import { paginated, parseBody, parseQuery } from "../lib/http";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { usersRepository } from "../repositories/users.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { activityRepository } from "../repositories/activity.repository";
import { assertChannelAccess } from "../middlewares/tenant";
import { findOrCreateConversation, isWithinServiceWindow, sendConversationMessage } from "../services/messaging.service";
import { realtime } from "../services/realtime";
import { chatbotRepository } from "../services/chatbot.service";

export async function loadConversation(req: Request, id = req.params.id ?? req.params.conversationId): Promise<{ conversation: Conversation; channel: Channel }> {
  const conversation = await conversationsRepository.findById(id);
  if (!conversation) throw notFound("Conversation");
  const channel = await assertChannelAccess(req.user!, conversation.channelId).catch(() => {
    throw notFound("Conversation");
  });
  return { conversation, channel };
}

const withWindow = (c: Conversation) => ({ ...c, windowOpen: isWithinServiceWindow(c) });

export async function listConversations(req: Request, res: Response) {
  const q = parseQuery(conversationListQuery, req);
  const { rows, total } = await conversationsRepository.list(req.channel!.id, req.user!.id, q);
  res.json(paginated(rows.map((r) => ({ ...r, windowOpen: isWithinServiceWindow(r) })), total, q.page, q.limit));
}

export async function getConversation(req: Request, res: Response) {
  const { conversation, channel } = await loadConversation(req);
  const contact = conversation.contactId ? await contactsRepository.findById(conversation.contactId) : undefined;
  // Whether the tenant's chatbot is on (the inbox offers pause / resume then).
  const bot = { enabled: channel.createdBy ? (await chatbotRepository.settings(channel.createdBy)).enabled : false };
  if (isSocialType(conversation.type)) {
    // Messenger / Instagram: 24 hours, or 7 days when the account may use the Human Agent tag.
    const account = conversation.socialAccountId ? await socialAccountsRepository.find(conversation.socialAccountId) : undefined;
    const policy = account ? replyPolicy(conversation, account.humanAgentTag) : "closed";
    return res.json({ data: { ...conversation, windowOpen: policy !== "closed", replyPolicy: policy }, contact: null, social: account ? publicAccount(account) : null, bot });
  }
  res.json({ data: withWindow(conversation), contact: contact ?? null, bot });
}

export async function createConversation(req: Request, res: Response) {
  const { contactId } = parseBody(z.object({ contactId: z.string().uuid() }), req);
  const contact = await contactsRepository.findById(contactId);
  if (!contact) throw notFound("Contact");
  const channel = await assertChannelAccess(req.user!, contact.channelId);
  const { conversation, created } = await findOrCreateConversation(channel, contact);
  res.status(created ? 201 : 200).json({ data: withWindow(conversation), created });
}

export async function updateConversation(req: Request, res: Response) {
  const { conversation, channel } = await loadConversation(req);
  const input = parseBody(updateConversationSchema, req);
  if (input.assignedTo !== undefined && input.assignedTo !== null) {
    const assignee = await usersRepository.findById(input.assignedTo);
    const tenant = channel.createdBy;
    const inTenant = assignee && assignee.status === "active" && (assignee.id === tenant || assignee.createdBy === tenant);
    if (!inTenant) throw badRequest("Assignee must be an active member of this account");
    if (assignee.id !== conversation.assignedTo) {
      await conversationsRepository.recordAssignment(conversation.id, assignee.id, req.user!.id);
      realtime.toUser(assignee.id, "conversation_assigned", { conversationId: conversation.id, assignedBy: req.user!.username });
      realtime.toUser(assignee.id, "notification:new", {
        type: "assignment",
        title: "Conversation assigned to you",
        body: `${conversation.contactName ?? conversation.contactPhone} — assigned by ${req.user!.username}`,
        conversationId: conversation.id,
      });
    }
  }
  const updated = await conversationsRepository.update(conversation.id, input);
  realtime.toChannel(channel.id, "conversation_updated", { conversation: updated });
  await activityRepository.record(req, req.user!.id, "conversation_updated", { type: "conversation", id: conversation.id }, input);
  res.json({ data: withWindow(updated!) });
}

export async function updateStatus(req: Request, res: Response) {
  const { conversation, channel } = await loadConversation(req);
  const { status } = parseBody(conversationStatusSchema, req);
  const updated = await conversationsRepository.update(conversation.id, { status });
  realtime.toChannel(channel.id, "conversation_status_changed", { conversationId: conversation.id, status });
  realtime.toChannel(channel.id, "conversation_updated", { conversation: updated });
  res.json({ data: withWindow(updated!) });
}

export async function markRead(req: Request, res: Response) {
  const { conversation, channel } = await loadConversation(req);
  await conversationsRepository.markRead(conversation.id);
  realtime.toChannel(channel.id, "messages_read", { conversationId: conversation.id });
  res.json({ success: true });
}

export async function deleteConversation(req: Request, res: Response) {
  if (req.user!.role === "team" && !hasPermission(req.user!.permissions, "inbox:assign")) throw forbidden();
  const { conversation } = await loadConversation(req);
  await conversationsRepository.delete(conversation.id);
  await activityRepository.record(req, req.user!.id, "conversation_deleted", { type: "conversation", id: conversation.id });
  res.json({ success: true });
}

export async function unreadCount(req: Request, res: Response) {
  if (!req.user?.tenantId) return res.json({ count: 0 });
  const channels = await channelsRepository.listByTenant(req.user.tenantId);
  res.json({ count: await conversationsRepository.unreadCountForChannels(channels.map((c) => c.id)) });
}

export async function listPins(req: Request, res: Response) {
  const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
  res.json({ data: await conversationsRepository.listPins(req.user!.id, channelId) });
}

export async function pin(req: Request, res: Response) {
  const { conversation } = await loadConversation(req);
  await conversationsRepository.pin(req.user!.id, conversation.id, conversation.channelId);
  res.json({ success: true });
}

export async function unpin(req: Request, res: Response) {
  const { conversation } = await loadConversation(req);
  await conversationsRepository.unpin(req.user!.id, conversation.id);
  res.json({ success: true });
}

// --- Messages ---------------------------------------------------------------

const messagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().uuid().optional(),
});

export async function listMessages(req: Request, res: Response) {
  const { conversation } = await loadConversation(req, req.params.conversationId);
  const q = parseQuery(messagesQuery, req);
  const rows = await messagesRepository.listForConversation(conversation.id, q.limit, q.before);
  res.json({ data: rows, hasMore: rows.length === q.limit });
}

export async function sendMessage(req: Request, res: Response) {
  const { conversation, channel } = await loadConversation(req, req.params.conversationId);
  const input = parseBody(sendMessageSchema, req);
  const message = await sendConversationMessage(req.user!, channel, conversation, input);
  res.status(201).json({ data: message });
}

/** POST /api/conversations/:conversationId/attachments (multipart "image") — Messenger / Instagram images. */
export async function uploadAttachment(req: Request, res: Response) {
  const { conversation, channel } = await loadConversation(req, req.params.conversationId);
  if (!isSocialType(conversation.type)) throw badRequest("Images can be sent in Messenger and Instagram conversations only.");
  if (!req.file) throw badRequest("Choose an image");
  const url = await saveImage(req.file, `inbox/${channel.createdBy}`);
  res.status(201).json({ data: { url: `${publicBaseUrl()}${url}` } });
}
