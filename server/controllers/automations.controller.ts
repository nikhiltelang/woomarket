import type { Request, Response } from "express";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { automationSchema, triggerSchema } from "@shared/automations";
import { contacts, type Automation } from "@shared/schema";
import { db } from "../db";
import { parse, parseBody, parseQuery } from "../lib/http";
import { AppError, conflict, notFound, unprocessable } from "../lib/errors";
import { requireTenantId } from "../middlewares/tenant";
import { activityRepository } from "../repositories/activity.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { segmentCondition } from "../services/segments.service";
import {
  activationProblems,
  assertOwnedRefs,
  automationsRepository,
  enrolMany,
  invalidateFlowCache,
  MAX_BULK_ENROL,
  parseFlow,
  retireStepCampaigns,
  runsRepository,
  syncStepCampaigns,
} from "../services/automations.service";

async function own(req: Request, id = req.params.id): Promise<Automation> {
  const a = await automationsRepository.find(id);
  if (!a || a.userId !== requireTenantId(req.user)) throw notFound("Flow");
  return a;
}

/** GET /api/automations */
export async function list(req: Request, res: Response) {
  const rows = await automationsRepository.list(requireTenantId(req.user));
  const counts = await automationsRepository.runCounts(rows.map((r) => r.id));
  res.json({ data: rows.map(({ steps, stepCampaigns, ...a }) => ({ ...a, stepCount: Array.isArray(steps) ? steps.length : 0, runs: counts.get(a.id) ?? {} })) });
}

export async function get(req: Request, res: Response) {
  const a = await own(req);
  const flow = parseFlow(a);
  res.json({ data: a, problems: flow ? await activationProblems(a, flow) : ["This flow can't be read; edit and save it again."] });
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Name the flow").max(100),
  description: z.string().trim().max(500).nullish(),
  trigger: triggerSchema.default({ type: "manual" }),
  steps: z.array(z.unknown()).default([]),
  reentry: z.enum(["never", "after_exit"]).default("never"),
});

export async function create(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const raw = parseBody(createSchema, req);
  const flow = parse(automationSchema, raw);
  await assertOwnedRefs(tenantId, flow);
  if ((await automationsRepository.list(tenantId)).length >= 100) throw unprocessable("You can have up to 100 flows.", "TOO_MANY_FLOWS");
  let a = await automationsRepository.create({ userId: tenantId, name: flow.name, description: flow.description ?? null, trigger: flow.trigger, steps: flow.steps, reentry: flow.reentry, status: "draft", createdBy: req.user!.id });
  a = (await automationsRepository.update(a.id, { stepCampaigns: await syncStepCampaigns(a, flow) }))!;
  await activityRepository.record(req, req.user!.id, "automation_created", { type: "automation", id: a.id }, { name: a.name });
  res.status(201).json({ data: a });
}

/** PUT /api/automations/:id — saves the whole flow (live flows keep running with the new steps). */
export async function update(req: Request, res: Response) {
  const a = await own(req);
  const flow = parseBody(automationSchema, req);
  await assertOwnedRefs(a.userId, flow);
  let saved = (await automationsRepository.update(a.id, { name: flow.name, description: flow.description ?? null, trigger: flow.trigger, steps: flow.steps, reentry: flow.reentry }))!;
  saved = (await automationsRepository.update(a.id, { stepCampaigns: await syncStepCampaigns(saved, flow) }))!;
  if (saved.status === "active") {
    const problems = await activationProblems(saved, flow);
    // A live flow that can no longer send is paused rather than left failing.
    if (problems.length) saved = (await automationsRepository.update(a.id, { status: "paused" }))!;
  }
  invalidateFlowCache(a.userId);
  await activityRepository.record(req, req.user!.id, "automation_updated", { type: "automation", id: a.id }, { name: saved.name });
  res.json({ data: saved, problems: await activationProblems(saved, flow) });
}

/** POST /api/automations/:id/status { status } */
export async function setStatus(req: Request, res: Response) {
  const a = await own(req);
  const { status } = parseBody(z.object({ status: z.enum(["active", "paused"]) }), req);
  if (status === "active") {
    const flow = parseFlow(a);
    const problems = flow ? await activationProblems(a, flow) : ["This flow can't be read; edit and save it again."];
    if (problems.length) throw new AppError(422, problems[0], "NOT_READY", { problems });
  }
  const saved = await automationsRepository.update(a.id, { status, ...(status === "active" && !a.activatedAt ? { activatedAt: new Date() } : {}) });
  invalidateFlowCache(a.userId);
  await activityRepository.record(req, req.user!.id, status === "active" ? "automation_activated" : "automation_paused", { type: "automation", id: a.id }, { name: a.name });
  res.json({ data: saved });
}

export async function remove(req: Request, res: Response) {
  const a = await own(req);
  await retireStepCampaigns(a);
  await automationsRepository.delete(a.id);
  invalidateFlowCache(a.userId);
  await activityRepository.record(req, req.user!.id, "automation_deleted", { type: "automation", id: a.id }, { name: a.name });
  res.status(204).end();
}

export async function duplicate(req: Request, res: Response) {
  const a = await own(req);
  const flow = parseFlow(a);
  if (!flow) throw unprocessable("This flow can't be copied.");
  let copy = await automationsRepository.create({ userId: a.userId, name: `${a.name} (copy)`.slice(0, 100), description: a.description, trigger: flow.trigger, steps: flow.steps, reentry: flow.reentry, status: "draft", createdBy: req.user!.id });
  copy = (await automationsRepository.update(copy.id, { stepCampaigns: await syncStepCampaigns(copy, flow) }))!;
  res.status(201).json({ data: copy });
}

/** GET /api/automations/:id/stats — per-step outcomes and runs by status. */
export async function stats(req: Request, res: Response) {
  const a = await own(req);
  const [steps, counts] = await Promise.all([runsRepository.stepStats(a.id), automationsRepository.runCounts([a.id])]);
  res.json({ data: { ...steps, runs: counts.get(a.id) ?? {} } });
}

export async function runs(req: Request, res: Response) {
  const a = await own(req);
  const q = parseQuery(z.object({ status: z.enum(["active", "waiting", "completed", "exited", "failed"]).optional() }), req);
  res.json({ data: await runsRepository.recent(a.id, { status: q.status, limit: 100 }) });
}

async function ownRun(req: Request) {
  const run = await runsRepository.find(req.params.runId);
  if (!run || run.userId !== requireTenantId(req.user)) throw notFound("Run");
  return run;
}

export async function runDetail(req: Request, res: Response) {
  const run = await ownRun(req);
  res.json({ data: { ...run, log: await runsRepository.runLog(run.id) } });
}

/** POST /api/automations/runs/:runId/exit — takes the contact out of the flow. */
export async function exitRun(req: Request, res: Response) {
  const run = await ownRun(req);
  if (run.status !== "active" && run.status !== "waiting") throw conflict("This run has already ended.");
  await runsRepository.update(run.id, { status: "exited", currentStepId: null, nextRunAt: null, finishedAt: new Date(), lastError: `Removed by ${req.user!.username}` });
  res.json({ success: true });
}

const enrolSchema = z
  .object({
    contactIds: z.array(z.string().uuid()).max(MAX_BULK_ENROL).default([]),
    groupId: z.string().uuid().optional(),
    segmentId: z.string().uuid().optional(),
  })
  .refine((v) => v.contactIds.length || v.groupId || v.segmentId, "Choose contacts, a group or a segment");

/** POST /api/automations/:id/enroll — adds contacts by hand (also works for flows with any trigger). */
export async function enrol(req: Request, res: Response) {
  const a = await own(req);
  if (a.status !== "active") throw conflict("Turn the flow on before adding contacts.");
  const input = parseBody(enrolSchema, req);
  const channelIds = (await channelsRepository.listByTenant(a.userId)).map((c) => c.id);
  const ids = new Set(input.contactIds);
  if (channelIds.length && (input.groupId || input.segmentId)) {
    const where = and(
      inArray(contacts.channelId, channelIds),
      eq(contacts.status, "active"),
      input.groupId ? sql`JSON_CONTAINS(${contacts.groups}, JSON_QUOTE(${input.groupId}))` : undefined,
      input.segmentId ? await segmentCondition(a.userId, input.segmentId) : undefined,
    );
    for (const r of await db.select({ id: contacts.id }).from(contacts).where(where).limit(MAX_BULK_ENROL + 1)) ids.add(r.id);
  }
  if (ids.size > MAX_BULK_ENROL) throw unprocessable(`At most ${MAX_BULK_ENROL.toLocaleString("en")} contacts at once.`, "TOO_MANY");
  const result = await enrolMany(a, [...ids], { event: "manual", by: req.user!.id });
  await activityRepository.record(req, req.user!.id, "automation_enrolled", { type: "automation", id: a.id }, result);
  res.json({ data: result });
}
