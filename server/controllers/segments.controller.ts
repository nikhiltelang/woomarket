import type { Request, Response } from "express";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { segmentSchema } from "@shared/segments";
import { campaigns, emailCampaigns, smsCampaigns } from "@shared/schema";
import { db } from "../db";
import { parse, parseBody } from "../lib/http";
import { conflict } from "../lib/errors";
import { assertChannelAccess, requireTenantId } from "../middlewares/tenant";
import { loadSegment, previewRules, segmentsRepository, validateRules } from "../services/segments.service";

export async function listSegments(req: Request, res: Response) {
  res.json({ data: await segmentsRepository.list(requireTenantId(req.user)) });
}

export async function getSegment(req: Request, res: Response) {
  res.json({ data: await loadSegment(requireTenantId(req.user), req.params.id) });
}

export async function createSegment(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(segmentSchema, req);
  const rules = await validateRules(tenantId, input.rules);
  const segment = await segmentsRepository.create({ userId: tenantId, name: input.name, description: input.description ?? null, rules, createdBy: req.user!.id });
  res.status(201).json({ data: segment });
}

export async function updateSegment(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const segment = await loadSegment(tenantId, req.params.id);
  const input = parseBody(segmentSchema.partial(), req);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description ?? null;
  if (input.rules !== undefined) {
    patch.rules = await validateRules(tenantId, input.rules);
    patch.lastCount = null;
    patch.lastCountedAt = null;
  }
  res.json({ data: await segmentsRepository.update(segment.id, patch) });
}

/** Draft or scheduled campaigns that will use the segment when they start. */
async function pendingCampaigns(segmentId: string) {
  const waiting = ["draft", "scheduled"];
  const [wa, email, sms] = await Promise.all([
    db.select({ name: campaigns.name }).from(campaigns).where(and(eq(campaigns.segmentId, segmentId), inArray(campaigns.status, waiting))),
    db.select({ name: emailCampaigns.name }).from(emailCampaigns).where(and(eq(emailCampaigns.targetSegmentId, segmentId), inArray(emailCampaigns.status, waiting))),
    db.select({ name: smsCampaigns.name }).from(smsCampaigns).where(and(eq(smsCampaigns.targetSegmentId, segmentId), inArray(smsCampaigns.status, waiting))),
  ]);
  return [...wa, ...email, ...sms].map((c) => c.name);
}

export async function deleteSegment(req: Request, res: Response) {
  const segment = await loadSegment(requireTenantId(req.user), req.params.id);
  const pending = await pendingCampaigns(segment.id);
  if (pending.length) throw conflict(`“${pending[0]}”${pending.length > 1 ? ` and ${pending.length - 1} more` : ""} will send to this segment. Change their audience first.`);
  await segmentsRepository.delete(segment.id);
  res.json({ success: true });
}

const previewSchema = z.object({ channelId: z.string().uuid(), rules: z.unknown() });

/** Live count and sample for unsaved rules (the rule builder). */
export async function previewSegment(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const { channelId, rules } = parseBody(previewSchema, req);
  await assertChannelAccess(req.user!, channelId);
  res.json({ data: await previewRules(channelId, await validateRules(tenantId, rules)) });
}

/** Current members of a saved segment in a channel; also refreshes its cached count. */
export async function segmentContacts(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const segment = await loadSegment(tenantId, req.params.id);
  const q = parse(z.object({ channelId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(100).default(25) }), req.query);
  await assertChannelAccess(req.user!, q.channelId);
  const result = await previewRules(q.channelId, await validateRules(tenantId, segment.rules), q.limit);
  await segmentsRepository.saveCount(segment.id, result.count);
  res.json({ data: result });
}
