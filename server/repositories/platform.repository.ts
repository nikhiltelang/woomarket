import { randomInt, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  cronJobLogs,
  notifications,
  otpVerifications,
  panelConfig,
  platformAccessLevels,
  platformLanguages,
  policyPages,
  sentNotifications,
  systemConfigurations,
  users,
  type AccessLevel,
  type PanelConfig,
  type PlatformLanguage,
  type PolicyPage,
  type SystemConfig,
} from "@shared/schema";
import { config } from "../config";

// ---------------------------------------------------------------------------
// System configuration (single row, id = 'default') and branding
// ---------------------------------------------------------------------------

export const systemConfigRepository = {
  async get(): Promise<SystemConfig> {
    const [row] = await db.select().from(systemConfigurations).where(eq(systemConfigurations.id, "default")).limit(1);
    if (row) return row;
    await db.insert(systemConfigurations).ignore().values({ id: "default", siteTitle: config.APP_NAME });
    const [created] = await db.select().from(systemConfigurations).where(eq(systemConfigurations.id, "default")).limit(1);
    return created;
  },
  async update(patch: Partial<typeof systemConfigurations.$inferInsert>): Promise<SystemConfig> {
    await this.get();
    if (Object.keys(patch).length) await db.update(systemConfigurations).set(patch).where(eq(systemConfigurations.id, "default"));
    return this.get();
  },
};

export const panelRepository = {
  async get(): Promise<PanelConfig> {
    const [row] = await db.select().from(panelConfig).orderBy(asc(panelConfig.createdAt)).limit(1);
    if (row) return row;
    const id = randomUUID();
    await db.insert(panelConfig).values({ id, name: config.APP_NAME, tagline: "WhatsApp marketing, CRM and team inbox" });
    return (await db.select().from(panelConfig).where(eq(panelConfig.id, id)))[0];
  },
  async update(patch: Partial<typeof panelConfig.$inferInsert>): Promise<PanelConfig> {
    const row = await this.get();
    if (Object.keys(patch).length) await db.update(panelConfig).set(patch).where(eq(panelConfig.id, row.id));
    return this.get();
  },
};

// ---------------------------------------------------------------------------
// Policy pages
// ---------------------------------------------------------------------------

export const policyRepository = {
  list: (): Promise<PolicyPage[]> => db.select().from(policyPages).orderBy(asc(policyPages.title)),
  listPublished: () =>
    db
      .select({ title: policyPages.title, slug: policyPages.slug })
      .from(policyPages)
      .where(eq(policyPages.isPublished, true))
      .orderBy(asc(policyPages.title)),
  async find(id: string) {
    return (await db.select().from(policyPages).where(eq(policyPages.id, id)).limit(1))[0];
  },
  async findBySlug(slug: string) {
    return (await db.select().from(policyPages).where(eq(policyPages.slug, slug)).limit(1))[0];
  },
  async create(v: Omit<typeof policyPages.$inferInsert, "id">) {
    const id = randomUUID();
    await db.insert(policyPages).values({ ...v, id });
    return (await this.find(id))!;
  },
  async update(id: string, patch: Partial<typeof policyPages.$inferInsert>) {
    await db.update(policyPages).set(patch).where(eq(policyPages.id, id));
    return this.find(id);
  },
  delete: (id: string) => db.delete(policyPages).where(eq(policyPages.id, id)),
};

// ---------------------------------------------------------------------------
// Cron job logs
// ---------------------------------------------------------------------------

export const cronLogRepository = {
  async record(v: { jobKey: string; jobName: string; status: "success" | "failed"; message?: string | null; durationMs: number }) {
    await db.insert(cronJobLogs).values({ id: randomUUID(), ...v, message: v.message?.slice(0, 2000) ?? null });
  },
  async latest(jobKey: string, limit = 10) {
    return db.select().from(cronJobLogs).where(eq(cronJobLogs.jobKey, jobKey)).orderBy(desc(cronJobLogs.executedAt)).limit(limit);
  },
  /** Keeps the log bounded. */
  async prune(olderThanDays = 30) {
    await db.delete(cronJobLogs).where(sql`${cronJobLogs.executedAt} < NOW(3) - INTERVAL ${olderThanDays} DAY`);
  },
};

// ---------------------------------------------------------------------------
// Access levels
// ---------------------------------------------------------------------------

export const levelsRepository = {
  list: (): Promise<AccessLevel[]> => db.select().from(platformAccessLevels).orderBy(asc(platformAccessLevels.levelNumber)),
  async find(id: string) {
    return (await db.select().from(platformAccessLevels).where(eq(platformAccessLevels.id, id)).limit(1))[0];
  },
  async findByNumber(n: number) {
    return (await db.select().from(platformAccessLevels).where(eq(platformAccessLevels.levelNumber, n)).limit(1))[0];
  },
  async lowest() {
    return (await db.select().from(platformAccessLevels).orderBy(asc(platformAccessLevels.levelNumber)).limit(1))[0];
  },
  async create(v: Omit<typeof platformAccessLevels.$inferInsert, "id">) {
    const id = randomUUID();
    await db.insert(platformAccessLevels).values({ ...v, id });
    return (await this.find(id))!;
  },
  async update(id: string, patch: Partial<typeof platformAccessLevels.$inferInsert>) {
    await db.update(platformAccessLevels).set(patch).where(eq(platformAccessLevels.id, id));
    return this.find(id);
  },
  delete: (id: string) => db.delete(platformAccessLevels).where(eq(platformAccessLevels.id, id)),
  async userCounts(): Promise<Record<number, number>> {
    const rows = await db.select({ level: users.accessLevel, n: count() }).from(users).groupBy(users.accessLevel);
    return Object.fromEntries(rows.filter((r) => r.level !== null).map((r) => [r.level!, r.n]));
  },
  /** Moves users off a level number (e.g. when it is renumbered or deleted). */
  async reassign(from: number, to: number | null) {
    await db.update(users).set({ accessLevel: to }).where(eq(users.accessLevel, from));
  },
};

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

export const languagesRepository = {
  list: (): Promise<PlatformLanguage[]> => db.select().from(platformLanguages).orderBy(asc(platformLanguages.sortOrder), asc(platformLanguages.name)),
  listEnabled: () =>
    db
      .select({ code: platformLanguages.code, name: platformLanguages.name, nativeName: platformLanguages.nativeName, icon: platformLanguages.icon, direction: platformLanguages.direction, isDefault: platformLanguages.isDefault })
      .from(platformLanguages)
      .where(eq(platformLanguages.isEnabled, true))
      .orderBy(asc(platformLanguages.sortOrder), asc(platformLanguages.name)),
  async find(id: string) {
    return (await db.select().from(platformLanguages).where(eq(platformLanguages.id, id)).limit(1))[0];
  },
  async findByCode(code: string) {
    return (await db.select().from(platformLanguages).where(eq(platformLanguages.code, code)).limit(1))[0];
  },
  async create(v: Omit<typeof platformLanguages.$inferInsert, "id">) {
    const id = randomUUID();
    await db.insert(platformLanguages).values({ ...v, id });
    return (await this.find(id))!;
  },
  async update(id: string, patch: Partial<typeof platformLanguages.$inferInsert>) {
    await db.update(platformLanguages).set(patch).where(eq(platformLanguages.id, id));
    return this.find(id);
  },
  async setDefault(id: string) {
    await db.transaction(async (tx) => {
      await tx.update(platformLanguages).set({ isDefault: false });
      await tx.update(platformLanguages).set({ isDefault: true, isEnabled: true }).where(eq(platformLanguages.id, id));
    });
  },
  delete: (id: string) => db.delete(platformLanguages).where(eq(platformLanguages.id, id)),
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationsRepository = {
  async create(v: Omit<typeof notifications.$inferInsert, "id">) {
    const [res] = await db.insert(notifications).values(v);
    return (await this.find(res.insertId))!;
  },
  async find(id: number) {
    return (await db.select().from(notifications).where(eq(notifications.id, id)).limit(1))[0];
  },
  async list(page: number, limit: number) {
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          n: notifications,
          // Explicit aliases: unqualified column names inside a select-list subquery would bind to the inner table.
          recipients: sql<number>`(SELECT COUNT(*) FROM \`sent_notifications\` sn WHERE sn.\`notification_id\` = \`notifications\`.\`id\`)`,
          reads: sql<number>`(SELECT COUNT(*) FROM \`sent_notifications\` sn WHERE sn.\`notification_id\` = \`notifications\`.\`id\` AND sn.\`is_read\` = 1)`,
        })
        .from(notifications)
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(notifications),
    ]);
    return { rows: rows.map((r) => ({ ...r.n, recipients: Number(r.recipients), reads: Number(r.reads) })), total };
  },
  async markSent(id: number) {
    await db.update(notifications).set({ status: "sent", sentAt: new Date() }).where(eq(notifications.id, id));
  },
  async deliver(notificationId: number, userIds: string[]) {
    for (let i = 0; i < userIds.length; i += 500) {
      await db.insert(sentNotifications).values(userIds.slice(i, i + 500).map((userId) => ({ notificationId, userId })));
    }
  },
  delete: (id: number) => db.delete(notifications).where(eq(notifications.id, id)),

  async listForUser(userId: string, page: number, limit: number) {
    const where = eq(sentNotifications.userId, userId);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ id: sentNotifications.id, isRead: sentNotifications.isRead, sentAt: sentNotifications.sentAt, title: notifications.title, message: notifications.message, type: notifications.type })
        .from(sentNotifications)
        .innerJoin(notifications, eq(notifications.id, sentNotifications.notificationId))
        .where(where)
        .orderBy(desc(sentNotifications.sentAt), desc(sentNotifications.id))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(sentNotifications).where(where),
    ]);
    return { rows, total };
  },
  async unreadCount(userId: string) {
    const [{ n }] = await db.select({ n: count() }).from(sentNotifications).where(and(eq(sentNotifications.userId, userId), eq(sentNotifications.isRead, false)));
    return n;
  },
  async markRead(userId: string, sentId: number) {
    const [res] = await db.update(sentNotifications).set({ isRead: true, readAt: new Date() }).where(and(eq(sentNotifications.id, sentId), eq(sentNotifications.userId, userId)));
    return res.affectedRows > 0;
  },
  async markAllRead(userId: string) {
    await db.update(sentNotifications).set({ isRead: true, readAt: new Date() }).where(and(eq(sentNotifications.userId, userId), eq(sentNotifications.isRead, false)));
  },
};

// ---------------------------------------------------------------------------
// One-time codes (email verification)
// ---------------------------------------------------------------------------

const OTP_TTL_MS = 10 * 60 * 1000;

export const otpRepository = {
  /** Issues a fresh 6-digit code and invalidates earlier ones for the user. */
  async issue(userId: string): Promise<string> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.update(otpVerifications).set({ isUsed: true }).where(and(eq(otpVerifications.userId, userId), eq(otpVerifications.isUsed, false)));
    await db.insert(otpVerifications).values({ id: randomUUID(), userId, otpCode: code, expiresAt: new Date(Date.now() + OTP_TTL_MS) });
    return code;
  },
  /** Consumes a valid code; returns false for wrong, used or expired codes. */
  async consume(userId: string, code: string): Promise<boolean> {
    const [res] = await db
      .update(otpVerifications)
      .set({ isUsed: true })
      .where(and(eq(otpVerifications.userId, userId), eq(otpVerifications.otpCode, code), eq(otpVerifications.isUsed, false), gt(otpVerifications.expiresAt, new Date())));
    return res.affectedRows > 0;
  },
  async recentCount(userId: string, withinMs: number): Promise<number> {
    const [{ n }] = await db
      .select({ n: count() })
      .from(otpVerifications)
      .where(and(eq(otpVerifications.userId, userId), gt(otpVerifications.createdAt, new Date(Date.now() - withinMs))));
    return n;
  },
};

