import { describe, it, expect, afterEach, vi } from "vitest";
import { applyQuietHours, contactTimeZone, fromZoned, inQuietHours, nextLocalTime, sendingPreferencesSchema, zonedParts } from "@shared/sending";
import { scheduleRecipients, tenantSettingsRepository } from "../services/delivery.service";
import * as delivery from "../services/delivery.service";
import { db } from "../db";

afterEach(() => vi.restoreAllMocks());

describe("time zone math", () => {
  it("converts wall time to instants, including half-hour zones and DST", () => {
    expect(fromZoned({ year: 2026, month: 10, day: 7, hour: 10, minute: 0 }, "Asia/Kolkata").toISOString()).toBe("2026-10-07T04:30:00.000Z");
    // New York: EDT (UTC-4) in July, EST (UTC-5) in December.
    expect(fromZoned({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(fromZoned({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, "America/New_York").toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(zonedParts(new Date("2026-10-07T04:30:00Z"), "Asia/Kolkata")).toMatchObject({ hour: 10, minute: 0 });
  });

  it("finds the next local clock time, rolling to tomorrow", () => {
    const from = new Date("2026-10-07T06:00:00Z"); // 11:30 in Kolkata
    expect(nextLocalTime(from, "Asia/Kolkata", "14:00").toISOString()).toBe("2026-10-07T08:30:00.000Z");
    expect(nextLocalTime(from, "Asia/Kolkata", "10:00").toISOString()).toBe("2026-10-08T04:30:00.000Z");
  });

  it("handles quiet windows that cross midnight", () => {
    const tz = "Europe/London"; // BST (UTC+1) in October
    expect(inQuietHours(new Date("2026-10-07T21:30:00Z"), tz, "21:00", "08:00")).toBe(true); // 22:30
    expect(inQuietHours(new Date("2026-10-07T06:30:00Z"), tz, "21:00", "08:00")).toBe(true); // 07:30
    expect(inQuietHours(new Date("2026-10-07T07:30:00Z"), tz, "21:00", "08:00")).toBe(false); // 08:30
    expect(applyQuietHours(new Date("2026-10-07T21:30:00Z"), tz, { enabled: true, start: "21:00", end: "08:00" }).toISOString()).toBe("2026-10-08T07:00:00.000Z");
    expect(applyQuietHours(new Date("2026-10-07T12:00:00Z"), tz, { enabled: true, start: "21:00", end: "08:00" }).toISOString()).toBe("2026-10-07T12:00:00.000Z");
  });

  it("picks a contact's zone from its field, then its phone", () => {
    expect(contactTimeZone({ timezone: "Asia/Tokyo", phone: "+14155550123" }, "UTC")).toBe("Asia/Tokyo");
    expect(contactTimeZone({ timezone: "Mars/Base", phone: "+919812345678" }, "UTC")).toBe("Asia/Kolkata");
    expect(contactTimeZone({ phone: "+971501234567" }, "UTC")).toBe("Asia/Dubai"); // longest prefix wins over +97
    expect(contactTimeZone({ phone: "+44 7700 900123" }, "UTC")).toBe("Europe/London");
    expect(contactTimeZone({ phone: "" }, "Europe/Paris")).toBe("Europe/Paris");
  });

  it("validates preferences", () => {
    expect(sendingPreferencesSchema.safeParse({ timezone: "Nowhere/City", quietHours: { enabled: false, start: "21:00", end: "08:00" }, defaultBestHour: 10 }).success).toBe(false);
    expect(sendingPreferencesSchema.safeParse({ timezone: "UTC", quietHours: { enabled: true, start: "25:00", end: "08:00" }, defaultBestHour: 10 }).success).toBe(false);
  });
});

describe("scheduling recipients", () => {
  const prefs = (quiet: boolean) => ({ timezone: "UTC", quietHours: { enabled: quiet, start: "21:00", end: "08:00", channels: ["whatsapp", "email", "sms"] as ("whatsapp" | "email" | "sms")[] }, defaultBestHour: 10 });
  const noContacts = () => vi.spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: async () => [] }) })) as never);

  it("sends immediately when nothing applies", async () => {
    vi.spyOn(tenantSettingsRepository, "getSending").mockResolvedValue(prefs(false));
    expect(await scheduleRecipients("t", "email", null, [{ contactId: null }, { contactId: null }])).toEqual([null, null]);
  });

  it("holds sends during quiet hours in each contact's zone, unless the send ignores them", async () => {
    vi.spyOn(tenantSettingsRepository, "getSending").mockResolvedValue(prefs(true));
    noContacts();
    const start = new Date("2026-10-07T17:00:00Z"); // 22:30 in Kolkata, 18:00 in London
    const [india, uk] = await scheduleRecipients("t", "sms", { mode: "immediate" }, [{ contactId: null, phone: "+919812345678" }, { contactId: null, phone: "+447700900123" }], start);
    expect(india?.toISOString()).toBe("2026-10-08T02:30:00.000Z"); // 08:00 IST
    expect(uk).toBeNull();
    expect(await scheduleRecipients("t", "sms", { mode: "immediate", ignoreQuietHours: true }, [{ contactId: null, phone: "+919812345678" }], start)).toEqual([null]);
  });

  it("schedules local-time and best-time sends", async () => {
    vi.spyOn(tenantSettingsRepository, "getSending").mockResolvedValue(prefs(false));
    noContacts();
    const start = new Date("2026-10-07T00:00:00Z");
    const [local] = await scheduleRecipients("t", "email", { mode: "local_time", localTime: "09:15" }, [{ contactId: null, phone: "+81312345678" }], start);
    expect(local?.toISOString()).toBe("2026-10-07T00:15:00.000Z"); // 09:00 in Tokyo at start → 09:15 the same day
    vi.spyOn(delivery, "bestHoursUtc").mockResolvedValue(new Map());
    const [best] = await scheduleRecipients("t", "email", { mode: "best_time" }, [{ contactId: null, phone: "+14155550123" }], start);
    expect(best && zonedParts(best, "America/New_York").hour).toBe(10); // default hour, contact's zone
  });
});
