import type { Request, Response } from "express";
import { z } from "zod";
import { REPORT_SECTIONS, reportQuerySchema, reportScheduleSchema, type ReportSection } from "@shared/reports";
import type { ReportSchedule } from "@shared/schema";
import { parse, parseBody } from "../lib/http";
import { conflict, notFound } from "../lib/errors";
import { assertChannelAccess, requireTenantId } from "../middlewares/tenant";
import { activityRepository } from "../repositories/activity.repository";
import { usersRepository } from "../repositories/users.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { systemConfig } from "../services/system-config.service";
import { buildReport } from "../services/reports.service";
import { reportCsv, reportPdf } from "../services/report-export";
import { computeNextRun, reportSchedulesRepository, sendScheduledReport } from "../services/report-schedules.service";

const MAX_SCHEDULES = 20;

const sectionsParam = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").filter((s): s is ReportSection => (REPORT_SECTIONS as readonly string[]).includes(s)) : [...REPORT_SECTIONS]));

async function readQuery(req: Request) {
  const q = parse(reportQuerySchema, req.query);
  if (q.channelId) await assertChannelAccess(req.user!, q.channelId);
  return q;
}

/** GET /api/reports?from&to&channelId&sections=overview,team */
export async function getReport(req: Request, res: Response) {
  const q = await readQuery(req);
  const sections = parse(sectionsParam, req.query.sections);
  res.json({ data: await buildReport(requireTenantId(req.user), q, sections) });
}

/** GET /api/reports/export?format=pdf|csv&section=overview&from&to */
export async function exportReport(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const q = await readQuery(req);
  const { format, section } = parse(z.object({ format: z.enum(["pdf", "csv"]), section: z.enum(REPORT_SECTIONS).optional() }), req.query);
  const name = `report-${q.from}-to-${q.to}`;
  if (format === "csv") {
    const sec = section ?? "overview";
    const report = await buildReport(tenantId, q, [sec]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}-${sec}.csv"`);
    res.send(reportCsv(report, sec));
  } else {
    const sections = section ? [section] : [...REPORT_SECTIONS];
    const [report, tenant, channel, cfg] = await Promise.all([buildReport(tenantId, q, sections), usersRepository.findById(tenantId), q.channelId ? channelsRepository.findById(q.channelId) : undefined, systemConfig.get()]);
    const tenantName = [tenant?.firstName, tenant?.lastName].filter(Boolean).join(" ") || tenant?.username || "";
    const pdf = await reportPdf(report, { title: "Performance report", tenantName, channelName: channel?.name, brandColor: cfg.siteBaseColor ?? undefined });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.pdf"`);
    res.send(pdf);
  }
  await activityRepository.record(req, req.user!.id, "report_exported", { type: "report" }, { format, section: section ?? "all", from: q.from, to: q.to });
}

// --- Schedules -------------------------------------------------------------------

async function own(req: Request): Promise<ReportSchedule> {
  const s = await reportSchedulesRepository.find(req.params.id);
  if (!s || s.userId !== requireTenantId(req.user)) throw notFound("Scheduled report");
  return s;
}

export async function listSchedules(req: Request, res: Response) {
  res.json({ data: await reportSchedulesRepository.list(requireTenantId(req.user)) });
}

export async function createSchedule(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(reportScheduleSchema, req);
  if (input.channelId) await assertChannelAccess(req.user!, input.channelId);
  if ((await reportSchedulesRepository.list(tenantId)).length >= MAX_SCHEDULES) throw conflict(`You can have up to ${MAX_SCHEDULES} scheduled reports.`, "LIMIT_REACHED");
  const s = await reportSchedulesRepository.create({ ...input, recipients: [...new Set(input.recipients)], channelId: input.channelId ?? null, userId: tenantId, createdBy: req.user!.id, nextRunAt: await computeNextRun(input, tenantId) });
  await activityRepository.record(req, req.user!.id, "report_schedule_created", { type: "report_schedule", id: s.id });
  res.status(201).json({ data: s });
}

export async function updateSchedule(req: Request, res: Response) {
  const s = await own(req);
  const input = parseBody(reportScheduleSchema, req);
  if (input.channelId) await assertChannelAccess(req.user!, input.channelId);
  const updated = await reportSchedulesRepository.update(s.id, { ...input, recipients: [...new Set(input.recipients)], channelId: input.channelId ?? null, nextRunAt: await computeNextRun(input, s.userId) });
  res.json({ data: updated });
}

export async function deleteSchedule(req: Request, res: Response) {
  const s = await own(req);
  await reportSchedulesRepository.delete(s.id);
  res.json({ success: true });
}

/** POST /api/reports/schedules/:id/send — sends the latest period now (doesn't move the schedule). */
export async function sendNow(req: Request, res: Response) {
  const s = await own(req);
  const status = await sendScheduledReport(s);
  res.json({ data: { status }, success: !status.startsWith("failed") });
}
