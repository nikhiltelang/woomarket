import { and, count, desc, eq, gte, type SQL } from "drizzle-orm";
import { db } from "../db";
import { supportRequests, users, type SupportRequest } from "@shared/schema";

const reporter = { username: users.username, firstName: users.firstName, lastName: users.lastName, email: users.email, role: users.role };

export const supportRepository = {
  async create(v: { userId: string; type: string; message: string }): Promise<SupportRequest> {
    const [res] = await db.insert(supportRequests).values(v);
    return (await this.find(res.insertId))!;
  },

  async find(id: number): Promise<SupportRequest | undefined> {
    return (await db.select().from(supportRequests).where(eq(supportRequests.id, id)).limit(1))[0];
  },

  listForUser(userId: string) {
    return db.select().from(supportRequests).where(eq(supportRequests.userId, userId)).orderBy(desc(supportRequests.createdAt), desc(supportRequests.id)).limit(200);
  },

  async list(opts: { page: number; limit: number; status?: string; type?: string }) {
    const conds: SQL[] = [];
    if (opts.status) conds.push(eq(supportRequests.status, opts.status));
    if (opts.type) conds.push(eq(supportRequests.type, opts.type));
    const where = conds.length ? and(...conds) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ r: supportRequests, reporter })
        .from(supportRequests)
        .innerJoin(users, eq(users.id, supportRequests.userId))
        .where(where)
        .orderBy(desc(supportRequests.createdAt), desc(supportRequests.id))
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(supportRequests).where(where),
    ]);
    return { rows: rows.map(({ r, reporter }) => ({ ...r, reporter })), total };
  },

  async statusCounts(): Promise<Record<string, number>> {
    const rows = await db.select({ status: supportRequests.status, n: count() }).from(supportRequests).groupBy(supportRequests.status);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  },

  async recentCount(userId: string, since: Date): Promise<number> {
    const [{ n }] = await db
      .select({ n: count() })
      .from(supportRequests)
      .where(and(eq(supportRequests.userId, userId), gte(supportRequests.createdAt, since)));
    return Number(n);
  },

  async update(id: number, patch: Partial<Pick<SupportRequest, "status" | "adminReply" | "repliedAt">>) {
    await db.update(supportRequests).set(patch).where(eq(supportRequests.id, id));
    return this.find(id);
  },
};
