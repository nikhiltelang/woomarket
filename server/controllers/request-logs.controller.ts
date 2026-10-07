import type { Request, Response } from "express";
import { z } from "zod";
import { paginationQuery } from "@shared/validation";
import { paginated, parseBody, parseQuery } from "../lib/http";
import { notFound } from "../lib/errors";
import { activityRepository } from "../repositories/activity.repository";
import { requestLogsRepository } from "../repositories/request-logs.repository";
import { flushRequestLogs, pendingRequestLogs, requestLogSettings } from "../services/request-log.service";

const filtersQuery = z.object({
  search: z.string().trim().max(200).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]).optional(),
  status: z
    .string()
    .trim()
    .regex(/^([1-5]xx|[1-5]\d\d)$/, "Use 2xx–5xx or an exact code")
    .optional(),
  user: z.string().trim().max(255).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minDurationMs: z.coerce.number().min(0).max(3_600_000).optional(),
});
const listQuery = paginationQuery.merge(filtersQuery);

/** GET /api/superadmin/request-logs */
export async function list(req: Request, res: Response) {
  const { page, limit, ...filters } = parseQuery(listQuery, req);
  const { rows, total } = await requestLogsRepository.list(filters, page, limit);
  res.json(paginated(rows, total, page, limit));
}

/** GET /api/superadmin/request-logs/stats — totals for the current filters. */
export async function stats(req: Request, res: Response) {
  const [data, settings] = await Promise.all([requestLogsRepository.stats(parseQuery(filtersQuery, req)), requestLogSettings()]);
  res.json({ data: { ...data, pending: pendingRequestLogs() }, settings });
}

/** GET /api/superadmin/request-logs/:id — one entry with headers and bodies. */
export async function get(req: Request, res: Response) {
  const row = await requestLogsRepository.find(Number(req.params.id));
  if (!row) throw notFound("Log entry");
  res.json({ data: row });
}

const clearSchema = z.object({ olderThanDays: z.coerce.number().int().min(0).max(365).default(0) });

/** POST /api/superadmin/request-logs/clear — everything, or entries older than N days. */
export async function clear(req: Request, res: Response) {
  const { olderThanDays } = parseBody(clearSchema, req);
  await flushRequestLogs();
  let removed: number | "all";
  if (olderThanDays === 0) {
    await requestLogsRepository.deleteAll();
    removed = "all";
  } else {
    removed = await requestLogsRepository.deleteOlderThan(new Date(Date.now() - olderThanDays * 86400_000));
  }
  await activityRepository.record(req, req.user!.id, "request_logs_cleared", { type: "system", id: "request_logs" }, { olderThanDays });
  res.json({ data: { removed } });
}
