import { describe, it, expect } from "vitest";
import { daysBetween, formatDuration, nextScheduleRun, rangeInstants, reportQuerySchema, reportScheduleSchema, schedulePeriod } from "@shared/reports";
import { computeReplies, responseTimesFrom, stats, type MessageRow } from "../services/reports.service";
import { csvCell, reportCsv, reportPdf } from "../services/report-export";

const t = (iso: string) => new Date(iso);
const W = { start: t("2026-10-01T00:00:00Z"), end: t("2026-10-08T00:00:00Z"), offset: 0 };
const row = (conversationId: string, direction: string, at: string, sentBy: string | null = null): MessageRow => ({ conversationId, direction, at: t(at), sentBy });

describe("response times", () => {
  it("measures from the first unanswered customer message to the next human reply", () => {
    const rows = [
      row("a", "inbound", "2026-10-02T10:00:00Z"),
      row("a", "inbound", "2026-10-02T10:03:00Z"), // still the same wait
      row("a", "outbound", "2026-10-02T10:05:00Z", null), // automated: not a reply
      row("a", "outbound", "2026-10-02T10:10:00Z", "u1"), // 10 min
      row("a", "inbound", "2026-10-02T11:00:00Z"),
      row("a", "outbound", "2026-10-02T11:01:00Z", "u2"), // 1 min
      row("b", "inbound", "2026-10-03T09:00:00Z"),
      row("b", "outbound", "2026-10-03T13:00:00Z", "u1"), // 4 h
      row("c", "inbound", "2026-10-07T20:00:00Z"), // still waiting
      row("d", "inbound", "2026-09-30T23:00:00Z"), // started before the period
      row("d", "outbound", "2026-10-01T00:30:00Z", "u2"), // answered inside: counts (90 min)
    ];
    const { replies, awaiting } = computeReplies(rows, W);
    expect(replies.map((r) => [r.agent, r.seconds, r.first])).toEqual([
      ["u1", 600, true],
      ["u2", 60, false],
      ["u1", 14400, true],
      ["u2", 5400, true],
    ]);
    expect(awaiting).toBe(1);
    const report = responseTimesFrom(replies, awaiting, daysBetween("2026-10-01", "2026-10-07"), false);
    expect(report.first).toMatchObject({ count: 3, median: 5400 });
    expect(report.all.count).toBe(4);
    expect(report.buckets.map((b) => b.count)).toEqual([1, 1, 0, 1, 1, 0]);
    expect(report.daily.find((d) => d.day === "2026-10-02")).toMatchObject({ count: 2, median: 60 });
  });

  it("computes percentiles", () => {
    expect(stats([])).toEqual({ count: 0, avg: null, median: null, p90: null });
    expect(stats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual({ count: 10, avg: 55, median: 50, p90: 90 });
    expect(formatDuration(5400)).toBe("1h 30m");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(200000)).toBe("2d 7h");
  });
});

describe("periods", () => {
  it("covers whole local days", () => {
    const r = rangeInstants("2026-10-01", "2026-10-07", "Asia/Kolkata");
    expect(r.start.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-07T18:30:00.000Z");
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(reportQuerySchema.safeParse({ from: "2026-10-08", to: "2026-10-01" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: "2025-01-01", to: "2026-10-01" }).success).toBe(false);
  });

  it("picks the last complete day, week or month", () => {
    const now = t("2026-10-08T03:00:00Z"); // 08:30 in Kolkata, Thursday
    expect(schedulePeriod("daily", now, "Asia/Kolkata")).toEqual({ from: "2026-10-07", to: "2026-10-07" });
    expect(schedulePeriod("weekly", now, "Asia/Kolkata")).toEqual({ from: "2026-10-01", to: "2026-10-07" });
    expect(schedulePeriod("monthly", now, "Asia/Kolkata")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(schedulePeriod("monthly", t("2026-01-05T00:00:00Z"), "UTC")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("schedules the next run in the tenant's zone", () => {
    const after = t("2026-10-08T03:00:00Z");
    expect(nextScheduleRun({ frequency: "daily", dayOfWeek: 1, hour: 8 }, after, "Asia/Kolkata").toISOString()).toBe("2026-10-09T02:30:00.000Z");
    expect(nextScheduleRun({ frequency: "daily", dayOfWeek: 1, hour: 9 }, after, "Asia/Kolkata").toISOString()).toBe("2026-10-08T03:30:00.000Z");
    expect(nextScheduleRun({ frequency: "weekly", dayOfWeek: 1, hour: 8 }, after, "UTC").toISOString()).toBe("2026-10-12T08:00:00.000Z");
    expect(nextScheduleRun({ frequency: "monthly", dayOfWeek: 1, hour: 6 }, after, "America/New_York").toISOString()).toBe("2026-11-01T11:00:00.000Z");
    expect(reportScheduleSchema.safeParse({ name: "x", sections: [], frequency: "daily", recipients: ["a@b.co"] }).success).toBe(false);
  });
});

describe("exports", () => {
  const report = {
    query: { from: "2026-10-01", to: "2026-10-02" },
    timezone: "UTC",
    generatedAt: new Date().toISOString(),
    overview: {
      whatsapp: { conversationsSent: 4, received: 6, delivered: 3, read: 2, failed: 1, campaignSent: 10, campaignDelivered: 9, campaignRead: 5, campaignReplied: 2, campaignFailed: 1 },
      email: { recipients: 5, sent: 5, opened: 2, clicked: 1, bounced: 0, failed: 0, unsubscribed: 0 },
      sms: { recipients: 3, sent: 3, delivered: 3, failed: 0, clicked: 1 },
      daily: [
        { day: "2026-10-01", whatsappSent: 3, whatsappReceived: 2, emailSent: 5, smsSent: 0 },
        { day: "2026-10-02", whatsappSent: 1, whatsappReceived: 4, emailSent: 0, smsSent: 3 },
      ],
    },
    team: [{ userId: "u", name: "=HYPERLINK(\"evil\")", role: "agent", messagesSent: 3, conversations: 2, openAssigned: 1, resolved: 1, count: 2, avg: 60, median: 60, p90: 90 }],
    responseTimes: { first: stats([60]), all: stats([60, 120]), buckets: [{ label: "Under 5 min", count: 2 }], daily: [], awaiting: 0, truncated: false },
  };

  it("neutralises formulas in CSV", () => {
    expect(csvCell("=1+1")).toBe(`"'=1+1"`);
    expect(csvCell("+14155550123")).toBe(`"+14155550123"`);
    const team = reportCsv(report, "team");
    expect(team).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(reportCsv(report, "overview").split("\r\n")[1]).toBe(`"2026-10-01","3","2","5","0"`);
  });

  it("renders a PDF", async () => {
    const pdf = await reportPdf(report, { title: "Weekly report", tenantName: "Demo Shop ✓ नमस्ते ₹500" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
    // Noto Sans is embedded (subset), so Hindi and "₹" print instead of "?".
    expect(pdf.toString("latin1")).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans/);
  });
});

describe("scheduled report email", () => {
  it("attaches a PDF and one CSV per section, and records the result", async () => {
    const { vi } = await import("vitest");
    const mail = await import("../services/email/system-mail");
    const reports = await import("../services/reports.service");
    const sched = await import("../services/report-schedules.service");
    const { usersRepository } = await import("../repositories/users.repository");
    const { systemConfig } = await import("../services/system-config.service");
    const { makeSystemConfig, makeUser } = await import("./helpers");
    const sent: { to: string; subject: string; attachments?: { filename: string; contentType: string; content: Buffer }[] }[] = [];
    vi.spyOn(mail, "sendSystemEmail").mockImplementation(async (to, subject, _html, opts) => {
      expect(opts?.forUserId).toBe("t1");
      sent.push({ to, subject, attachments: opts?.attachments });
      return { simulated: true };
    });
    const { tenantSettingsRepository } = await import("../services/delivery.service");
    const { DEFAULT_SENDING_PREFERENCES } = await import("@shared/sending");
    vi.spyOn(tenantSettingsRepository, "getSending").mockResolvedValue({ ...DEFAULT_SENDING_PREFERENCES, timezone: "UTC" });
    vi.spyOn(reports, "buildReport").mockResolvedValue({
      query: { from: "2026-09-28", to: "2026-10-04" },
      timezone: "UTC",
      generatedAt: new Date().toISOString(),
      team: [],
      responseTimes: { first: stats([]), all: stats([]), buckets: [], daily: [], awaiting: 0, truncated: false },
    });
    vi.spyOn(usersRepository, "findById").mockResolvedValue(makeUser({ firstName: "Demo", lastName: "Shop" }));
    vi.spyOn(systemConfig, "get").mockResolvedValue(makeSystemConfig());
    const update = vi.spyOn(sched.reportSchedulesRepository, "update").mockResolvedValue(undefined);
    const s = { id: "s1", userId: "t1", name: "Weekly team", sections: ["team", "response-times"], frequency: "weekly", dayOfWeek: 1, hour: 8, format: "both", recipients: ["a@x.test", "b@x.test"], channelId: null } as never;
    const status = await sched.sendScheduledReport(s, new Date("2026-10-05T08:00:00Z"));
    expect(status).toBe("sent to 2 recipients");
    expect(sent.map((m) => m.to)).toEqual(["a@x.test", "b@x.test"]);
    expect(sent[0].subject).toBe("Weekly team: 2026-09-28 to 2026-10-04");
    expect(sent[0].attachments!.map((a) => a.filename)).toEqual(["weekly-team-2026-09-28-to-2026-10-04.pdf", "weekly-team-2026-09-28-to-2026-10-04-team.csv", "weekly-team-2026-09-28-to-2026-10-04-response-times.csv"]);
    expect(sent[0].attachments![0].content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(update).toHaveBeenCalledWith("s1", expect.objectContaining({ lastStatus: "sent to 2 recipients" }));
    vi.restoreAllMocks();
  });
});
