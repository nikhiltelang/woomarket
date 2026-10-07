import { describe, it, expect } from "vitest";
import { emailAbSchema, pickWinner, rate, smsAbSchema, splitAudience, whatsappAbSchema } from "@shared/ab-test";
import { emailCampaignSchema, smsCampaignSchema } from "@shared/validation";
import { abAssignments, abStartState } from "../services/marketing.service";

describe("audience split", () => {
  it("splits the test slice evenly and holds the rest", () => {
    const { A, B, held } = splitAudience(Array.from({ length: 1000 }, (_, i) => i), 20);
    expect(A.length).toBe(100);
    expect(B.length).toBe(100);
    expect(held.length).toBe(800);
    expect(new Set([...A, ...B, ...held]).size).toBe(1000);
  });

  it("100% splits everyone; tiny audiences aren't tested", () => {
    const all = splitAudience([1, 2, 3, 4, 5, 6], 100);
    expect(all.held).toEqual([]);
    expect(all.A.length + all.B.length).toBe(6);
    expect(splitAudience([1, 2, 3], 50)).toEqual({ A: [1, 2, 3], B: [], held: [] });
  });

  it("assigns per audience position and records the state", () => {
    const v = abAssignments(50, { testPercent: 40 });
    expect(v.filter((x) => x === "A").length).toBe(10);
    expect(v.filter((x) => x === "B").length).toBe(10);
    expect(v.filter((x) => x === "held").length).toBe(30);
    expect(abAssignments(3, null)).toEqual([null, null, null]);
    const state = abStartState({ enabled: true, waitHours: 2 }, v);
    expect(state).toMatchObject({ phase: "testing", held: 30, winner: null });
    expect(new Date(String(state.testEndsAt)).getTime()).toBeGreaterThan(Date.now() + 1.9 * 3600e3);
    expect(abStartState({ enabled: true }, abAssignments(3, { testPercent: 50 }))).toMatchObject({ phase: "skipped" });
  });
});

describe("winner", () => {
  it("prefers the higher rate; ties keep the original", () => {
    expect(pickWinner({ A: { sent: 100, hits: 20, rate: 20 }, B: { sent: 100, hits: 25, rate: 25 } })).toBe("B");
    expect(pickWinner({ A: { sent: 100, hits: 20, rate: 20 }, B: { sent: 100, hits: 20, rate: 20 } })).toBe("A");
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(5, 0)).toBe(0);
  });
});

describe("settings", () => {
  const base = { name: "x", subject: "Hi", senderName: "S", contentHtml: "<p>x</p>", targetAudience: "all_contacts" };
  it("requires something to differ in variant B", () => {
    expect(emailAbSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(emailAbSchema.safeParse({ enabled: true, subjectB: "Other" }).success).toBe(true);
    expect(smsAbSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(whatsappAbSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(emailAbSchema.safeParse({ enabled: true, subjectB: "x", testPercent: 5 }).success).toBe(false);
  });
  it("click-rate tests need click tracking", () => {
    expect(emailCampaignSchema.safeParse({ ...base, trackClicks: false, abTest: { enabled: true, metric: "click", subjectB: "B" } }).success).toBe(false);
    expect(emailCampaignSchema.safeParse({ ...base, trackClicks: false, abTest: { enabled: true, metric: "open", subjectB: "B" } }).success).toBe(true);
    expect(smsCampaignSchema.safeParse({ name: "x", message: "Hi", targetAudience: "all_contacts", trackClicks: false, abTest: { enabled: true, messageB: "Yo" } }).success).toBe(false);
  });
});
