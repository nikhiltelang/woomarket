import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { campaignRecipients, campaigns, messageQueue, type Campaign, type CampaignRecipient } from "@shared/schema";

type NewCampaign = typeof campaigns.$inferInsert;
type CounterField = "sentCount" | "deliveredCount" | "readCount" | "repliedCount" | "failedCount";

export const campaignsRepository = {
  async findById(id: string): Promise<Campaign | undefined> {
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    return row;
  },

  async list(channelId: string, opts: { page: number; limit: number; status?: string }) {
    const conds: SQL[] = [eq(campaigns.channelId, channelId), isNull(campaigns.automationId)];
    if (opts.status) conds.push(eq(campaigns.status, opts.status));
    const where = and(...conds);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(campaigns)
        .where(where)
        .orderBy(desc(campaigns.createdAt))
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(campaigns).where(where),
    ]);
    return { rows, total };
  },

  async create(values: Omit<NewCampaign, "id">): Promise<Campaign> {
    const id = randomUUID();
    await db.insert(campaigns).values({ ...values, id });
    return (await this.findById(id))!;
  },

  async update(id: string, patch: Partial<NewCampaign>): Promise<Campaign | undefined> {
    if (Object.keys(patch).length) await db.update(campaigns).set(patch).where(eq(campaigns.id, id));
    return this.findById(id);
  },

  /** Conditional status transition; returns false if the campaign was not in an allowed state. */
  async transition(id: string, from: string[], to: string, extra: Partial<NewCampaign> = {}): Promise<boolean> {
    const [res] = await db
      .update(campaigns)
      .set({ status: to, ...extra })
      .where(and(eq(campaigns.id, id), inArray(campaigns.status, from)));
    return res.affectedRows > 0;
  },

  async increment(id: string, field: CounterField, by = 1): Promise<void> {
    const col = campaigns[field];
    await db
      .update(campaigns)
      .set({ [field]: sql`${col} + ${by}` })
      .where(eq(campaigns.id, id));
  },

  async delete(id: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(messageQueue).where(eq(messageQueue.campaignId, id));
      await tx.delete(campaigns).where(eq(campaigns.id, id));
    });
  },

  async dueScheduled(now: Date): Promise<Campaign[]> {
    return db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.status, "scheduled"), lte(campaigns.scheduledAt, now)));
  },

  async countActive(): Promise<number> {
    const [{ n }] = await db
      .select({ n: count() })
      .from(campaigns)
      .where(inArray(campaigns.status, ["running", "scheduled"]));
    return n;
  },

  async countByTenantSince(channelIds: string[], since: Date): Promise<number> {
    if (!channelIds.length) return 0;
    const [{ n }] = await db
      .select({ n: count() })
      .from(campaigns)
      .where(and(inArray(campaigns.channelId, channelIds), isNull(campaigns.automationId), sql`${campaigns.createdAt} >= ${since}`));
    return n;
  },

  // --- Recipients ---------------------------------------------------------

  /** Recipients held back for an A/B winner are cancelled with the campaign. */
  async cancelHeld(campaignId: string): Promise<void> {
    await db.update(campaignRecipients).set({ status: "cancelled" }).where(and(eq(campaignRecipients.campaignId, campaignId), eq(campaignRecipients.status, "held")));
  },

  async insertRecipients(rows: Omit<typeof campaignRecipients.$inferInsert, "id">[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, id: randomUUID() }));
      const [res] = await db.insert(campaignRecipients).ignore().values(chunk);
      inserted += res.affectedRows;
    }
    return inserted;
  },

  async listRecipients(campaignId: string, opts: { page: number; limit: number; status?: string }) {
    const conds: SQL[] = [eq(campaignRecipients.campaignId, campaignId)];
    if (opts.status) conds.push(eq(campaignRecipients.status, opts.status));
    const where = and(...conds);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(campaignRecipients)
        .where(where)
        .orderBy(desc(campaignRecipients.updatedAt))
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(campaignRecipients).where(where),
    ]);
    return { rows, total };
  },

  async recipientStatusBreakdown(campaignId: string): Promise<Record<string, number>> {
    const rows = await db
      .select({ status: campaignRecipients.status, n: count() })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId))
      .groupBy(campaignRecipients.status);
    return Object.fromEntries(rows.map((r) => [r.status ?? "unknown", r.n]));
  },

  async findRecipientByWamid(wamid: string): Promise<CampaignRecipient | undefined> {
    const [row] = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.whatsappMessageId, wamid))
      .limit(1);
    return row;
  },

  async updateRecipientByPhone(campaignId: string, phone: string, patch: Partial<CampaignRecipient>): Promise<void> {
    await db
      .update(campaignRecipients)
      .set(patch)
      .where(and(eq(campaignRecipients.campaignId, campaignId), eq(campaignRecipients.phone, phone)));
  },

  async updateRecipient(id: string, patch: Partial<CampaignRecipient>): Promise<void> {
    await db.update(campaignRecipients).set(patch).where(eq(campaignRecipients.id, id));
  },
};
