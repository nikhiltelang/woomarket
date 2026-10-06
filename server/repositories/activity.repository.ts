import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { count, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "../db";
import { userActivityLogs, users } from "@shared/schema";
import { childLogger } from "../lib/logger";

const log = childLogger("activity");

export const activityRepository = {
  /** Records an audit entry. Never throws: auditing must not break the request. */
  async record(
    req: Request | null,
    userId: string,
    action: string,
    entity?: { type: string; id?: string | null },
    details: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await db.insert(userActivityLogs).values({
        id: randomUUID(),
        userId,
        action,
        entityType: entity?.type ?? null,
        entityId: entity?.id ?? null,
        details,
        ipAddress: req?.ip ?? null,
        userAgent: req?.get("user-agent")?.slice(0, 500) ?? null,
      });
    } catch (err) {
      log.warn({ err: (err as Error).message, action }, "Failed to write activity log");
    }
  },

  /** Activity of a tenant: the admin and their team members. */
  async listForTenant(tenantId: string, page: number, limit: number) {
    const members = await db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.id, tenantId), eq(users.createdBy, tenantId)));
    const ids = members.map((m) => m.id);
    const where = inArray(userActivityLogs.userId, ids.length ? ids : [tenantId]);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ log: userActivityLogs, username: users.username })
        .from(userActivityLogs)
        .leftJoin(users, eq(users.id, userActivityLogs.userId))
        .where(where)
        .orderBy(desc(userActivityLogs.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(userActivityLogs).where(where),
    ]);
    return { rows: rows.map((r) => ({ ...r.log, username: r.username })), total };
  },
};
