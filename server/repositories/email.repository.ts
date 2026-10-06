import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import {
  emailCampaignRecipients,
  emailCampaigns,
  emailTemplates,
  smtpConfig,
  type EmailCampaign,
  type EmailRecipient,
  type EmailTemplate,
  type SmtpConfig,
} from "@shared/schema";
import { encryptSecret } from "../lib/crypto";

type NewCampaign = typeof emailCampaigns.$inferInsert;
type Counter = "sentCount" | "deliveredCount" | "openedCount" | "clickedCount" | "failedCount";

export const smtpRepository = {
  /** userId = tenant admin id, or null for the platform default. */
  async get(userId: string | null): Promise<SmtpConfig | undefined> {
    const [row] = await db
      .select()
      .from(smtpConfig)
      .where(userId ? eq(smtpConfig.userId, userId) : isNull(smtpConfig.userId))
      .orderBy(desc(smtpConfig.updatedAt))
      .limit(1);
    return row;
  },

  async upsert(
    userId: string | null,
    v: { host: string; port: number; secure: boolean; user: string; password?: string; fromName: string; fromEmail: string },
  ): Promise<SmtpConfig> {
    const existing = await this.get(userId);
    const values = {
      host: v.host,
      port: v.port,
      secure: v.secure,
      user: v.user,
      fromName: v.fromName,
      fromEmail: v.fromEmail,
      ...(v.password ? { password: encryptSecret(v.password) } : {}),
    };
    if (existing) {
      await db.update(smtpConfig).set(values).where(eq(smtpConfig.id, existing.id));
    } else {
      await db.insert(smtpConfig).values({ id: randomUUID(), userId, ...values, password: v.password ? encryptSecret(v.password) : null });
    }
    return (await this.get(userId))!;
  },

  async delete(userId: string | null): Promise<void> {
    await db.delete(smtpConfig).where(userId ? eq(smtpConfig.userId, userId) : isNull(smtpConfig.userId));
  },
};

export const emailTemplatesRepository = {
  /** System templates plus the tenant's own. */
  async list(tenantId: string): Promise<EmailTemplate[]> {
    return db
      .select()
      .from(emailTemplates)
      .where(or(eq(emailTemplates.isSystem, true), eq(emailTemplates.userId, tenantId)))
      .orderBy(desc(emailTemplates.isSystem), desc(emailTemplates.createdAt));
  },
  async find(id: string): Promise<EmailTemplate | undefined> {
    const [row] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, id)).limit(1);
    return row;
  },
  async findSystemByName(name: string): Promise<EmailTemplate | undefined> {
    const [row] = await db
      .select()
      .from(emailTemplates)
      .where(and(eq(emailTemplates.isSystem, true), eq(emailTemplates.name, name)))
      .limit(1);
    return row;
  },
  async create(values: Omit<typeof emailTemplates.$inferInsert, "id">): Promise<EmailTemplate> {
    const id = randomUUID();
    await db.insert(emailTemplates).values({ ...values, id });
    return (await this.find(id))!;
  },
  async update(id: string, patch: Partial<typeof emailTemplates.$inferInsert>): Promise<EmailTemplate | undefined> {
    await db.update(emailTemplates).set(patch).where(eq(emailTemplates.id, id));
    return this.find(id);
  },
  async delete(id: string): Promise<void> {
    await db.delete(emailTemplates).where(eq(emailTemplates.id, id));
  },
};

export const emailCampaignsRepository = {
  async find(id: string): Promise<EmailCampaign | undefined> {
    const [row] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, id)).limit(1);
    return row;
  },

  async list(tenantId: string, opts: { page: number; limit: number; status?: string }) {
    const conds: SQL[] = [eq(emailCampaigns.userId, tenantId)];
    if (opts.status) conds.push(eq(emailCampaigns.status, opts.status));
    const where = and(...conds);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(emailCampaigns)
        .where(where)
        .orderBy(desc(emailCampaigns.createdAt))
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(emailCampaigns).where(where),
    ]);
    return { rows, total };
  },

  async create(values: Omit<NewCampaign, "id">): Promise<EmailCampaign> {
    const id = randomUUID();
    await db.insert(emailCampaigns).values({ ...values, id });
    return (await this.find(id))!;
  },

  async update(id: string, patch: Partial<NewCampaign>): Promise<EmailCampaign | undefined> {
    if (Object.keys(patch).length) await db.update(emailCampaigns).set(patch).where(eq(emailCampaigns.id, id));
    return this.find(id);
  },

  async transition(id: string, from: string[], to: string, extra: Partial<NewCampaign> = {}): Promise<boolean> {
    const [res] = await db
      .update(emailCampaigns)
      .set({ status: to, ...extra })
      .where(and(eq(emailCampaigns.id, id), inArray(emailCampaigns.status, from)));
    return res.affectedRows > 0;
  },

  async increment(id: string, field: Counter, by = 1): Promise<void> {
    await db
      .update(emailCampaigns)
      .set({ [field]: sql`${emailCampaigns[field]} + ${by}` })
      .where(eq(emailCampaigns.id, id));
  },

  async delete(id: string): Promise<void> {
    await db.delete(emailCampaigns).where(eq(emailCampaigns.id, id));
  },

  async dueScheduled(now: Date): Promise<EmailCampaign[]> {
    return db
      .select()
      .from(emailCampaigns)
      .where(and(eq(emailCampaigns.status, "scheduled"), lte(emailCampaigns.scheduledAt, now)));
  },

  async totals(tenantId: string, since: Date) {
    const [row] = await db
      .select({
        campaigns: count(),
        recipients: sql<number>`COALESCE(SUM(${emailCampaigns.totalRecipients}),0)`,
        sent: sql<number>`COALESCE(SUM(${emailCampaigns.sentCount}),0)`,
        delivered: sql<number>`COALESCE(SUM(${emailCampaigns.deliveredCount}),0)`,
        opened: sql<number>`COALESCE(SUM(${emailCampaigns.openedCount}),0)`,
        clicked: sql<number>`COALESCE(SUM(${emailCampaigns.clickedCount}),0)`,
        failed: sql<number>`COALESCE(SUM(${emailCampaigns.failedCount}),0)`,
      })
      .from(emailCampaigns)
      .where(and(eq(emailCampaigns.userId, tenantId), gte(emailCampaigns.createdAt, since)));
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as Record<keyof typeof row, number>;
  },

  // --- Recipients -----------------------------------------------------------

  async insertRecipients(rows: Omit<typeof emailCampaignRecipients.$inferInsert, "id">[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(emailCampaignRecipients).values(rows.slice(i, i + 500).map((r) => ({ ...r, id: randomUUID() })));
    }
  },

  async findRecipient(id: string): Promise<EmailRecipient | undefined> {
    const [row] = await db.select().from(emailCampaignRecipients).where(eq(emailCampaignRecipients.id, id)).limit(1);
    return row;
  },

  async listRecipients(campaignId: string, opts: { page: number; limit: number; status?: string }) {
    const conds: SQL[] = [eq(emailCampaignRecipients.campaignId, campaignId)];
    if (opts.status) conds.push(eq(emailCampaignRecipients.status, opts.status));
    const where = and(...conds);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(emailCampaignRecipients)
        .where(where)
        .orderBy(desc(emailCampaignRecipients.sentAt), emailCampaignRecipients.email)
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(emailCampaignRecipients).where(where),
    ]);
    return { rows, total };
  },

  async updateRecipient(id: string, patch: Partial<EmailRecipient>): Promise<void> {
    await db.update(emailCampaignRecipients).set(patch).where(eq(emailCampaignRecipients.id, id));
  },

  /** Marks the first open; returns true only the first time. */
  async markOpened(id: string): Promise<boolean> {
    const [res] = await db
      .update(emailCampaignRecipients)
      .set({ openedAt: new Date() })
      .where(and(eq(emailCampaignRecipients.id, id), isNull(emailCampaignRecipients.openedAt)));
    return res.affectedRows > 0;
  },

  async pendingCount(campaignId: string): Promise<number> {
    const [{ n }] = await db
      .select({ n: count() })
      .from(emailCampaignRecipients)
      .where(and(eq(emailCampaignRecipients.campaignId, campaignId), inArray(emailCampaignRecipients.status, ["pending", "processing"])));
    return n;
  },

  async setPendingStatus(campaignId: string, to: string): Promise<void> {
    await db
      .update(emailCampaignRecipients)
      .set({ status: to })
      .where(and(eq(emailCampaignRecipients.campaignId, campaignId), eq(emailCampaignRecipients.status, "pending")));
  },

  /** Claims pending recipients of campaigns that are currently sending. */
  async claim(limit: number): Promise<EmailRecipient[]> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(emailCampaignRecipients)
        .where(
          and(
            eq(emailCampaignRecipients.status, "pending"),
            inArray(emailCampaignRecipients.campaignId, tx.select({ id: emailCampaigns.id }).from(emailCampaigns).where(eq(emailCampaigns.status, "sending"))),
          ),
        )
        .orderBy(emailCampaignRecipients.createdAt)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length) {
        await tx
          .update(emailCampaignRecipients)
          .set({ status: "processing" })
          .where(inArray(emailCampaignRecipients.id, rows.map((r) => r.id)));
      }
      return rows;
    });
  },

  /** Returns rows stuck in processing (crash mid-send) to pending. */
  async recoverProcessing(): Promise<void> {
    await db.update(emailCampaignRecipients).set({ status: "pending" }).where(eq(emailCampaignRecipients.status, "processing"));
  },
};
