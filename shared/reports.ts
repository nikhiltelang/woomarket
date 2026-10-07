/**
 * Reports: shapes shared by the reports page, exports and scheduled emails.
 */
import { z } from "zod";
import { fromZoned, zonedParts } from "./sending";

export const REPORT_SECTIONS = ["overview", "team", "response-times"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];
export const SECTION_LABELS: Record<ReportSection, string> = { overview: "Channel overview", team: "Team performance", "response-times": "Inbox response times" };

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const MAX_REPORT_DAYS = 366;

export const reportQuerySchema = z
  .object({ from: day, to: day, channelId: z.string().uuid().optional() })
  .refine((q) => q.from <= q.to, { message: "The start date must be before the end date", path: ["from"] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_REPORT_DAYS, { message: `Pick a range of up to ${MAX_REPORT_DAYS} days`, path: ["to"] });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const REPORT_FORMATS = ["pdf", "csv", "both"] as const;

export const reportScheduleSchema = z.object({
  name: z.string().trim().min(1, "Name the report").max(100),
  sections: z.array(z.enum(REPORT_SECTIONS)).min(1, "Pick at least one section"),
  frequency: z.enum(FREQUENCIES),
  /** 0 = Sunday … 6 = Saturday (weekly). */
  dayOfWeek: z.coerce.number().int().min(0).max(6).default(1),
  /** Local hour the report is sent. */
  hour: z.coerce.number().int().min(0).max(23).default(8),
  format: z.enum(REPORT_FORMATS).default("pdf"),
  recipients: z.array(z.string().trim().toLowerCase().email()).min(1, "Add at least one email").max(10),
  channelId: z.string().uuid().nullish(),
  enabled: z.boolean().default(true),
});
export type ReportScheduleInput = z.infer<typeof reportScheduleSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface DailyRow {
  day: string;
  whatsappSent: number;
  whatsappReceived: number;
  emailSent: number;
  smsSent: number;
}

export interface OverviewReport {
  whatsapp: { conversationsSent: number; received: number; delivered: number; read: number; failed: number; campaignSent: number; campaignDelivered: number; campaignRead: number; campaignReplied: number; campaignFailed: number };
  email: { recipients: number; sent: number; opened: number; clicked: number; bounced: number; failed: number; unsubscribed: number };
  sms: { recipients: number; sent: number; delivered: number; failed: number; clicked: number };
  daily: DailyRow[];
}

export interface ResponseStats {
  count: number;
  /** Seconds. */
  avg: number | null;
  median: number | null;
  p90: number | null;
}

export interface TeamRow extends ResponseStats {
  userId: string;
  name: string;
  role: string;
  messagesSent: number;
  conversations: number;
  openAssigned: number;
  resolved: number;
}

export const RESPONSE_BUCKETS = [
  { label: "Under 5 min", max: 300 },
  { label: "5–15 min", max: 900 },
  { label: "15–60 min", max: 3600 },
  { label: "1–4 hours", max: 4 * 3600 },
  { label: "4–24 hours", max: 24 * 3600 },
  { label: "Over a day", max: Infinity },
] as const;

export interface ResponseTimesReport {
  first: ResponseStats;
  all: ResponseStats;
  buckets: { label: string; count: number }[];
  daily: { day: string; median: number | null; count: number }[];
  /** Customers still waiting for a human reply (wait started in the period). */
  awaiting: number;
  /** True when the period had more messages than were analysed. */
  truncated: boolean;
}

export interface FullReport {
  query: ReportQuery;
  timezone: string;
  generatedAt: string;
  overview?: OverviewReport;
  team?: TeamRow[];
  responseTimes?: ResponseTimesReport;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (p: { year: number; month: number; day: number }) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;

/** First and last instant covered by a YYYY-MM-DD range in a zone (end exclusive). */
export function rangeInstants(from: string, to: string, tz: string): { start: Date; end: Date } {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const start = fromZoned({ year: fy, month: fm, day: fd, hour: 0, minute: 0 }, tz);
  const next = new Date(Date.UTC(ty, tm - 1, td + 1));
  const end = fromZoned({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 }, tz);
  return { start, end };
}

/** Every day in a range, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** The period a scheduled report covers when it runs at `now` (the last complete day/week/month). */
export function schedulePeriod(frequency: Frequency, now: Date, tz: string): { from: string; to: string } {
  const p = zonedParts(now, tz);
  const today = Date.UTC(p.year, p.month - 1, p.day);
  const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);
  if (frequency === "daily") return { from: dayStr(today - 86_400_000), to: dayStr(today - 86_400_000) };
  if (frequency === "weekly") return { from: dayStr(today - 7 * 86_400_000), to: dayStr(today - 86_400_000) };
  const firstThis = Date.UTC(p.year, p.month - 1, 1);
  const firstPrev = Date.UTC(p.year, p.month - 2, 1);
  return { from: dayStr(firstPrev), to: dayStr(firstThis - 86_400_000) };
}

/** Next send time after `after`: the hour (local), on the weekday for weekly, on the 1st for monthly. */
export function nextScheduleRun(s: { frequency: Frequency; dayOfWeek: number; hour: number }, after: Date, tz: string): Date {
  const p = zonedParts(after, tz);
  for (let i = 0; i <= 62; i++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    if (s.frequency === "weekly" && d.getUTCDay() !== s.dayOfWeek) continue;
    if (s.frequency === "monthly" && d.getUTCDate() !== 1) continue;
    const at = fromZoned({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: s.hour, minute: 0 }, tz);
    if (at > after) return at;
  }
  throw new Error("No next run found");
}

/** "2m 30s", "1h 5m", "2d 3h" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)}m` : ""}`;
  return `${Math.floor(s / 86_400)}d${Math.floor((s % 86_400) / 3600) ? ` ${Math.floor((s % 86_400) / 3600)}h` : ""}`;
}

export const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
