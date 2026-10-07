import { and, avg, count, desc, eq, gte, like, lt, lte, max, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { likePattern } from "../lib/http";
import { requestLogs, type RequestLog } from "@shared/schema";

export type NewRequestLog = Omit<typeof requestLogs.$inferInsert, "id">;

export interface RequestLogFilters {
  search?: string;
  method?: string;
  /** "2xx" | "3xx" | "4xx" | "5xx" | an exact code. */
  status?: string;
  user?: string;
  from?: Date;
  to?: Date;
  minDurationMs?: number;
}

function where(f: RequestLogFilters): SQL | undefined {
  const c: SQL[] = [];
  if (f.search) {
    const p = likePattern(f.search);
    c.push(or(like(requestLogs.path, p), eq(requestLogs.requestId, f.search), eq(requestLogs.ip, f.search))!);
  }
  if (f.method) c.push(eq(requestLogs.method, f.method));
  if (f.status) {
    const cls = /^([1-5])xx$/.exec(f.status);
    if (cls) {
      const lo = Number(cls[1]) * 100;
      c.push(gte(requestLogs.statusCode, lo), lt(requestLogs.statusCode, lo + 100));
    } else c.push(eq(requestLogs.statusCode, Number(f.status)));
  }
  if (f.user) c.push(or(like(requestLogs.username, likePattern(f.user)), eq(requestLogs.userId, f.user))!);
  if (f.from) c.push(gte(requestLogs.requestedAt, f.from));
  if (f.to) c.push(lte(requestLogs.requestedAt, f.to));
  if (f.minDurationMs) c.push(gte(requestLogs.durationMs, f.minDurationMs));
  return c.length ? and(...c) : undefined;
}

// The list leaves out headers and bodies; the detail view loads them.
const summary = {
  id: requestLogs.id,
  requestId: requestLogs.requestId,
  method: requestLogs.method,
  path: requestLogs.path,
  statusCode: requestLogs.statusCode,
  aborted: requestLogs.aborted,
  userId: requestLogs.userId,
  username: requestLogs.username,
  role: requestLogs.role,
  ip: requestLogs.ip,
  requestSize: requestLogs.requestSize,
  responseSize: requestLogs.responseSize,
  requestedAt: requestLogs.requestedAt,
  respondedAt: requestLogs.respondedAt,
  durationMs: requestLogs.durationMs,
};

export const requestLogsRepository = {
  async insertMany(rows: NewRequestLog[]): Promise<void> {
    if (rows.length) await db.insert(requestLogs).values(rows);
  },

  async list(f: RequestLogFilters, page: number, limit: number) {
    const w = where(f);
    const [rows, [{ total }]] = await Promise.all([
      db.select(summary).from(requestLogs).where(w).orderBy(desc(requestLogs.id)).limit(limit).offset((page - 1) * limit),
      db.select({ total: count() }).from(requestLogs).where(w),
    ]);
    return { rows, total };
  },

  async find(id: number): Promise<RequestLog | undefined> {
    return (await db.select().from(requestLogs).where(eq(requestLogs.id, id)).limit(1))[0];
  },

  async stats(f: RequestLogFilters) {
    const [row] = await db
      .select({
        total: count(),
        clientErrors: sql<number>`SUM(${requestLogs.statusCode} BETWEEN 400 AND 499)`,
        serverErrors: sql<number>`SUM(${requestLogs.statusCode} >= 500)`,
        avgMs: avg(requestLogs.durationMs),
        maxMs: max(requestLogs.durationMs),
      })
      .from(requestLogs)
      .where(where(f));
    return {
      total: Number(row.total),
      clientErrors: Number(row.clientErrors ?? 0),
      serverErrors: Number(row.serverErrors ?? 0),
      avgMs: row.avgMs === null ? 0 : Math.round(Number(row.avgMs) * 10) / 10,
      maxMs: row.maxMs === null ? 0 : Math.round(Number(row.maxMs) * 10) / 10,
    };
  },

  /** Deletes in batches so a large purge never holds a long lock. */
  async deleteOlderThan(cutoff: Date, batch = 5000): Promise<number> {
    let removed = 0;
    for (;;) {
      const [res] = await db.execute(sql`DELETE FROM ${requestLogs} WHERE ${requestLogs.requestedAt} < ${cutoff} LIMIT ${batch}`);
      const n = Number((res as { affectedRows?: number }).affectedRows ?? 0);
      removed += n;
      if (n < batch) return removed;
    }
  },

  async deleteAll(): Promise<void> {
    await db.execute(sql`TRUNCATE TABLE ${requestLogs}`);
  },
};
