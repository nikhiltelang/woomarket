import type { Request, Response } from "express";
import { z } from "zod";
import { BOT_CHANNELS, botSettingsSchema, ruleSchema, type RuleInput } from "@shared/chatbot";
import type { ChatbotRule } from "@shared/schema";
import { parseBody } from "../lib/http";
import { notFound, unprocessable } from "../lib/errors";
import { requireTenantId } from "../middlewares/tenant";
import { activityRepository } from "../repositories/activity.repository";
import { conversationsRepository } from "../repositories/conversations.repository";
import { realtime } from "../services/realtime";
import { botTimezone, chatbotRepository, isTenantMember, testChatbot } from "../services/chatbot.service";
import { loadConversation } from "./conversations.controller";

async function own(req: Request): Promise<ChatbotRule> {
  const r = await chatbotRepository.find(req.params.id);
  if (!r || r.userId !== requireTenantId(req.user)) throw notFound("Rule");
  return r;
}

async function validRule(tenantId: string, req: Request): Promise<RuleInput> {
  const input = parseBody(ruleSchema, req);
  if (input.actions.assignTo && !(await isTenantMember(tenantId, input.actions.assignTo))) throw unprocessable("Pick someone from your team to assign to.", "BAD_ASSIGNEE");
  return input;
}

/** GET /api/chatbot — settings, rules and the time zone business hours use. */
export async function overview(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const settings = await chatbotRepository.settings(tenantId);
  res.json({ data: { settings, timezone: await botTimezone(tenantId, settings), rules: await chatbotRepository.rules(tenantId) } });
}

export async function saveSettings(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const settings = parseBody(botSettingsSchema, req);
  await chatbotRepository.saveSettings(tenantId, settings);
  await activityRepository.record(req, req.user!.id, "chatbot_settings_saved", { type: "tenant_settings", id: tenantId }, { enabled: settings.enabled });
  res.json({ data: { settings, timezone: await botTimezone(tenantId, settings) } });
}

export async function createRule(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const count = (await chatbotRepository.rules(tenantId)).length;
  if (count >= 200) throw unprocessable("You can have up to 200 rules.", "TOO_MANY_RULES");
  const rule = await chatbotRepository.create(tenantId, await validRule(tenantId, req));
  await activityRepository.record(req, req.user!.id, "chatbot_rule_created", { type: "chatbot_rule", id: rule.id }, { name: rule.name });
  res.status(201).json({ data: rule });
}

export async function updateRule(req: Request, res: Response) {
  const r = await own(req);
  const rule = await chatbotRepository.update(r.id, await validRule(r.userId, req));
  await activityRepository.record(req, req.user!.id, "chatbot_rule_updated", { type: "chatbot_rule", id: r.id }, { name: rule?.name });
  res.json({ data: rule });
}

/** PATCH /api/chatbot/rules/:id { enabled } */
export async function toggleRule(req: Request, res: Response) {
  const r = await own(req);
  const { enabled } = parseBody(z.object({ enabled: z.boolean() }), req);
  await chatbotRepository.setEnabled(r.id, enabled);
  res.json({ data: await chatbotRepository.find(r.id) });
}

export async function deleteRule(req: Request, res: Response) {
  const r = await own(req);
  await chatbotRepository.delete(r.id);
  await activityRepository.record(req, req.user!.id, "chatbot_rule_deleted", { type: "chatbot_rule", id: r.id }, { name: r.name });
  res.status(204).end();
}

/** PUT /api/chatbot/rules/order { ids } */
export async function reorder(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const { ids } = parseBody(z.object({ ids: z.array(z.string().uuid()).max(200) }), req);
  await chatbotRepository.reorder(tenantId, ids);
  res.json({ data: await chatbotRepository.rules(tenantId) });
}

const testSchema = z.object({
  channel: z.enum(BOT_CHANNELS).default("whatsapp"),
  text: z.string().trim().max(1000).default(""),
  buttonId: z.string().trim().max(64).optional(),
  firstMessage: z.boolean().default(false),
  at: z.coerce.date().optional(),
});

/** POST /api/chatbot/test — which rule would answer, and with what (nothing is sent). */
export async function test(req: Request, res: Response) {
  const input = parseBody(testSchema, req);
  if (!input.text && !input.buttonId && !input.firstMessage) throw unprocessable("Type a message to test.", "EMPTY_TEST");
  res.json({ data: await testChatbot(requireTenantId(req.user), input) });
}

export async function events(req: Request, res: Response) {
  res.json({ data: await chatbotRepository.recentEvents(requireTenantId(req.user), 50) });
}

/** POST /api/chatbot/conversations/:id/pause { hours } (0 = resume) */
export async function pauseConversation(req: Request, res: Response) {
  const { conversation } = await loadConversation(req);
  const { hours } = parseBody(z.object({ hours: z.coerce.number().min(0).max(720) }), req);
  await chatbotRepository.setPause(conversation.id, hours > 0 ? new Date(Date.now() + hours * 3_600_000) : null);
  const fresh = await conversationsRepository.findById(conversation.id);
  realtime.toChannel(conversation.channelId, "conversation_updated", { conversation: fresh });
  res.json({ data: fresh });
}
