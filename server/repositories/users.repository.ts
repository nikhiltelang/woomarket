import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { users, type InsertUser, type User } from "@shared/schema";
import type { PublicUser } from "@shared/api-types";
import type { Role } from "@shared/roles";
import type { AuthUser } from "../types";
import { likePattern } from "../lib/http";

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role as Role,
    status: u.status,
    permissions: u.permissions ?? [],
    phone: u.phone,
    avatar: u.avatar,
    createdBy: u.createdBy,
    lastLogin: u.lastLogin?.toISOString() ?? null,
    createdAt: u.createdAt?.toISOString() ?? null,
    isEmailVerified: Boolean(u.isEmailVerified),
    isMobileVerified: Boolean(u.isMobileVerified),
    accessLevel: u.accessLevel ?? null,
  };
}

export function toAuthUser(u: User): AuthUser {
  const role = u.role as Role;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role,
    permissions: u.permissions ?? [],
    createdBy: u.createdBy,
    tenantId: role === "admin" ? u.id : role === "team" ? u.createdBy : null,
  };
}

export const USER_SEGMENTS = ["all", "active", "banned", "email-unverified", "mobile-unverified", "with-subscription"] as const;
export type UserSegment = (typeof USER_SEGMENTS)[number];

// Explicit aliases so the correlation can't bind to the subquery's own columns.
const activeSubscription = sql`EXISTS (SELECT 1 FROM \`subscriptions\` s WHERE s.\`user_id\` = \`users\`.\`id\` AND s.\`status\` = 'active' AND s.\`end_date\` >= NOW(3))`;

/** Filters behind the superadmin "Manage Users" sub-menu. */
function segmentCondition(segment: UserSegment): SQL {
  switch (segment) {
    case "active":
      return eq(users.status, "active");
    case "banned":
      return eq(users.status, "banned");
    case "email-unverified":
      return sql`COALESCE(${users.isEmailVerified}, 0) = 0`;
    case "mobile-unverified":
      return sql`${users.phone} IS NOT NULL AND ${users.phone} <> '' AND COALESCE(${users.isMobileVerified}, 0) = 0`;
    case "with-subscription":
      return activeSubscription;
    default:
      return sql`1 = 1`;
  }
}

export const usersRepository = {
  async findById(id: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  },

  async findByLogin(login: string): Promise<User | undefined> {
    const [row] = await db
      .select()
      .from(users)
      .where(or(eq(users.username, login), eq(users.email, login.toLowerCase())))
      .limit(1);
    return row;
  },

  async existsUsernameOrEmail(username: string, email: string, exceptId?: string) {
    const rows = await db
      .select({ id: users.id, username: users.username, email: users.email })
      .from(users)
      .where(or(eq(users.username, username), eq(users.email, email)));
    const others = rows.filter((r) => r.id !== exceptId);
    return {
      username: others.some((r) => r.username === username),
      email: others.some((r) => r.email === email),
    };
  },

  async create(values: Omit<InsertUser, "id">): Promise<User> {
    const id = randomUUID();
    await db.insert(users).values({ ...values, id });
    return (await this.findById(id))!;
  },

  async update(id: string, patch: Partial<InsertUser>): Promise<User | undefined> {
    if (Object.keys(patch).length) await db.update(users).set(patch).where(eq(users.id, id));
    return this.findById(id);
  },

  async delete(id: string): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
  },

  async setStatusBulk(ids: string[], status: string): Promise<number> {
    const [res] = await db.update(users).set({ status }).where(inArray(users.id, ids));
    return res.affectedRows;
  },

  async list(opts: {
    page: number;
    limit: number;
    search?: string;
    role?: string;
    status?: string;
    createdBy?: string;
    segment?: UserSegment;
    accessLevel?: number;
  }): Promise<{ rows: User[]; total: number }> {
    const conds: SQL[] = [];
    if (opts.segment) conds.push(segmentCondition(opts.segment));
    if (opts.accessLevel !== undefined) conds.push(eq(users.accessLevel, opts.accessLevel));
    if (opts.search) {
      const p = likePattern(opts.search);
      conds.push(or(like(users.username, p), like(users.email, p), like(users.firstName, p), like(users.lastName, p))!);
    }
    if (opts.role) conds.push(eq(users.role, opts.role));
    if (opts.status) conds.push(eq(users.status, opts.status));
    if (opts.createdBy) conds.push(eq(users.createdBy, opts.createdBy));
    const where = conds.length ? and(...conds) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(users).where(where),
    ]);
    return { rows, total };
  },

  async countTeamMembers(adminId: string): Promise<number> {
    const [{ n }] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.createdBy, adminId), eq(users.role, "team")));
    return n;
  },

  async segmentCounts(): Promise<Record<UserSegment, number>> {
    const entries = await Promise.all(
      USER_SEGMENTS.map(async (seg) => {
        const [{ n }] = await db.select({ n: count() }).from(users).where(segmentCondition(seg));
        return [seg, n] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<UserSegment, number>;
  },

  async signupsByDay(from: Date, to: Date) {
    const rows = await db
      .select({ day: sql<string>`DATE(${users.createdAt})`, n: count() })
      .from(users)
      .where(and(sql`${users.createdAt} >= ${from}`, sql`${users.createdAt} < ${to}`))
      .groupBy(sql`DATE(${users.createdAt})`);
    return rows.map((r) => ({ day: String(r.day).slice(0, 10), count: r.n }));
  },

  async countByRole(): Promise<Record<string, number>> {
    const rows = await db.select({ role: users.role, n: count() }).from(users).groupBy(users.role);
    return Object.fromEntries(rows.map((r) => [r.role, r.n]));
  },

  async touchLastLogin(id: string): Promise<void> {
    await db.update(users).set({ lastLogin: sql`CURRENT_TIMESTAMP(3)` }).where(eq(users.id, id));
  },
};
