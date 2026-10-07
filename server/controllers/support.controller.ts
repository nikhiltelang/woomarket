import type { Request, Response } from "express";
import { z } from "zod";
import { SUPPORT_STATUSES, supportRequestSchema, supportUpdateSchema } from "@shared/platform";
import { paginationQuery } from "@shared/validation";
import { paginated, parseBody, parseQuery } from "../lib/http";
import { notFound, AppError } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { supportRepository } from "../repositories/support.repository";
import { sendNotification } from "../services/notification.service";

const log = childLogger("support");
const HOURLY_LIMIT = 10;
const TYPE_LABEL: Record<string, string> = { bug: "Bug report", support: "Support request" };
const STATUS_LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };
const excerpt = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Notifications are a courtesy; a delivery failure never fails the request itself. */
const notify = (input: Parameters<typeof sendNotification>[0], by: string) =>
  sendNotification(input, by).catch((err) => log.warn({ err: (err as Error).message }, "Support notification failed"));

export async function mine(req: Request, res: Response) {
  res.json({ data: await supportRepository.listForUser(req.user!.id) });
}

export async function create(req: Request, res: Response) {
  const input = parseBody(supportRequestSchema, req);
  if ((await supportRepository.recentCount(req.user!.id, new Date(Date.now() - 3600_000))) >= HOURLY_LIMIT) {
    throw new AppError(429, "You've sent several requests in the last hour. Please wait before sending another.", "RATE_LIMITED");
  }
  const row = await supportRepository.create({ userId: req.user!.id, ...input });
  void notify(
    {
      title: `New ${TYPE_LABEL[input.type].toLowerCase()} from ${req.user!.username}`,
      message: excerpt(input.message),
      type: "general",
      targetType: "superadmins",
      targetIds: [],
      viaInApp: true,
      viaEmail: false,
    },
    req.user!.id,
  );
  res.status(201).json({ data: row });
}

const listQuery = paginationQuery.extend({
  status: z.enum(SUPPORT_STATUSES).optional(),
  type: z.enum(["bug", "support"]).optional(),
});

export async function list(req: Request, res: Response) {
  const q = parseQuery(listQuery, req);
  const { rows, total } = await supportRepository.list(q);
  res.json(paginated(rows, total, q.page, q.limit));
}

export async function counts(_req: Request, res: Response) {
  res.json({ data: await supportRepository.statusCounts() });
}

export async function update(req: Request, res: Response) {
  const row = await supportRepository.find(Number(req.params.id));
  if (!row) throw notFound("Request");
  const input = parseBody(supportUpdateSchema, req);
  const reply = input.reply?.trim() || null;
  const replyChanged = reply !== (row.adminReply ?? null);
  const updated = await supportRepository.update(row.id, {
    status: input.status,
    adminReply: reply,
    ...(replyChanged && reply ? { repliedAt: new Date() } : {}),
  });
  if (input.status !== row.status || (replyChanged && reply)) {
    void notify(
      {
        title: `${TYPE_LABEL[row.type]} #${row.id}: ${STATUS_LABEL[input.status]}`,
        message: reply ? excerpt(reply, 500) : `Your ${TYPE_LABEL[row.type].toLowerCase()} is now ${STATUS_LABEL[input.status].toLowerCase()}.`,
        type: "general",
        targetType: "users",
        targetIds: [row.userId],
        viaInApp: true,
        viaEmail: false,
      },
      req.user!.id,
    );
  }
  res.json({ data: updated });
}
