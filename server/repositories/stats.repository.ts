import { and, count, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  campaigns,
  contacts,
  emailCampaigns,
  messages,
  plans,
  platformAccessLevels,
  policyPages,
  smsCampaigns,
  templates,
  userActivityLogs,
} from "@shared/schema";

const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;

/** Platform-wide counters and time series for the superadmin dashboard. */
export const statsRepository = {
  async totals() {
    const [contactsN, templatesN, approvedTemplates, campaignsN, emailN, smsN, levelsN, plansN, policiesN] = await Promise.all([
      n(db.select({ n: count() }).from(contacts)),
      n(db.select({ n: count() }).from(templates)),
      n(db.select({ n: count() }).from(templates).where(eq(templates.status, "approved"))),
      n(db.select({ n: count() }).from(campaigns).where(isNull(campaigns.automationId))),
      n(db.select({ n: count() }).from(emailCampaigns).where(isNull(emailCampaigns.automationId))),
      n(db.select({ n: count() }).from(smsCampaigns).where(isNull(smsCampaigns.automationId))),
      n(db.select({ n: count() }).from(platformAccessLevels)),
      n(db.select({ n: count() }).from(plans)),
      n(db.select({ n: count() }).from(policyPages)),
    ]);
    return { contacts: contactsN, templates: templatesN, approvedTemplates, campaigns: campaignsN, emailCampaigns: emailN, smsCampaigns: smsN, levels: levelsN, plans: plansN, policyPages: policiesN };
  },

  async messagesByDay(from: Date, to: Date) {
    const rows = await db
      .select({ day: sql<string>`DATE(${messages.createdAt})`, direction: messages.direction, n: count() })
      .from(messages)
      .where(and(gte(messages.createdAt, from), lt(messages.createdAt, to)))
      .groupBy(sql`DATE(${messages.createdAt})`, messages.direction);
    return rows.map((r) => ({ day: String(r.day).slice(0, 10), direction: r.direction ?? "outbound", count: r.n }));
  },

  async loginAgents(since: Date): Promise<string[]> {
    const rows = await db
      .select({ ua: userActivityLogs.userAgent })
      .from(userActivityLogs)
      .where(and(eq(userActivityLogs.action, "login"), gte(userActivityLogs.createdAt, since)))
      .limit(50_000);
    return rows.map((r) => r.ua ?? "");
  },
};

/** Coarse browser / OS detection for login statistics (no third-party UA database). */
export function parseUserAgent(ua: string): { browser: string; os: string } {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua) && !/Chromium/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua) && /Version\//.test(ua)
            ? "Safari"
            : /curl|node|undici|axios|python|okhttp/i.test(ua) || !ua
              ? "API client"
              : "Other";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Other";
  return { browser, os };
}
