import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { smsCampaignRecipients, smsCampaigns, smsGateways, type SmsCampaign, type SmsGateway, type SmsRecipient } from "@shared/schema";
import { encryptSecret } from "../lib/crypto";

type NewCampaign = typeof smsCampaigns.$inferInsert;
type Counter = "sentCount" | "deliveredCount" | "failedCount";


/** A recipient "processing" longer than this was abandoned (crash mid-send) and is retried. */
export const STALE_CLAIM_MS = 10 * 60_000;
export const smsGatewayRepository = {
  async get(userId: string): Promise<SmsGateway | undefined> {
    const [row] = await db.select().from(smsGateways).where(eq(smsGateways.userId, userId)).orderBy(desc(smsGateways.updatedAt)).limit(1);
    return row;
  },

  async find(id: string): Promise<SmsGateway | undefined> {
    const [row] = await db.select().from(smsGateways).where(eq(smsGateways.id, id)).limit(1);
    return row;
  },

  async upsert(
    userId: string,
    v: { provider: string; accountSid?: string | null; authToken?: string; fromNumber?: string | null; senderId?: string | null },
  ): Promise<SmsGateway> {
    const existing = await this.get(userId);
    const values = {
      provider: v.provider,
      accountSid: v.accountSid ?? null,
      fromNumber: v.fromNumber || null,
      senderId: v.senderId || null,
      isActive: true,
      ...(v.authToken ? { authToken: encryptSecret(v.authToken) } : {}),
    };
    if (existing) {
      // Switching provider without a new secret clears the old provider's secret.
      const clearToken = existing.provider !== v.provider && !v.authToken ? { authToken: null } : {};
      await db.update(smsGateways).set({ ...values, ...clearToken }).where(eq(smsGateways.id, existing.id));
    } else {
      await db.insert(smsGateways).values({ id: randomUUID(), userId, ...values });
    }
    return (await this.get(userId))!;
  },
};

export const smsCampaignsRepository = {
  async find(id: string): Promise<SmsCampaign | undefined> {
    const [row] = await db.select().from(smsCampaigns).where(eq(smsCampaigns.id, id)).limit(1);
    return row;
  },

  async list(tenantId: string, opts: { page: number; limit: number; status?: string }) {
    const conds: SQL[] = [eq(smsCampaigns.userId, tenantId), isNull(smsCampaigns.automationId)];
    if (opts.status) conds.push(eq(smsCampaigns.status, opts.status));
    const where = and(...conds);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(smsCampaigns)
        .where(where)
        .orderBy(desc(smsCampaigns.createdAt))
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(smsCampaigns).where(where),
    ]);
    return { rows, total };
  },

  async create(values: Omit<NewCampaign, "id">): Promise<SmsCampaign> {
    const id = randomUUID();
    await db.insert(smsCampaigns).values({ ...values, id });
    return (await this.find(id))!;
  },

  async update(id: string, patch: Partial<NewCampaign>): Promise<SmsCampaign | undefined> {
    if (Object.keys(patch).length) await db.update(smsCampaigns).set(patch).where(eq(smsCampaigns.id, id));
    return this.find(id);
  },

  async transition(id: string, from: string[], to: string, extra: Partial<NewCampaign> = {}): Promise<boolean> {
    const [res] = await db
      .update(smsCampaigns)
      .set({ status: to, ...extra })
      .where(and(eq(smsCampaigns.id, id), inArray(smsCampaigns.status, from)));
    return res.affectedRows > 0;
  },

  async increment(id: string, field: Counter, by = 1): Promise<void> {
    await db
      .update(smsCampaigns)
      .set({ [field]: sql`${smsCampaigns[field]} + ${by}` })
      .where(eq(smsCampaigns.id, id));
  },

  async delete(id: string): Promise<void> {
    await db.delete(smsCampaigns).where(eq(smsCampaigns.id, id));
  },

  async dueScheduled(now: Date): Promise<SmsCampaign[]> {
    return db
      .select()
      .from(smsCampaigns)
      .where(and(eq(smsCampaigns.status, "scheduled"), lte(smsCampaigns.scheduledAt, now)));
  },

  async totals(tenantId: string, since: Date) {
    const [row] = await db
      .select({
        campaigns: sql<number>`COALESCE(SUM(${smsCampaigns.automationId} IS NULL),0)`,
        recipients: sql<number>`COALESCE(SUM(${smsCampaigns.totalRecipients}),0)`,
        sent: sql<number>`COALESCE(SUM(${smsCampaigns.sentCount}),0)`,
        delivered: sql<number>`COALESCE(SUM(${smsCampaigns.deliveredCount}),0)`,
        failed: sql<number>`COALESCE(SUM(${smsCampaigns.failedCount}),0)`,
        credits: sql<number>`COALESCE(SUM(${smsCampaigns.estimatedCredits}),0)`,
      })
      .from(smsCampaigns)
      .where(and(eq(smsCampaigns.userId, tenantId), gte(smsCampaigns.createdAt, since)));
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as Record<keyof typeof row, number>;
  },

  // --- Recipients -----------------------------------------------------------

  async insertRecipients(rows: Omit<typeof smsCampaignRecipients.$inferInsert, "id">[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(smsCampaignRecipients).values(rows.slice(i, i + 500).map((r) => ({ ...r, id: randomUUID() })));
    }
  },

  async listRecipients(campaignId: string, opts: { page: number; limit: number; status?: string }) {
    const conds: SQL[] = [eq(smsCampaignRecipients.campaignId, campaignId)];
    if (opts.status) conds.push(eq(smsCampaignRecipients.status, opts.status));
    const where = and(...conds);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(smsCampaignRecipients)
        .where(where)
        .orderBy(desc(smsCampaignRecipients.sentAt), smsCampaignRecipients.phone)
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(smsCampaignRecipients).where(where),
    ]);
    return { rows, total };
  },

  async findRecipientByMessageId(messageId: string): Promise<SmsRecipient | undefined> {
    const [row] = await db.select().from(smsCampaignRecipients).where(eq(smsCampaignRecipients.messageId, messageId)).limit(1);
    return row;
  },

  async updateRecipient(id: string, patch: Partial<SmsRecipient>): Promise<void> {
    await db.update(smsCampaignRecipients).set(patch).where(eq(smsCampaignRecipients.id, id));
  },

  async pendingCount(campaignId: string): Promise<number> {
    const [{ n }] = await db
      .select({ n: count() })
      .from(smsCampaignRecipients)
      .where(and(eq(smsCampaignRecipients.campaignId, campaignId), inArray(smsCampaignRecipients.status, ["pending", "processing", "held"])));
    return n;
  },

  async setPendingStatus(campaignId: string, to: string): Promise<void> {
    await db
      .update(smsCampaignRecipients)
      .set({ status: to })
      .where(and(eq(smsCampaignRecipients.campaignId, campaignId), inArray(smsCampaignRecipients.status, ["pending", "held"])));
  },

  async claim(limit: number): Promise<SmsRecipient[]> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(smsCampaignRecipients)
        .where(
          and(
            eq(smsCampaignRecipients.status, "pending"),
            or(isNull(smsCampaignRecipients.sendAfter), lte(smsCampaignRecipients.sendAfter, sql`CURRENT_TIMESTAMP(3)`)),
            inArray(smsCampaignRecipients.campaignId, tx.select({ id: smsCampaigns.id }).from(smsCampaigns).where(eq(smsCampaigns.status, "sending"))),
          ),
        )
        .orderBy(smsCampaignRecipients.createdAt)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length) {
        await tx
          .update(smsCampaignRecipients)
          .set({ status: "processing", claimedAt: sql`CURRENT_TIMESTAMP(3)` })
          .where(inArray(smsCampaignRecipients.id, rows.map((r) => r.id)));
      }
      return rows;
    });
  },

  async recoverProcessing(): Promise<void> {
    // Only claims older than the stale limit: another server may be sending the rest right now.
    await db
      .update(smsCampaignRecipients)
      .set({ status: "pending", claimedAt: null })
      .where(and(eq(smsCampaignRecipients.status, "processing"), or(isNull(smsCampaignRecipients.claimedAt), lt(smsCampaignRecipients.claimedAt, new Date(Date.now() - STALE_CLAIM_MS)))));
  },
};
