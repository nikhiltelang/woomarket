/**
 * Scheduled reports: built for the last complete day / week / month in the tenant's time zone
 * and emailed with PDF and/or CSV attachments.
 */
import crypto from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import { nextScheduleRun, schedulePeriod, SECTION_LABELS, type Frequency, type ReportSection } from "@shared/reports";
import { reportSchedules, type ReportSchedule } from "@shared/schema";
import { db } from "../db";
import { childLogger } from "../lib/logger";
import { escapeHtml } from "./email/render";
import type { EmailAttachment } from "./email/mailer";
import { sendSystemEmail } from "./email/system-mail";
import { usersRepository } from "../repositories/users.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { tenantSettingsRepository } from "./delivery.service";
import { systemConfig } from "./system-config.service";
import { buildReport } from "./reports.service";
import { reportCsv, reportPdf } from "./report-export";

const log = childLogger("report-schedules");

export const reportSchedulesRepository = {
  list(userId: string) {
    return db.select().from(reportSchedules).where(eq(reportSchedules.userId, userId)).orderBy(desc(reportSchedules.createdAt));
  },
  async find(id: string): Promise<ReportSchedule | undefined> {
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id)).limit(1);
    return row;
  },
  async create(values: Omit<typeof reportSchedules.$inferInsert, "id">) {
    const id = crypto.randomUUID();
    await db.insert(reportSchedules).values({ ...values, id });
    return (await this.find(id))!;
  },
  async update(id: string, patch: Partial<typeof reportSchedules.$inferInsert>) {
    await db.update(reportSchedules).set(patch).where(eq(reportSchedules.id, id));
    return this.find(id);
  },
  async delete(id: string) {
    await db.delete(reportSchedules).where(eq(reportSchedules.id, id));
  },
  due(now: Date) {
    return db.select().from(reportSchedules).where(and(eq(reportSchedules.enabled, true), lte(reportSchedules.nextRunAt, now))).limit(50);
  },
  /** Moves nextRunAt forward only if nobody else has (so each run happens once). */
  async claim(s: ReportSchedule, next: Date): Promise<boolean> {
    const [res] = await db.update(reportSchedules).set({ nextRunAt: next }).where(and(eq(reportSchedules.id, s.id), eq(reportSchedules.nextRunAt, s.nextRunAt!)));
    return res.affectedRows === 1;
  },
};

export async function tenantZone(tenantId: string): Promise<string> {
  return (await tenantSettingsRepository.getSending(tenantId)).timezone || "UTC";
}

export async function computeNextRun(s: { frequency: string; dayOfWeek: number; hour: number }, tenantId: string, after = new Date()): Promise<Date> {
  return nextScheduleRun({ frequency: s.frequency as Frequency, dayOfWeek: s.dayOfWeek, hour: s.hour }, after, await tenantZone(tenantId));
}

const FREQ_LABEL: Record<string, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

/** Builds and emails one scheduled report. Returns the status recorded on the schedule. */
export async function sendScheduledReport(s: ReportSchedule, now = new Date()): Promise<string> {
  const tz = await tenantZone(s.userId);
  const period = schedulePeriod(s.frequency as Frequency, now, tz);
  const sections = s.sections as ReportSection[];
  const query = { ...period, ...(s.channelId ? { channelId: s.channelId } : {}) };
  let status: string;
  try {
    const [report, tenant, channel, cfg] = await Promise.all([
      buildReport(s.userId, query, sections),
      usersRepository.findById(s.userId),
      s.channelId ? channelsRepository.findById(s.channelId) : Promise.resolve(undefined),
      systemConfig.get(),
    ]);
    const tenantName = [tenant?.firstName, tenant?.lastName].filter(Boolean).join(" ") || tenant?.username || "Your account";
    const stem = `${s.name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "report"}-${period.from}${period.to !== period.from ? `-to-${period.to}` : ""}`;
    const attachments: EmailAttachment[] = [];
    if (s.format === "pdf" || s.format === "both") {
      attachments.push({ filename: `${stem}.pdf`, contentType: "application/pdf", content: await reportPdf(report, { title: s.name, tenantName, channelName: channel?.name, brandColor: cfg.siteBaseColor ?? undefined }) });
    }
    if (s.format === "csv" || s.format === "both") {
      for (const sec of sections) attachments.push({ filename: `${stem}-${sec}.csv`, contentType: "text/csv", content: Buffer.from(reportCsv(report, sec), "utf8") });
    }
    const summary: string[] = [];
    if (report.overview) summary.push(`WhatsApp messages sent: <b>${report.overview.whatsapp.conversationsSent + report.overview.whatsapp.campaignSent}</b>, received: <b>${report.overview.whatsapp.received}</b>; emails sent: <b>${report.overview.email.sent}</b>; SMS sent: <b>${report.overview.sms.sent}</b>.`);
    if (report.responseTimes?.first.median != null) summary.push(`Median first response: <b>${Math.round(report.responseTimes.first.median / 60)} min</b>.`);
    const body = `<p style="margin:0 0 12px"><b>${escapeHtml(s.name)}</b> (${FREQ_LABEL[s.frequency] ?? s.frequency.toLowerCase()} report) for ${escapeHtml(tenantName)}</p>
<p style="margin:0 0 12px">Period: ${period.from}${period.to !== period.from ? ` to ${period.to}` : ""} (${escapeHtml(tz)}). Sections: ${sections.map((x) => SECTION_LABELS[x]).join(", ")}.</p>
${summary.map((x) => `<p style="margin:0 0 8px">${x}</p>`).join("")}
<p style="margin:16px 0 0;color:#6b7280">The full report is attached.</p>`;
    let sent = 0;
    const errors: string[] = [];
    for (const to of s.recipients) {
      try {
        await sendSystemEmail(to, `${s.name}: ${period.from}${period.to !== period.from ? ` to ${period.to}` : ""}`, body, attachments);
        sent++;
      } catch (err) {
        errors.push(`${to}: ${(err as Error).message}`);
      }
    }
    status = errors.length ? `failed: ${errors.join("; ")}`.slice(0, 300) : `sent to ${sent} recipient${sent === 1 ? "" : "s"}`;
  } catch (err) {
    status = `failed: ${(err as Error).message}`.slice(0, 300);
  }
  await reportSchedulesRepository.update(s.id, { lastRunAt: now, lastStatus: status });
  log.info({ scheduleId: s.id, status }, "Scheduled report run");
  return status;
}

/** Cron: sends every schedule whose time has come. */
export async function runDueSchedules(now = new Date()): Promise<number> {
  let ran = 0;
  for (const s of await reportSchedulesRepository.due(now)) {
    const next = await computeNextRun(s, s.userId, now);
    if (!(await reportSchedulesRepository.claim(s, next))) continue;
    await sendScheduledReport(s, now);
    ran++;
  }
  return ran;
}
