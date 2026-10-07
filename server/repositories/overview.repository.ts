import type { RowDataPacket } from "mysql2";
import { pool } from "../db";

/** One shape for every channel, so WhatsApp, email and SMS are reported side by side. */
export interface ChannelTotals {
  campaigns: number;
  recipients: number;
  sent: number;
  delivered: number;
  /** Read (WhatsApp) or opened (email); SMS has no engagement signal. */
  engaged: number;
  failed: number;
}

export type MarketingChannel = "whatsapp" | "email" | "sms";

export interface RecentCampaign {
  id: string;
  channel: MarketingChannel;
  name: string;
  status: string;
  recipients: number;
  delivered: number;
  createdAt: Date;
}

async function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const [r] = await pool.query<RowDataPacket[]>(sql, params);
  return r as T[];
}
const num = (o: Record<string, unknown>): ChannelTotals => ({
  campaigns: Number(o.campaigns ?? 0),
  recipients: Number(o.recipients ?? 0),
  sent: Number(o.sent ?? 0),
  delivered: Number(o.delivered ?? 0),
  engaged: Number(o.engaged ?? 0),
  failed: Number(o.failed ?? 0),
});
// `IN (?)` with an empty list is invalid SQL; this id never matches a row.
const ids = (channelIds: string[]) => (channelIds.length ? channelIds : ["-"]);

export const overviewRepository = {
  async whatsappTotals(channelIds: string[], since: Date): Promise<ChannelTotals> {
    const [r] = await rows<Record<string, unknown>>(
      `SELECT COUNT(*) campaigns, COALESCE(SUM(recipient_count),0) recipients, COALESCE(SUM(sent_count),0) sent,
              COALESCE(SUM(delivered_count),0) delivered, COALESCE(SUM(read_count),0) engaged, COALESCE(SUM(failed_count),0) failed
         FROM campaigns WHERE channel_id IN (?) AND created_at >= ?`,
      [ids(channelIds), since],
    );
    return num(r);
  },

  async emailTotals(tenantId: string, since: Date): Promise<ChannelTotals> {
    const [r] = await rows<Record<string, unknown>>(
      `SELECT COUNT(*) campaigns, COALESCE(SUM(total_recipients),0) recipients, COALESCE(SUM(sent_count),0) sent,
              COALESCE(SUM(delivered_count),0) delivered, COALESCE(SUM(opened_count),0) engaged, COALESCE(SUM(failed_count),0) failed
         FROM email_campaigns WHERE user_id = ? AND created_at >= ?`,
      [tenantId, since],
    );
    return num(r);
  },

  async smsTotals(tenantId: string, since: Date): Promise<ChannelTotals & { credits: number }> {
    const [r] = await rows<Record<string, unknown>>(
      `SELECT COUNT(*) campaigns, COALESCE(SUM(total_recipients),0) recipients, COALESCE(SUM(sent_count),0) sent,
              COALESCE(SUM(delivered_count),0) delivered, 0 engaged, COALESCE(SUM(failed_count),0) failed,
              COALESCE(SUM(estimated_credits),0) credits
         FROM sms_campaigns WHERE user_id = ? AND created_at >= ?`,
      [tenantId, since],
    );
    return { ...num(r), credits: Number(r.credits ?? 0) };
  },

  /** Outbound messages per UTC day and channel (WhatsApp includes inbox replies). */
  async sentPerDay(tenantId: string, channelIds: string[], since: Date) {
    const [wa, email, sms] = await Promise.all([
      rows<{ day: string; n: number }>(
        `SELECT DATE(m.created_at) day, COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.channel_id IN (?) AND m.direction = 'outbound' AND m.created_at >= ? GROUP BY DATE(m.created_at)`,
        [ids(channelIds), since],
      ),
      rows<{ day: string; n: number }>(
        `SELECT DATE(r.sent_at) day, COUNT(*) n FROM email_campaign_recipients r JOIN email_campaigns e ON e.id = r.campaign_id
          WHERE e.user_id = ? AND r.sent_at >= ? GROUP BY DATE(r.sent_at)`,
        [tenantId, since],
      ),
      rows<{ day: string; n: number }>(
        `SELECT DATE(r.sent_at) day, COUNT(*) n FROM sms_campaign_recipients r JOIN sms_campaigns s ON s.id = r.campaign_id
          WHERE s.user_id = ? AND r.sent_at >= ? GROUP BY DATE(r.sent_at)`,
        [tenantId, since],
      ),
    ]);
    const key = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
    const toMap = (list: { day: string; n: number }[]) => new Map(list.map((r) => [key(r.day), Number(r.n)]));
    return { whatsapp: toMap(wa), email: toMap(email), sms: toMap(sms) };
  },

  async audience(channelIds: string[]) {
    const [r] = await rows<Record<string, unknown>>(
      `SELECT COUNT(*) total,
              COALESCE(SUM(phone IS NOT NULL AND phone <> ''),0) withPhone,
              COALESCE(SUM(email IS NOT NULL AND email <> ''),0) withEmail
         FROM contacts WHERE channel_id IN (?)`,
      [ids(channelIds)],
    );
    return { total: Number(r.total ?? 0), withPhone: Number(r.withPhone ?? 0), withEmail: Number(r.withEmail ?? 0) };
  },

  /** Newest campaigns across the channels the caller may see. */
  async recentCampaigns(tenantId: string, channelIds: string[], include: Record<MarketingChannel, boolean>, limit = 6): Promise<RecentCampaign[]> {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (include.whatsapp) {
      parts.push(`SELECT id, 'whatsapp' channel, name, status, recipient_count recipients, delivered_count delivered, created_at FROM campaigns WHERE channel_id IN (?)`);
      params.push(ids(channelIds));
    }
    if (include.email) {
      parts.push(`SELECT id, 'email', name, status, total_recipients, delivered_count, created_at FROM email_campaigns WHERE user_id = ?`);
      params.push(tenantId);
    }
    if (include.sms) {
      parts.push(`SELECT id, 'sms', name, status, total_recipients, delivered_count, created_at FROM sms_campaigns WHERE user_id = ?`);
      params.push(tenantId);
    }
    if (!parts.length) return [];
    const list = await rows<Record<string, unknown>>(`${parts.map((p) => `(${p} ORDER BY created_at DESC LIMIT ${limit})`).join(" UNION ALL ")} ORDER BY created_at DESC LIMIT ${limit}`, params);
    return list.map((r) => ({
      id: String(r.id),
      channel: r.channel as MarketingChannel,
      name: String(r.name),
      status: String(r.status ?? "draft"),
      recipients: Number(r.recipients ?? 0),
      delivered: Number(r.delivered ?? 0),
      createdAt: r.created_at as Date,
    }));
  },
};
