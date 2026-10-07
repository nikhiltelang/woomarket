import type { Request, Response } from "express";
import { z } from "zod";
import { and, gte, sql } from "drizzle-orm";
import { aiSettingsSchema, campaignDraftSchema, DEFAULT_AI_MODEL } from "@shared/ai";
import { aiUsage } from "@shared/schema";
import { db } from "../db";
import { parseBody } from "../lib/http";
import { badRequest } from "../lib/errors";
import { requireTenantId } from "../middlewares/tenant";
import { aiSettings, aiStatus, analyzeConversation, draftCampaign, draftEmail, suggestReplies, testConnection } from "../services/ai/assistant.service";
import { loadConversation } from "./conversations.controller";

const ctx = (req: Request) => ({ tenantId: requireTenantId(req.user), actorId: req.user!.id });

/** GET /api/ai/status — whether this tenant can use the assistant, and how much is left. */
export async function status(req: Request, res: Response) {
  res.json({ data: await aiStatus(requireTenantId(req.user)) });
}

/** POST /api/ai/draft — campaign copy for SMS, WhatsApp templates and email. */
export async function draft(req: Request, res: Response) {
  const input = parseBody(campaignDraftSchema, req);
  if (input.channel === "email_body") return res.json({ data: await draftEmail(ctx(req), input) });
  res.json({ data: await draftCampaign(ctx(req), input) });
}

/** POST /api/ai/conversations/:id/replies */
export async function replies(req: Request, res: Response) {
  const { conversation } = await loadConversation(req);
  const { instructions } = parseBody(z.object({ instructions: z.string().trim().max(300).optional() }), req);
  res.json({ data: await suggestReplies(ctx(req), conversation, { instructions }) });
}

/** POST /api/ai/conversations/:id/insights */
export async function insights(req: Request, res: Response) {
  const { conversation } = await loadConversation(req);
  res.json({ data: await analyzeConversation(ctx(req), conversation) });
}

// --- Superadmin ------------------------------------------------------------------

/** POST /api/system-config/ai/test { apiKey?, model } — tries the key (or the saved one). */
export async function test(req: Request, res: Response) {
  const input = parseBody(aiSettingsSchema.pick({ apiKey: true, model: true }).partial(), req);
  const saved = await aiSettings();
  const key = input.apiKey || saved.apiKey;
  if (!key) throw badRequest("Enter an API key to test.");
  res.json({ data: await testConnection(key, input.model || saved.model || DEFAULT_AI_MODEL) });
}

/** GET /api/system-config/ai/usage — this month across all tenants. */
export async function usage(_req: Request, res: Response) {
  const d = new Date();
  const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const [totals] = await db
    .select({ requests: sql<number>`COUNT(*)`, inputTokens: sql<number>`COALESCE(SUM(${aiUsage.inputTokens}), 0)`, outputTokens: sql<number>`COALESCE(SUM(${aiUsage.outputTokens}), 0)`, tenants: sql<number>`COUNT(DISTINCT ${aiUsage.userId})` })
    .from(aiUsage)
    .where(and(gte(aiUsage.createdAt, since)));
  const byFeature = await db
    .select({ feature: aiUsage.feature, n: sql<number>`COUNT(*)` })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, since))
    .groupBy(aiUsage.feature);
  res.json({ data: { since, requests: Number(totals.requests), inputTokens: Number(totals.inputTokens), outputTokens: Number(totals.outputTokens), tenants: Number(totals.tenants), byFeature: byFeature.map((f) => ({ feature: f.feature, requests: Number(f.n) })) } });
}
