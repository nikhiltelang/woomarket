import crypto from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { addCycle, toMinorUnits, totals, unusedCredit } from "@shared/billing";
import type { Plan, Subscription } from "@shared/schema";
import { availableProviders, quoteFor, verifyRazorpayPayment, verifyRazorpayWebhook, verifyStripeSignature, type PaymentSettings } from "../services/billing.service";
import { billingRepository } from "../repositories/billing.repository";
import { couponsRepository } from "../repositories/coupons.repository";
import { mockSystemConfig } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("billing math", () => {
  it("applies coupon, then credit, then tax", () => {
    expect(totals(100, 10, 0, 18)).toEqual({ discount: 10, credit: 0, tax: 16.2, total: 106.2 });
    expect(totals(100, 10, 95, 18)).toEqual({ discount: 10, credit: 90, tax: 0, total: 0 }); // credit capped
    expect(totals(49, 0, 0, 0).total).toBe(49);
  });
  it("credits the unused part of a paid period", () => {
    const start = new Date("2026-10-01T00:00:00Z");
    const end = new Date("2026-10-31T00:00:00Z");
    expect(unusedCredit(300, start, end, new Date("2026-10-16T00:00:00Z"))).toBe(150);
    expect(unusedCredit(300, start, end, end)).toBe(0);
    expect(unusedCredit(0, start, end, start)).toBe(0);
  });
  it("adds months without overflowing short months", () => {
    expect(addCycle(new Date("2026-01-31T10:00:00Z"), "monthly").toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addCycle(new Date("2026-10-09T10:00:00Z"), "monthly").toISOString()).toBe("2026-11-09T10:00:00.000Z");
    expect(addCycle(new Date("2028-02-29T00:00:00Z"), "annual").toISOString()).toBe("2029-02-28T00:00:00.000Z");
  });
  it("converts to the gateway's smallest unit", () => {
    expect(toMinorUnits(106.2, "INR")).toBe(10620);
    expect(toMinorUnits(1990, "JPY")).toBe(1990);
  });
});

describe("gateways", () => {
  const settings = (o: Partial<PaymentSettings> = {}): PaymentSettings => ({ stripe: { enabled: false, publishableKey: "", secretKey: null, webhookSecret: null }, razorpay: { enabled: false, keyId: "", keySecret: null, webhookSecret: null }, taxRate: 0, taxLabel: "Tax", invoiceDetails: "", trialPlanId: null, trialDays: 0, ...o });
  it("offers configured gateways, or the simulator in development", () => {
    expect(availableProviders(settings())).toEqual(["simulator"]);
    expect(availableProviders(settings({ stripe: { enabled: true, publishableKey: "", secretKey: "sk_test_x", webhookSecret: null }, razorpay: { enabled: true, keyId: "rzp", keySecret: "s", webhookSecret: null } }))).toEqual(["stripe", "razorpay"]);
    expect(availableProviders(settings({ stripe: { enabled: true, publishableKey: "", secretKey: null, webhookSecret: null } }))).toEqual(["simulator"]);
  });
  it("verifies Stripe webhook signatures with a 5-minute tolerance", () => {
    const body = '{"id":"evt_1"}';
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_test")).toBe(true);
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other")).toBe(false);
    expect(verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, "whsec_test")).toBe(false);
    expect(verifyStripeSignature(body, `t=${t - 600},v1=${crypto.createHmac("sha256", "whsec_test").update(`${t - 600}.${body}`).digest("hex")}`, "whsec_test")).toBe(false);
  });
  it("verifies Razorpay checkout and webhook signatures", () => {
    const sig = crypto.createHmac("sha256", "key_secret").update("order_1|pay_1").digest("hex");
    expect(verifyRazorpayPayment("order_1", "pay_1", sig, "key_secret")).toBe(true);
    expect(verifyRazorpayPayment("order_1", "pay_2", sig, "key_secret")).toBe(false);
    const body = '{"event":"payment.captured"}';
    expect(verifyRazorpayWebhook(body, crypto.createHmac("sha256", "wh").update(body).digest("hex"), "wh")).toBe(true);
    expect(verifyRazorpayWebhook(body, undefined, "wh")).toBe(false);
  });
});

describe("quotes", () => {
  const plan = (id: string, monthly: number, annual: number) => ({ id, name: id, monthlyPrice: monthly.toFixed(2), annualPrice: annual.toFixed(2), permissions: {} }) as unknown as Plan;
  const pro = plan("pro", 49, 490);
  const ent = plan("ent", 199, 1990);
  const sub = (o: Partial<Subscription>) => ({ id: "s1", userId: "t1", planId: "pro", billingCycle: "monthly", status: "active", amount: "49.00", startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-11-01T00:00:00Z"), planData: { name: "pro", permissions: {} }, ...o }) as Subscription;
  const setup = (current?: Subscription) => {
    mockSystemConfig({ currency: "INR", extensionSettings: { payments: { stripe: { enabled: false, publishableKey: "" }, razorpay: { enabled: false, keyId: "" }, taxRate: 18, taxLabel: "GST", invoiceDetails: "", trialDays: 0 } } });
    vi.spyOn(billingRepository, "findPlan").mockImplementation(async (id) => [pro, ent].find((p) => p.id === id));
    vi.spyOn(billingRepository, "activeSubscription").mockResolvedValue(current);
  };
  const now = new Date("2026-10-16T12:00:00Z");

  it("renews the same plan from the end of the current period", async () => {
    setup(sub({}));
    const { quote } = await quoteFor("t1", { planId: "pro", cycle: "monthly" }, now);
    expect(quote).toMatchObject({ kind: "renew", price: 49, credit: 0, tax: 8.82, total: 57.82, currency: "INR", taxLabel: "GST", startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z" });
  });

  it("credits unused time when upgrading", async () => {
    setup(sub({}));
    const { quote } = await quoteFor("t1", { planId: "ent", cycle: "monthly" }, now);
    expect(quote.kind).toBe("switch");
    expect(quote.credit).toBeCloseTo(24.5, 1);
    expect(quote.startsAt).toBe(now.toISOString());
  });

  it("applies coupons and rejects invalid ones", async () => {
    setup(undefined);
    vi.spyOn(couponsRepository, "findByCode").mockImplementation(async (code) => (code === "TEN" ? ({ id: 1, code: "TEN", type: "percent", discountValue: "10", status: true, expiryType: "lifetime", usageLimit: -1, usedCount: 0 } as never) : undefined));
    const { quote } = await quoteFor("t1", { planId: "ent", cycle: "annual", couponCode: "TEN" }, now);
    expect(quote).toMatchObject({ kind: "new", price: 1990, discount: 199, couponCode: "TEN", tax: 322.38, total: 2113.38 });
    await expect(quoteFor("t1", { planId: "ent", cycle: "annual", couponCode: "NOPE" }, now)).rejects.toMatchObject({ code: "COUPON_INVALID" });
  });
});
