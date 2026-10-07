/**
 * Delivery timing: per-contact time zones, quiet hours and "local time" / "best time" sending.
 * Pure functions (Intl-based time zone math), shared by the server and the composers.
 */
import { z } from "zod";

export type SendChannel = "whatsapp" | "email" | "sms";
export const SEND_CHANNELS: SendChannel[] = ["whatsapp", "email", "sms"];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

export const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const sendingPreferencesSchema = z.object({
  timezone: z.string().trim().refine(isValidTimeZone, "Unknown time zone"),
  quietHours: z.object({
    enabled: z.boolean(),
    start: hhmm,
    end: hhmm,
    channels: z.array(z.enum(["whatsapp", "email", "sms"])).default(["whatsapp", "email", "sms"]),
  }),
  /** Fallback hour for "best time" when a contact has no engagement history (local time). */
  defaultBestHour: z.coerce.number().int().min(0).max(23),
});
export type SendingPreferences = z.infer<typeof sendingPreferencesSchema>;

export const DEFAULT_SENDING_PREFERENCES: SendingPreferences = {
  timezone: "UTC",
  quietHours: { enabled: false, start: "21:00", end: "08:00", channels: ["whatsapp", "email", "sms"] },
  defaultBestHour: 10,
};

export const deliverySchema = z
  .object({
    mode: z.enum(["immediate", "local_time", "best_time"]).default("immediate"),
    /** For local_time: the contact's local clock time. */
    localTime: hhmm.optional(),
  })
  .refine((d) => d.mode !== "local_time" || d.localTime, { message: "Choose a time", path: ["localTime"] });
export type Delivery = z.infer<typeof deliverySchema>;

// ---------------------------------------------------------------------------
// Time zone math (no dependencies)
// ---------------------------------------------------------------------------

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(date: Date, tz: string): Parts {
  const p = Object.fromEntries(fmt(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}

/** Offset of a zone from UTC at an instant, in minutes (e.g. +330 for Asia/Kolkata). */
export function zoneOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant at which a zone's clock shows the given wall time. Times skipped by a DST jump
 * resolve to the moment just after the jump.
 */
export function fromZoned(p: Omit<Parts, "second"> & { second?: number }, tz: string): Date {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second ?? 0);
  let t = guess - zoneOffsetMinutes(new Date(guess), tz) * 60_000;
  // A second pass settles instants near a DST change.
  t = guess - zoneOffsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

const toMinutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Next instant (at or after `from`) when the zone's clock reads hh:mm. */
export function nextLocalTime(from: Date, tz: string, hm: string): Date {
  const p = zonedParts(from, tz);
  const minutes = toMinutes(hm);
  let at = fromZoned({ year: p.year, month: p.month, day: p.day, hour: Math.floor(minutes / 60), minute: minutes % 60 }, tz);
  if (at.getTime() < from.getTime()) {
    const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    at = fromZoned({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(), hour: Math.floor(minutes / 60), minute: minutes % 60 }, tz);
  }
  return at;
}

/** True when the zone's clock at `date` is inside [start, end) (windows may cross midnight). */
export function inQuietHours(date: Date, tz: string, start: string, end: string): boolean {
  const p = zonedParts(date, tz);
  const now = p.hour * 60 + p.minute;
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** Moves an instant out of quiet hours (to the end of the window), otherwise returns it unchanged. */
export function applyQuietHours(date: Date, tz: string, q: { enabled: boolean; start: string; end: string }): Date {
  if (!q.enabled || !inQuietHours(date, tz, q.start, q.end)) return date;
  return nextLocalTime(date, tz, q.end);
}

// ---------------------------------------------------------------------------
// Contact time zones
// ---------------------------------------------------------------------------

/**
 * Representative zone per calling code. Countries spanning several zones use their most
 * populous one; a contact's "timezone" custom field always wins.
 */
const CALLING_CODE_ZONES: [string, string][] = [
  ["1", "America/New_York"], ["7", "Europe/Moscow"], ["20", "Africa/Cairo"], ["27", "Africa/Johannesburg"], ["30", "Europe/Athens"],
  ["31", "Europe/Amsterdam"], ["32", "Europe/Brussels"], ["33", "Europe/Paris"], ["34", "Europe/Madrid"], ["36", "Europe/Budapest"],
  ["39", "Europe/Rome"], ["40", "Europe/Bucharest"], ["41", "Europe/Zurich"], ["43", "Europe/Vienna"], ["44", "Europe/London"],
  ["45", "Europe/Copenhagen"], ["46", "Europe/Stockholm"], ["47", "Europe/Oslo"], ["48", "Europe/Warsaw"], ["49", "Europe/Berlin"],
  ["51", "America/Lima"], ["52", "America/Mexico_City"], ["54", "America/Argentina/Buenos_Aires"], ["55", "America/Sao_Paulo"], ["56", "America/Santiago"],
  ["57", "America/Bogota"], ["58", "America/Caracas"], ["60", "Asia/Kuala_Lumpur"], ["61", "Australia/Sydney"], ["62", "Asia/Jakarta"],
  ["63", "Asia/Manila"], ["64", "Pacific/Auckland"], ["65", "Asia/Singapore"], ["66", "Asia/Bangkok"], ["81", "Asia/Tokyo"],
  ["82", "Asia/Seoul"], ["84", "Asia/Ho_Chi_Minh"], ["86", "Asia/Shanghai"], ["90", "Europe/Istanbul"], ["91", "Asia/Kolkata"],
  ["92", "Asia/Karachi"], ["93", "Asia/Kabul"], ["94", "Asia/Colombo"], ["95", "Asia/Yangon"], ["98", "Asia/Tehran"],
  ["212", "Africa/Casablanca"], ["213", "Africa/Algiers"], ["216", "Africa/Tunis"], ["233", "Africa/Accra"], ["234", "Africa/Lagos"],
  ["254", "Africa/Nairobi"], ["255", "Africa/Dar_es_Salaam"], ["256", "Africa/Kampala"], ["351", "Europe/Lisbon"], ["353", "Europe/Dublin"],
  ["358", "Europe/Helsinki"], ["380", "Europe/Kyiv"], ["420", "Europe/Prague"], ["852", "Asia/Hong_Kong"], ["880", "Asia/Dhaka"],
  ["886", "Asia/Taipei"], ["960", "Indian/Maldives"], ["961", "Asia/Beirut"], ["962", "Asia/Amman"], ["965", "Asia/Kuwait"],
  ["966", "Asia/Riyadh"], ["968", "Asia/Muscat"], ["971", "Asia/Dubai"], ["972", "Asia/Jerusalem"], ["973", "Asia/Bahrain"],
  ["974", "Asia/Qatar"], ["977", "Asia/Kathmandu"],
];
const CODES = [...CALLING_CODE_ZONES].sort((a, b) => b[0].length - a[0].length);

/** Contact's zone: explicit (valid) field → phone country → fallback. */
export function contactTimeZone(c: { phone?: string | null; timezone?: string | null }, fallback: string): string {
  if (c.timezone && isValidTimeZone(c.timezone)) return c.timezone;
  const digits = (c.phone ?? "").replace(/\D/g, "");
  if (digits) for (const [code, tz] of CODES) if (digits.startsWith(code)) return tz;
  return fallback;
}

/** Common zones for the preferences picker (any IANA zone is accepted). */
export const COMMON_TIMEZONES = [
  "UTC", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Istanbul", "Africa/Lagos", "Africa/Johannesburg", "Africa/Nairobi",
  "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok", "Asia/Jakarta", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo",
  "Australia/Sydney", "Pacific/Auckland", "America/Sao_Paulo", "America/Mexico_City", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
];
