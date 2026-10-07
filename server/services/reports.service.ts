/**
 * Reports for a tenant over a date range (in the tenant's time zone): channel totals,
 * team performance and inbox response times.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { zoneOffsetMinutes } from "@shared/sending";
import {
  daysBetween,
  RESPONSE_BUCKETS,
  rangeInstants,
  type DailyRow,
  type FullReport,
  type OverviewReport,
  type ReportQuery,
  type ReportSection,
  type ResponseStats,
  type ResponseTimesReport,
  type TeamRow,
} from "@shared/reports";
import { campaignRecipients, campaigns, channels, conversations, emailCampaignRecipients, emailCampaigns, messages, smsCampaignRecipients, smsCampaigns, users } from "@shared/schema";
import { db } from "../db";
import { tenantSettingsRepository } from "./delivery.service";

/** Messages analysed per report for response times (keeps big tenants fast). */
export const MAX_RESPONSE_ROWS = 200_000;
/** Waits that started this long before the period still count when answered inside it. */
const LOOKBACK_MS = 3 * 86_400_000;

interface Window {
  start: Date;
  end: Date;
  /** Minutes added to UTC to get the tenant's local day (taken at the start of the range). */
  offset: number;
  tz: string;
}

async function windowFor(tenantId: string, q: ReportQuery): Promise<Window> {
  const tz = (await tenantSettingsRepository.getSending(tenantId)).timezone || "UTC";
  const { start, end } = rangeInstants(q.from, q.to, tz);
  return { start, end, offset: zoneOffsetMinutes(start, tz), tz };
}

async function channelIds(tenantId: string, channelId?: string): Promise<string[]> {
  const rows = await db.select({ id: channels.id }).from(channels).where(eq(channels.createdBy, tenantId));
  const ids = rows.map((r) => r.id);
  return channelId ? ids.filter((id) => id === channelId) : ids;
}

const localDay = (col: unknown, offset: number) => sql<string>`DATE_FORMAT(DATE_ADD(${col}, INTERVAL ${offset} MINUTE), '%Y-%m-%d')`;
const n = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Channel overview
// ---------------------------------------------------------------------------

export async function overviewReport(tenantId: string, q: ReportQuery, w: Window): Promise<OverviewReport> {
  const ids = await channelIds(tenantId, q.channelId);
  const daily = new Map<string, DailyRow>(daysBetween(q.from, q.to).map((d) => [d, { day: d, whatsappSent: 0, whatsappReceived: 0, emailSent: 0, smsSent: 0 }]));
  const bump = (day: string, k: keyof Omit<DailyRow, "day">, v: number) => {
    const row = daily.get(day);
    if (row) row[k] += v;
  };

  const wa = { conversationsSent: 0, received: 0, delivered: 0, read: 0, failed: 0, campaignSent: 0, campaignDelivered: 0, campaignRead: 0, campaignReplied: 0, campaignFailed: 0 };
  if (ids.length) {
    const m = messages;
    const rows = await db
      .select({
        day: localDay(m.createdAt, w.offset),
        out: sql<number>`SUM(${m.direction} = 'outbound')`,
        inn: sql<number>`SUM(${m.direction} = 'inbound')`,
        delivered: sql<number>`SUM(${m.direction} = 'outbound' AND ${m.status} IN ('delivered','read'))`,
        read: sql<number>`SUM(${m.direction} = 'outbound' AND ${m.status} = 'read')`,
        failed: sql<number>`SUM(${m.direction} = 'outbound' AND ${m.status} = 'failed')`,
      })
      .from(m)
      .innerJoin(conversations, eq(conversations.id, m.conversationId))
      .where(and(inArray(conversations.channelId, ids), sql`${m.createdAt} >= ${w.start} AND ${m.createdAt} < ${w.end}`))
      .groupBy(sql`1`);
    for (const r of rows) {
      wa.conversationsSent += n(r.out);
      wa.received += n(r.inn);
      wa.delivered += n(r.delivered);
      wa.read += n(r.read);
      wa.failed += n(r.failed);
      bump(r.day, "whatsappSent", n(r.out));
      bump(r.day, "whatsappReceived", n(r.inn));
    }
    const cr = campaignRecipients;
    const at = sql`COALESCE(${cr.sentAt}, ${cr.createdAt})`;
    const [c] = await db
      .select({
        sent: sql<number>`SUM(${cr.whatsappMessageId} IS NOT NULL)`,
        delivered: sql<number>`SUM(${cr.deliveredAt} IS NOT NULL)`,
        read: sql<number>`SUM(${cr.readAt} IS NOT NULL)`,
        replied: sql<number>`SUM(${cr.status} = 'replied')`,
        failed: sql<number>`SUM(${cr.status} = 'failed')`,
      })
      .from(cr)
      .innerJoin(campaigns, eq(campaigns.id, cr.campaignId))
      .where(and(inArray(campaigns.channelId, ids), sql`${at} >= ${w.start} AND ${at} < ${w.end}`));
    Object.assign(wa, { campaignSent: n(c?.sent), campaignDelivered: n(c?.delivered), campaignRead: n(c?.read), campaignReplied: n(c?.replied), campaignFailed: n(c?.failed) });
  }

  const er = emailCampaignRecipients;
  const eAt = sql`COALESCE(${er.sentAt}, ${er.createdAt})`;
  const emailWhere = and(eq(emailCampaigns.userId, tenantId), q.channelId ? eq(emailCampaigns.channelId, q.channelId) : undefined, sql`${eAt} >= ${w.start} AND ${eAt} < ${w.end}`);
  const emailRows = await db
    .select({
      day: localDay(eAt, w.offset),
      recipients: sql<number>`COUNT(*)`,
      sent: sql<number>`SUM(${er.status} IN ('sent','bounced'))`,
      opened: sql<number>`SUM(${er.openedAt} IS NOT NULL)`,
      clicked: sql<number>`SUM(${er.clickedAt} IS NOT NULL)`,
      bounced: sql<number>`SUM(${er.status} = 'bounced')`,
      failed: sql<number>`SUM(${er.status} = 'failed')`,
      unsubscribed: sql<number>`SUM(${er.errorMessage} = 'unsubscribed')`,
    })
    .from(er)
    .innerJoin(emailCampaigns, eq(emailCampaigns.id, er.campaignId))
    .where(emailWhere)
    .groupBy(sql`1`);
  const email = { recipients: 0, sent: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, unsubscribed: 0 };
  for (const r of emailRows) {
    for (const k of Object.keys(email) as (keyof typeof email)[]) email[k] += n(r[k]);
    bump(r.day, "emailSent", n(r.sent));
  }

  const sr = smsCampaignRecipients;
  const sAt = sql`COALESCE(${sr.sentAt}, ${sr.createdAt})`;
  const smsRows = await db
    .select({
      day: localDay(sAt, w.offset),
      recipients: sql<number>`COUNT(*)`,
      sent: sql<number>`SUM(${sr.status} IN ('sent','delivered'))`,
      delivered: sql<number>`SUM(${sr.status} = 'delivered')`,
      failed: sql<number>`SUM(${sr.status} = 'failed')`,
      clicked: sql<number>`SUM(${sr.clickedAt} IS NOT NULL)`,
    })
    .from(sr)
    .innerJoin(smsCampaigns, eq(smsCampaigns.id, sr.campaignId))
    .where(and(eq(smsCampaigns.userId, tenantId), q.channelId ? eq(smsCampaigns.channelId, q.channelId) : undefined, sql`${sAt} >= ${w.start} AND ${sAt} < ${w.end}`))
    .groupBy(sql`1`);
  const sms = { recipients: 0, sent: 0, delivered: 0, failed: 0, clicked: 0 };
  for (const r of smsRows) {
    for (const k of Object.keys(sms) as (keyof typeof sms)[]) sms[k] += n(r[k]);
    bump(r.day, "smsSent", n(r.sent));
  }

  return { whatsapp: wa, email, sms, daily: [...daily.values()] };
}

// ---------------------------------------------------------------------------
// Response times
// ---------------------------------------------------------------------------

export interface Reply {
  seconds: number;
  agent: string;
  day: string;
  first: boolean;
}

export interface MessageRow {
  conversationId: string;
  direction: string;
  at: Date;
  sentBy: string | null;
}

/**
 * Walks each conversation in order. A wait starts at the customer's first message after the
 * business last wrote, and ends at the next message a person sent (campaign and automated
 * messages carry no sender and don't count as a reply).
 */
export function computeReplies(rows: MessageRow[], w: { start: Date; end: Date; offset: number }): { replies: Reply[]; awaiting: number } {
  const replies: Reply[] = [];
  const answered = new Set<string>();
  const waiting = new Map<string, Date>();
  const dayOf = (d: Date) => new Date(d.getTime() + w.offset * 60_000).toISOString().slice(0, 10);
  for (const r of rows) {
    if (r.direction === "inbound") {
      if (!waiting.has(r.conversationId)) waiting.set(r.conversationId, r.at);
      continue;
    }
    if (!r.sentBy) continue;
    const since = waiting.get(r.conversationId);
    waiting.delete(r.conversationId);
    if (!since || r.at < w.start || r.at >= w.end) continue;
    replies.push({ seconds: Math.max(0, (r.at.getTime() - since.getTime()) / 1000), agent: r.sentBy, day: dayOf(r.at), first: !answered.has(r.conversationId) });
    answered.add(r.conversationId);
  }
  let awaiting = 0;
  for (const since of waiting.values()) if (since >= w.start && since < w.end) awaiting++;
  return { replies, awaiting };
}

export function stats(values: number[]): ResponseStats {
  if (!values.length) return { count: 0, avg: null, median: null, p90: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { count: s.length, avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length), median: Math.round(at(0.5)), p90: Math.round(at(0.9)) };
}

async function messageRows(ids: string[], w: Window): Promise<{ rows: MessageRow[]; truncated: boolean }> {
  if (!ids.length) return { rows: [], truncated: false };
  const m = messages;
  const raw = await db
    .select({ conversationId: m.conversationId, direction: m.direction, at: m.createdAt, sentBy: sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(${m.metadata}, '$.sentBy'))` })
    .from(m)
    .innerJoin(conversations, eq(conversations.id, m.conversationId))
    .where(and(inArray(conversations.channelId, ids), sql`${m.createdAt} >= ${new Date(w.start.getTime() - LOOKBACK_MS)} AND ${m.createdAt} < ${w.end}`))
    .orderBy(m.conversationId, m.createdAt)
    .limit(MAX_RESPONSE_ROWS + 1);
  const rows = raw.slice(0, MAX_RESPONSE_ROWS).map((r) => ({ conversationId: r.conversationId!, direction: r.direction ?? "outbound", at: r.at!, sentBy: r.sentBy && r.sentBy !== "null" ? r.sentBy : null }));
  return { rows, truncated: raw.length > MAX_RESPONSE_ROWS };
}

export function responseTimesFrom(replies: Reply[], awaiting: number, days: string[], truncated: boolean): ResponseTimesReport {
  const all = replies.map((r) => r.seconds);
  const byDay = new Map<string, number[]>();
  for (const r of replies) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r.seconds]);
  let lower = 0;
  const buckets = RESPONSE_BUCKETS.map((b) => {
    const count = all.filter((s) => s >= lower && s < b.max).length;
    lower = b.max;
    return { label: b.label, count };
  });
  return {
    first: stats(replies.filter((r) => r.first).map((r) => r.seconds)),
    all: stats(all),
    buckets,
    daily: days.map((d) => ({ day: d, median: stats(byDay.get(d) ?? []).median, count: byDay.get(d)?.length ?? 0 })),
    awaiting,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export async function teamReport(tenantId: string, q: ReportQuery, w: Window, replies: Reply[]): Promise<TeamRow[]> {
  const ids = await channelIds(tenantId, q.channelId);
  const people = await db
    .select({ id: users.id, username: users.username, firstName: users.firstName, lastName: users.lastName, role: users.role })
    .from(users)
    .where(or(eq(users.id, tenantId), and(eq(users.createdBy, tenantId), eq(users.role, "team"))));
  const sent = new Map<string, { messages: number; conversations: number }>();
  const open = new Map<string, number>();
  const resolved = new Map<string, number>();
  if (ids.length) {
    const m = messages;
    const by = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${m.metadata}, '$.sentBy'))`;
    const rows = await db
      .select({ userId: by, messages: sql<number>`COUNT(*)`, conversations: sql<number>`COUNT(DISTINCT ${m.conversationId})` })
      .from(m)
      .innerJoin(conversations, eq(conversations.id, m.conversationId))
      .where(and(inArray(conversations.channelId, ids), eq(m.direction, "outbound"), sql`${m.createdAt} >= ${w.start} AND ${m.createdAt} < ${w.end}`, sql`${by} IS NOT NULL`))
      .groupBy(by);
    for (const r of rows) sent.set(r.userId, { messages: n(r.messages), conversations: n(r.conversations) });
    const c = conversations;
    const counts = await db
      .select({ userId: c.assignedTo, open: sql<number>`SUM(${c.status} IN ('open','pending'))`, resolved: sql<number>`SUM(${c.status} IN ('resolved','closed') AND ${c.updatedAt} >= ${w.start} AND ${c.updatedAt} < ${w.end})` })
      .from(c)
      .where(and(inArray(c.channelId, ids), sql`${c.assignedTo} IS NOT NULL`))
      .groupBy(c.assignedTo);
    for (const r of counts) {
      open.set(r.userId!, n(r.open));
      resolved.set(r.userId!, n(r.resolved));
    }
  }
  const byAgent = new Map<string, number[]>();
  for (const r of replies) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r.seconds]);
  return people
    .map((p) => ({
      userId: p.id,
      name: [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username,
      role: p.id === tenantId ? "owner" : "agent",
      messagesSent: sent.get(p.id)?.messages ?? 0,
      conversations: sent.get(p.id)?.conversations ?? 0,
      openAssigned: open.get(p.id) ?? 0,
      resolved: resolved.get(p.id) ?? 0,
      ...stats(byAgent.get(p.id) ?? []),
    }))
    .sort((a, b) => b.messagesSent - a.messagesSent || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Everything
// ---------------------------------------------------------------------------

export async function buildReport(tenantId: string, q: ReportQuery, sections: readonly ReportSection[]): Promise<FullReport> {
  const w = await windowFor(tenantId, q);
  const report: FullReport = { query: q, timezone: w.tz, generatedAt: new Date().toISOString() };
  if (sections.includes("overview")) report.overview = await overviewReport(tenantId, q, w);
  if (sections.includes("team") || sections.includes("response-times")) {
    const { rows, truncated } = await messageRows(await channelIds(tenantId, q.channelId), w);
    const { replies, awaiting } = computeReplies(rows, w);
    if (sections.includes("response-times")) report.responseTimes = responseTimesFrom(replies, awaiting, daysBetween(q.from, q.to), truncated);
    if (sections.includes("team")) report.team = await teamReport(tenantId, q, w, replies);
  }
  return report;
}
