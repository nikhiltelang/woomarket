/**
 * Self-serve billing (see shared/billing.ts): quotes, Stripe / Razorpay checkout, fulfilment into a
 * subscription period, invoices, gateway webhooks, expiry reminders and trials.
 */
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { and, desc, eq, gt, lt, lte, max, sql } from "drizzle-orm";
import { addCycle, formatMoney, toMinorUnits, totals, unusedCredit, type BillingCycle, type BillingQuote, type CheckoutInput, type PaymentProvider, type PublicBillingConfig } from "@shared/billing";
import { payments, subscriptions, type Payment, type Plan, type PlanLimits, type Subscription, type User } from "@shared/schema";
import { config } from "../config";
import { db } from "../db";
import { decryptStoredSecret } from "../lib/crypto";
import { AppError, conflict, notFound, unprocessable } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { publicBaseUrl } from "../lib/tokens";
import { timingSafeEqualStr } from "../lib/crypto";
import { billingRepository } from "../repositories/billing.repository";
import { couponsRepository } from "../repositories/coupons.repository";
import { usersRepository } from "../repositories/users.repository";
import { quote as couponQuote, planPrice } from "./coupon.service";
import { sendSystemEmail } from "./email/system-mail";
import { escapeHtml } from "./email/render";
import { NOTO, pdfText, unicodeFont } from "./report-export";
import { systemConfig } from "./system-config.service";

const log = childLogger("billing");
/** Checkout links and orders not paid within this time are given up. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface PaymentSettings {
  stripe: { enabled: boolean; publishableKey: string; secretKey: string | null; webhookSecret: string | null };
  razorpay: { enabled: boolean; keyId: string; keySecret: string | null; webhookSecret: string | null };
  taxRate: number;
  taxLabel: string;
  invoiceDetails: string;
  trialPlanId: string | null;
  trialDays: number;
}

const secret = (v: string | undefined) => (v ? decryptStoredSecret(v) : null);

export async function paymentSettings(): Promise<PaymentSettings> {
  const p = (await systemConfig.get()).extensionSettings?.payments;
  return {
    stripe: { enabled: Boolean(p?.stripe?.enabled), publishableKey: p?.stripe?.publishableKey ?? "", secretKey: secret(p?.stripe?.secretKey), webhookSecret: secret(p?.stripe?.webhookSecret) },
    razorpay: { enabled: Boolean(p?.razorpay?.enabled), keyId: p?.razorpay?.keyId ?? "", keySecret: secret(p?.razorpay?.keySecret), webhookSecret: secret(p?.razorpay?.webhookSecret) },
    taxRate: p?.taxRate ?? 0,
    taxLabel: p?.taxLabel || "Tax",
    invoiceDetails: p?.invoiceDetails ?? "",
    trialPlanId: p?.trialPlanId ?? null,
    trialDays: p?.trialDays ?? 0,
  };
}

/** Gateways a tenant can pay with right now (the simulator only on development servers without any). */
export function availableProviders(s: PaymentSettings): PaymentProvider[] {
  const list: PaymentProvider[] = [];
  if (s.stripe.enabled && s.stripe.secretKey) list.push("stripe");
  if (s.razorpay.enabled && s.razorpay.keyId && s.razorpay.keySecret) list.push("razorpay");
  if (!list.length && !config.isProduction) list.push("simulator");
  return list;
}

async function currency(): Promise<{ code: string; symbol: string }> {
  const c = await systemConfig.get();
  return { code: (c.currency || "USD").toUpperCase(), symbol: c.currencySymbol || "$" };
}

export async function publicBillingConfig(): Promise<PublicBillingConfig> {
  const [s, cur] = await Promise.all([paymentSettings(), currency()]);
  const providers = availableProviders(s);
  return { currency: cur.code, currencySymbol: cur.symbol, providers, razorpayKeyId: providers.includes("razorpay") ? s.razorpay.keyId : null, taxRate: s.taxRate, taxLabel: s.taxLabel };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const paymentsRepository = {
  async find(id: string): Promise<Payment | undefined> {
    const [row] = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
    return row;
  },
  async byRef(provider: PaymentProvider, ref: string): Promise<Payment | undefined> {
    const [row] = await db.select().from(payments).where(and(eq(payments.provider, provider), eq(payments.providerRef, ref))).limit(1);
    return row;
  },
  async create(values: Omit<typeof payments.$inferInsert, "id">): Promise<Payment> {
    const id = crypto.randomUUID();
    await db.insert(payments).values({ ...values, id });
    return (await this.find(id))!;
  },
  async update(id: string, patch: Partial<typeof payments.$inferInsert>) {
    await db.update(payments).set(patch).where(eq(payments.id, id));
  },
  /** pending → failed / expired (never touches a paid payment). */
  async settle(id: string, status: "failed" | "expired", reason?: string) {
    await db.update(payments).set({ status, failureReason: reason?.slice(0, 500) ?? null }).where(and(eq(payments.id, id), eq(payments.status, "pending")));
  },
  forTenant(userId: string, limit = 50) {
    return db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.createdAt)).limit(limit);
  },
  list(opts: { status?: string; limit?: number } = {}) {
    return db.select().from(payments).where(opts.status ? eq(payments.status, opts.status) : undefined).orderBy(desc(payments.createdAt)).limit(opts.limit ?? 200);
  },
  async revenue(since: Date) {
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)`, total: sql<string>`COALESCE(SUM(${payments.total}), 0)`, tax: sql<string>`COALESCE(SUM(${payments.tax}), 0)` })
      .from(payments)
      .where(and(eq(payments.status, "paid"), gt(payments.paidAt, since)));
    return { payments: Number(row.n), total: Number(row.total), tax: Number(row.tax) };
  },
  /** Gives up checkouts nobody finished. */
  async expireStale(now = new Date()) {
    const [res] = await db.update(payments).set({ status: "expired" }).where(and(eq(payments.status, "pending"), lt(payments.createdAt, new Date(now.getTime() - PENDING_TTL_MS))));
    return res.affectedRows;
  },
};

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

const money = (n: number) => n.toFixed(2);

/** What the tenant would pay for a plan now, and which period it buys. */
export async function quoteFor(tenantId: string, input: Pick<CheckoutInput, "planId" | "cycle" | "couponCode">, now = new Date()): Promise<{ quote: BillingQuote; plan: Plan; current: Subscription | undefined }> {
  const plan = await billingRepository.findPlan(input.planId);
  if (!plan) throw notFound("Plan");
  const [s, cur, current] = await Promise.all([paymentSettings(), currency(), billingRepository.activeSubscription(tenantId, now)]);
  const priced = await couponQuote(plan, input.cycle, input.couponCode || null);
  const price = planPrice(plan, input.cycle);
  // Same paid plan: the new period starts when the current one ends.
  const renew = Boolean(current && current.planId === plan.id && current.billingCycle === input.cycle && Number(current.amount ?? 0) > 0);
  const credit = !renew && current && current.planId !== plan.id ? unusedCredit(Number(current.amount ?? 0), current.startDate, current.endDate, now) : 0;
  const t = totals(price, priced.discount, credit, s.taxRate);
  const start = renew ? current!.endDate : now;
  return {
    plan,
    current,
    quote: {
      planId: plan.id,
      planName: plan.name,
      cycle: input.cycle,
      currency: cur.code,
      price,
      discount: t.discount,
      couponCode: priced.coupon?.code ?? null,
      credit: t.credit,
      tax: t.tax,
      taxRate: s.taxRate,
      taxLabel: s.taxLabel,
      total: t.total,
      kind: renew ? "renew" : current ? "switch" : "new",
      startsAt: start.toISOString(),
      endsAt: addCycle(start, input.cycle).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export type CheckoutResult =
  | { kind: "done"; payment: Payment | null; subscription: Subscription }
  | { kind: "redirect"; payment: Payment; url: string }
  | { kind: "razorpay"; payment: Payment; order: { keyId: string; orderId: string; amount: number; currency: string; name: string; description: string; prefill: { name: string; email: string } } }
  | { kind: "simulate"; payment: Payment };

const displayName = (u: User) => [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;

export async function startCheckout(user: User, input: CheckoutInput): Promise<CheckoutResult> {
  const { quote, plan } = await quoteFor(user.id, input);
  const s = await paymentSettings();
  const billedTo = { name: displayName(user), email: user.email };

  // Nothing to pay (free plan, or fully covered by a coupon / credit): switch right away.
  if (quote.total <= 0) {
    const subscription = await applyPeriod(user.id, plan, quote, null, "none");
    return { kind: "done", payment: null, subscription };
  }
  const providers = availableProviders(s);
  const provider = input.provider ?? providers[0];
  if (!provider || !providers.includes(provider)) throw unprocessable("Online payment isn't available right now. Please contact support.", "NO_PAYMENT_PROVIDER");

  const payment = await paymentsRepository.create({
    userId: user.id,
    planId: plan.id,
    planName: plan.name,
    billingCycle: quote.cycle,
    currency: quote.currency,
    price: money(quote.price),
    discount: money(quote.discount),
    credit: money(quote.credit),
    tax: money(quote.tax),
    taxRate: money(quote.taxRate),
    taxLabel: quote.taxLabel,
    total: money(quote.total),
    couponCode: quote.couponCode,
    provider,
    status: "pending",
    billedTo,
  });
  const description = `${plan.name} plan, ${quote.cycle === "annual" ? "1 year" : "1 month"}`;

  if (provider === "simulator") return { kind: "simulate", payment };

  if (provider === "stripe") {
    const base = publicBaseUrl();
    const session = await stripe.call<{ id: string; url: string }>(s, "POST", "v1/checkout/sessions", {
      mode: "payment",
      success_url: `${base}/plans?payment=${payment.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/plans?payment=${payment.id}&cancelled=1`,
      client_reference_id: payment.id,
      customer_email: user.email,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": quote.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(toMinorUnits(quote.total, quote.currency)),
      "line_items[0][price_data][product_data][name]": description,
      "metadata[payment_id]": payment.id,
      "payment_intent_data[metadata][payment_id]": payment.id,
      expires_at: String(Math.floor(Date.now() / 1000) + 23 * 3600),
    });
    await paymentsRepository.update(payment.id, { providerRef: session.id });
    return { kind: "redirect", payment: { ...payment, providerRef: session.id }, url: session.url };
  }

  const order = await razorpay.call<{ id: string; amount: number; currency: string }>(s, "POST", "v1/orders", {
    amount: toMinorUnits(quote.total, quote.currency),
    currency: quote.currency,
    receipt: payment.id.replace(/-/g, "").slice(0, 40),
    notes: { payment_id: payment.id, plan: plan.name },
  });
  await paymentsRepository.update(payment.id, { providerRef: order.id });
  const site = (await systemConfig.get()).siteTitle || "WooMarket360";
  return { kind: "razorpay", payment: { ...payment, providerRef: order.id }, order: { keyId: s.razorpay.keyId, orderId: order.id, amount: order.amount, currency: order.currency, name: site, description, prefill: billedTo } };
}

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

/**
 * Creates the subscription period a quote describes. A renewal starts when the current period
 * ends (both stay active until then); anything else replaces the current plan now.
 */
async function applyPeriod(userId: string, plan: Plan, q: BillingQuote, paymentId: string | null, provider: string): Promise<Subscription> {
  const id = crypto.randomUUID();
  await db.transaction(async (t) => {
    if (q.kind !== "renew") await t.update(subscriptions).set({ status: "replaced" }).where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active")));
    await t.insert(subscriptions).values({
      id,
      userId,
      planId: plan.id,
      planData: { name: plan.name, permissions: (plan.permissions ?? {}) as PlanLimits },
      status: "active",
      billingCycle: q.cycle,
      startDate: new Date(q.startsAt),
      endDate: new Date(q.endsAt),
      autoRenew: false,
      gatewayProvider: provider,
      gatewayStatus: "paid",
      amount: money(q.total - q.tax),
      discount: money(q.discount),
      couponCode: q.couponCode,
      paymentId,
    });
    if (q.couponCode) {
      const coupon = await couponsRepository.findByCode(q.couponCode);
      // Paid already: a coupon used up meanwhile is honoured, just not counted twice.
      if (coupon && !(await couponsRepository.redeem(t, coupon.id, userId, id, money(q.discount)))) log.warn({ userId, coupon: q.couponCode }, "Coupon was used up before the payment completed");
    }
  });
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  return row;
}

const quoteOf = (p: Payment, start: Date): BillingQuote => ({
  planId: p.planId ?? "",
  planName: p.planName,
  cycle: p.billingCycle as BillingCycle,
  currency: p.currency,
  price: Number(p.price),
  discount: Number(p.discount),
  couponCode: p.couponCode,
  credit: Number(p.credit),
  tax: Number(p.tax),
  taxRate: Number(p.taxRate),
  taxLabel: p.taxLabel ?? "Tax",
  total: Number(p.total),
  kind: "new",
  startsAt: start.toISOString(),
  endsAt: addCycle(start, p.billingCycle as BillingCycle).toISOString(),
});

/**
 * Marks a payment paid and gives the tenant the period it bought. Idempotent: webhooks, the return
 * page and polling can all call it; only the first succeeds.
 */
export async function fulfil(paymentId: string, providerPaymentId: string | null, now = new Date()): Promise<{ payment: Payment; fulfilled: boolean }> {
  const [res] = await db.update(payments).set({ status: "paid", paidAt: now, providerPaymentId, failureReason: null }).where(and(eq(payments.id, paymentId), sql`${payments.status} IN ('pending','expired','failed')`));
  const p = (await paymentsRepository.find(paymentId))!;
  if (res.affectedRows === 0) return { payment: p, fulfilled: false };
  const plan = p.planId ? await billingRepository.findPlan(p.planId) : undefined;
  if (!plan) throw new AppError(500, "The paid plan no longer exists", "PLAN_MISSING");
  // Work out the period now (the tenant's plan may have changed since the checkout started).
  const current = await billingRepository.activeSubscription(p.userId, now);
  const renew = Boolean(current && current.planId === plan.id && current.billingCycle === p.billingCycle && Number(current.amount ?? 0) > 0);
  const q = { ...quoteOf(p, renew ? current!.endDate : now), kind: renew ? ("renew" as const) : current ? ("switch" as const) : ("new" as const) };
  const sub = await applyPeriod(p.userId, plan, q, p.id, p.provider);
  await assignInvoiceNumber(p.id, now);
  await paymentsRepository.update(p.id, { subscriptionId: sub.id });
  const fresh = (await paymentsRepository.find(p.id))!;
  log.info({ paymentId: p.id, userId: p.userId, plan: plan.name, total: p.total, provider: p.provider }, "Payment received");
  void sendReceipt(fresh, sub).catch((err) => log.warn({ err: (err as Error).message }, "Receipt email failed"));
  return { payment: fresh, fulfilled: true };
}

/** INV-2026-000123: sequential per year, no gaps on retries (unique index guards the race). */
async function assignInvoiceNumber(paymentId: string, now: Date) {
  const year = now.getUTCFullYear();
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ m }] = await db.select({ m: max(payments.invoiceSeq) }).from(payments).where(eq(payments.invoiceYear, year));
    const seq = (m ?? 0) + 1;
    try {
      await db.update(payments).set({ invoiceYear: year, invoiceSeq: seq, invoiceNumber: `INV-${year}-${String(seq).padStart(6, "0")}` }).where(and(eq(payments.id, paymentId), sql`${payments.invoiceSeq} IS NULL`));
      return;
    } catch (err) {
      if (!String((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code).includes("DUP")) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

export class GatewayError extends Error {}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const stripe = {
  async call<T>(s: PaymentSettings, method: "GET" | "POST", path: string, body?: Record<string, string>): Promise<T> {
    if (!s.stripe.secretKey) throw new GatewayError("Stripe isn't configured");
    const res = await fetch(`${config.STRIPE_API_URL.replace(/\/$/, "")}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${s.stripe.secretKey}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: body ? form(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok || json.error) throw new GatewayError(`Stripe: ${json.error?.message ?? res.status}`);
    return json;
  },
};

export const razorpay = {
  async call<T>(s: PaymentSettings, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!s.razorpay.keyId || !s.razorpay.keySecret) throw new GatewayError("Razorpay isn't configured");
    const res = await fetch(`${config.RAZORPAY_API_URL.replace(/\/$/, "")}/${path}`, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${s.razorpay.keyId}:${s.razorpay.keySecret}`).toString("base64")}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
    if (!res.ok || json.error) throw new GatewayError(`Razorpay: ${json.error?.description ?? res.status}`);
    return json;
  },
};

const hmac = (key: string, data: string) => crypto.createHmac("sha256", key).update(data).digest("hex");

/** Stripe-Signature: "t=…,v1=…" over `${t}.${body}`, within 5 minutes. */
export function verifyStripeSignature(raw: Buffer | string, header: string | undefined, secretKey: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = hmac(secretKey, `${t}.${raw.toString()}`);
  return sigs.some((s) => timingSafeEqualStr(s, expected));
}

export const verifyRazorpayPayment = (orderId: string, paymentId: string, signature: string, keySecret: string) => timingSafeEqualStr(hmac(keySecret, `${orderId}|${paymentId}`), signature);
export const verifyRazorpayWebhook = (raw: Buffer | string, signature: string | undefined, webhookSecret: string) => Boolean(signature) && timingSafeEqualStr(hmac(webhookSecret, raw.toString()), signature!);

/** Asks the gateway whether a pending payment went through (return page, "check again"). */
export async function confirmPayment(p: Payment): Promise<Payment> {
  if (p.status !== "pending" || !p.providerRef) return p;
  const s = await paymentSettings();
  try {
    if (p.provider === "stripe") {
      const session = await stripe.call<{ payment_status?: string; status?: string; payment_intent?: string | null }>(s, "GET", `v1/checkout/sessions/${encodeURIComponent(p.providerRef)}`);
      if (session.payment_status === "paid") return (await fulfil(p.id, session.payment_intent ?? null)).payment;
      if (session.status === "expired") await paymentsRepository.settle(p.id, "expired");
    } else if (p.provider === "razorpay") {
      const list = await razorpay.call<{ items?: { id: string; status: string; error_description?: string }[] }>(s, "GET", `v1/orders/${encodeURIComponent(p.providerRef)}/payments`);
      const captured = list.items?.find((x) => x.status === "captured");
      if (captured) return (await fulfil(p.id, captured.id)).payment;
    }
  } catch (err) {
    log.warn({ paymentId: p.id, err: (err as Error).message }, "Couldn't confirm payment with the gateway");
  }
  return (await paymentsRepository.find(p.id))!;
}

/** Razorpay Checkout handler result (browser → server); the signature proves it came from Razorpay. */
export async function verifyRazorpayCheckout(p: Payment, r: { orderId: string; paymentId: string; signature: string }): Promise<Payment> {
  const s = await paymentSettings();
  if (p.provider !== "razorpay" || r.orderId !== p.providerRef) throw unprocessable("This payment doesn't match the order.", "ORDER_MISMATCH");
  if (!s.razorpay.keySecret || !verifyRazorpayPayment(r.orderId, r.paymentId, r.signature, s.razorpay.keySecret)) throw unprocessable("The payment couldn't be verified.", "BAD_SIGNATURE");
  return (await fulfil(p.id, r.paymentId)).payment;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: { id: string; client_reference_id?: string | null; payment_status?: string; payment_intent?: string | null; metadata?: Record<string, string> } };
}

/** POST /webhooks/stripe */
export async function handleStripeWebhook(raw: Buffer | undefined, signature: string | undefined): Promise<{ status: number; result: string }> {
  const s = await paymentSettings();
  if (!raw || !s.stripe.webhookSecret || !verifyStripeSignature(raw, signature, s.stripe.webhookSecret)) return { status: 400, result: "bad signature" };
  const ev = JSON.parse(raw.toString()) as StripeEvent;
  const o = ev.data?.object ?? ({} as StripeEvent["data"]["object"]);
  const p = (o.client_reference_id && (await paymentsRepository.find(o.client_reference_id))) || (await paymentsRepository.byRef("stripe", o.id));
  if (!p) return { status: 200, result: "unknown session" };
  if ((ev.type === "checkout.session.completed" && o.payment_status === "paid") || ev.type === "checkout.session.async_payment_succeeded") {
    const r = await fulfil(p.id, o.payment_intent ?? null);
    return { status: 200, result: r.fulfilled ? "fulfilled" : "already done" };
  }
  if (ev.type === "checkout.session.async_payment_failed") await paymentsRepository.settle(p.id, "failed", "The payment failed");
  if (ev.type === "checkout.session.expired") await paymentsRepository.settle(p.id, "expired");
  return { status: 200, result: "ok" };
}

interface RazorpayEvent {
  event: string;
  payload: { payment?: { entity: { id: string; order_id: string; status: string; error_description?: string } }; order?: { entity: { id: string } } };
}

/** POST /webhooks/razorpay */
export async function handleRazorpayWebhook(raw: Buffer | undefined, signature: string | undefined): Promise<{ status: number; result: string }> {
  const s = await paymentSettings();
  if (!raw || !s.razorpay.webhookSecret || !verifyRazorpayWebhook(raw, signature, s.razorpay.webhookSecret)) return { status: 400, result: "bad signature" };
  const ev = JSON.parse(raw.toString()) as RazorpayEvent;
  const pay = ev.payload?.payment?.entity;
  const orderId = pay?.order_id ?? ev.payload?.order?.entity?.id;
  const p = orderId ? await paymentsRepository.byRef("razorpay", orderId) : undefined;
  if (!p) return { status: 200, result: "unknown order" };
  if (ev.event === "payment.captured" || ev.event === "order.paid") {
    const r = await fulfil(p.id, pay?.id ?? null);
    return { status: 200, result: r.fulfilled ? "fulfilled" : "already done" };
  }
  if (ev.event === "payment.failed") await paymentsRepository.settle(p.id, "failed", pay?.error_description ?? "The payment failed");
  return { status: 200, result: "ok" };
}

/** Development servers without a gateway: the "Test payment" page pays the order. */
export async function simulatePayment(p: Payment, outcome: "paid" | "failed"): Promise<Payment> {
  if (p.provider !== "simulator" || config.isProduction) throw conflict("Only test payments can be simulated.");
  if (outcome === "failed") {
    await paymentsRepository.settle(p.id, "failed", "Test card declined");
    return (await paymentsRepository.find(p.id))!;
  }
  return (await fulfil(p.id, `sim_${crypto.randomUUID().slice(0, 12)}`)).payment;
}

// ---------------------------------------------------------------------------
// Invoices and emails
// ---------------------------------------------------------------------------

export async function invoicePdf(p: Payment): Promise<Buffer> {
  const [s, cfg, panel] = await Promise.all([paymentSettings(), systemConfig.get(), systemConfig.panel()]);
  const seller = cfg.siteTitle || panel.name;
  const brand = /^#[0-9a-f]{6}$/i.test(cfg.siteBaseColor ?? "") ? cfg.siteBaseColor! : "#16a34a";
  const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: `Invoice ${p.invoiceNumber ?? ""}`, Author: seller } });
  const unicode = Boolean(unicodeFont());
  if (unicode) {
    doc.registerFont("Body", NOTO.regular);
    doc.registerFont("Body-Bold", NOTO.bold);
  }
  const F = unicode ? { r: "Body", b: "Body-Bold" } : { r: "Helvetica", b: "Helvetica-Bold" };
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width - 112;
  const m = (n: string | number) => pdfText(formatMoney(Number(n), p.currency));
  const date = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

  doc.font(F.b).fontSize(20).fillColor(brand).text(pdfText(seller), 56, 56);
  doc.font(F.r).fontSize(9).fillColor("#6b7280").text(pdfText(s.invoiceDetails || [panel.companyName, panel.supportEmail].filter(Boolean).join("\n")), 56, doc.y + 4, { width: W / 2 });
  doc.font(F.b).fontSize(16).fillColor("#111827").text(p.status === "paid" ? "INVOICE" : "PAYMENT", 56, 56, { width: W, align: "right" });
  doc.font(F.r).fontSize(10).fillColor("#111827").text(pdfText(`${p.invoiceNumber ?? p.id.slice(0, 8)}\nDate: ${date(p.paidAt ?? p.createdAt)}\nStatus: ${p.status.toUpperCase()}`), 56, doc.y + 4, { width: W, align: "right" });

  doc.moveDown(2);
  const billed = p.billedTo ?? { name: "", email: "" };
  doc.font(F.b).fontSize(10).fillColor("#6b7280").text("BILLED TO", 56, Math.max(doc.y, 150));
  doc.font(F.r).fontSize(11).fillColor("#111827").text(pdfText([billed.name, billed.company, billed.email].filter(Boolean).join("\n")));

  doc.moveDown(1.5);
  const y0 = doc.y;
  doc.rect(56, y0, W, 22).fill("#f3f4f6");
  doc.font(F.b).fontSize(9).fillColor("#374151").text("DESCRIPTION", 64, y0 + 7).text("AMOUNT", 56, y0 + 7, { width: W - 8, align: "right" });
  let y = y0 + 30;
  const row = (label: string, amount: string, bold = false) => {
    doc.font(bold ? F.b : F.r).fontSize(10).fillColor("#111827").text(pdfText(label), 64, y, { width: W - 140 }).text(amount, 56, y, { width: W - 8, align: "right" });
    y += 20;
  };
  row(`${p.planName} plan (${p.billingCycle === "annual" ? "annual" : "monthly"})`, m(p.price));
  if (Number(p.discount) > 0) row(`Discount${p.couponCode ? ` (${p.couponCode})` : ""}`, `-${m(p.discount)}`);
  if (Number(p.credit) > 0) row("Credit for unused time on the previous plan", `-${m(p.credit)}`);
  if (Number(p.tax) > 0) row(`${p.taxLabel ?? "Tax"} (${Number(p.taxRate)}%)`, m(p.tax));
  doc.moveTo(56, y).lineTo(56 + W, y).strokeColor("#e5e7eb").stroke();
  y += 8;
  row("Total", m(p.total), true);
  if (p.subscriptionId) {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, p.subscriptionId)).limit(1);
    if (sub) doc.font(F.r).fontSize(9).fillColor("#6b7280").text(`Service period: ${date(sub.startDate)} to ${date(sub.endDate)}`, 64, y + 6);
  }
  doc.font(F.r).fontSize(8).fillColor("#9ca3af").text(pdfText(`Paid with ${p.provider === "stripe" ? "Stripe" : p.provider === "razorpay" ? "Razorpay" : p.provider}${p.providerPaymentId ? ` · ref ${p.providerPaymentId}` : ""}`), 56, doc.page.height - 90, { width: W, align: "center" });
  doc.end();
  return done;
}

async function sendReceipt(p: Payment, sub: Subscription) {
  const user = await usersRepository.findById(p.userId);
  if (!user) return;
  const pdf = await invoicePdf(p);
  const body = `<p style="margin:0 0 12px">Hi ${escapeHtml(user.firstName || user.username)},</p>
<p style="margin:0 0 12px">Thanks for your payment of <b>${escapeHtml(formatMoney(Number(p.total), p.currency))}</b> for the <b>${escapeHtml(p.planName)}</b> plan.</p>
<p style="margin:0 0 12px">Your plan is active until <b>${sub.endDate.toISOString().slice(0, 10)}</b>. The invoice ${escapeHtml(p.invoiceNumber ?? "")} is attached.</p>`;
  await sendSystemEmail(user.email, `Payment received: ${p.planName} plan`, body, { forUserId: user.id, attachments: [{ filename: `${p.invoiceNumber ?? "invoice"}.pdf`, contentType: "application/pdf", content: pdf }] });
}

// ---------------------------------------------------------------------------
// Trials, reminders and expiry (cron)
// ---------------------------------------------------------------------------

/** Plan for a brand-new tenant: the configured trial, otherwise the Free plan. */
export async function startTenantPlan(userId: string, now = new Date()): Promise<Subscription | null> {
  const s = await paymentSettings();
  const trial = s.trialPlanId && s.trialDays > 0 ? await billingRepository.findPlan(s.trialPlanId) : undefined;
  if (trial) {
    const end = new Date(now.getTime() + s.trialDays * 86_400_000);
    const q: BillingQuote = { planId: trial.id, planName: trial.name, cycle: "monthly", currency: "USD", price: 0, discount: 0, couponCode: null, credit: 0, tax: 0, taxRate: 0, taxLabel: "", total: 0, kind: "new", startsAt: now.toISOString(), endsAt: end.toISOString() };
    return applyPeriod(userId, trial, q, null, "trial");
  }
  const free = await billingRepository.findPlanByName("Free");
  if (!free) {
    log.warn("No 'Free' plan found; new tenant has no subscription until one is assigned");
    return null;
  }
  return billingRepository.assign(userId, free, "annual");
}

async function remind(sub: Subscription, stage: "7d" | "1d" | "expired") {
  const user = await usersRepository.findById(sub.userId);
  if (!user) return;
  const plans = `${publicBaseUrl()}/plans`;
  const trial = sub.gatewayProvider === "trial";
  const what = trial ? `free trial of the ${sub.planData.name} plan` : `${sub.planData.name} plan`;
  const subject =
    stage === "expired" ? `Your ${what} has ended` : `Your ${what} ends ${stage === "1d" ? "tomorrow" : "in 7 days"}`;
  const body =
    stage === "expired"
      ? `<p style="margin:0 0 12px">Your ${escapeHtml(what)} ended on ${sub.endDate.toISOString().slice(0, 10)}. Your account is now on the Free plan, with its limits.</p><p style="margin:0 0 12px"><a href="${plans}">Choose a plan</a> to get everything back.</p>`
      : `<p style="margin:0 0 12px">Your ${escapeHtml(what)} ends on <b>${sub.endDate.toISOString().slice(0, 10)}</b>.</p><p style="margin:0 0 12px"><a href="${plans}">${trial ? "Choose a plan" : "Renew now"}</a> to keep your limits and features without interruption.</p>`;
  await sendSystemEmail(user.email, subject, body, { forUserId: user.id }).catch((err) => log.warn({ err: (err as Error).message }, "Reminder email failed"));
}

/** Daily: reminders 7 and 1 day before a paid plan or trial ends; expiry falls back to the Free plan. */
export async function runBillingCycle(now = new Date()): Promise<string> {
  let reminded = 0;
  let expired = 0;
  const soon = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.status, "active"), gt(subscriptions.endDate, now), lte(subscriptions.endDate, new Date(now.getTime() + 7 * 86_400_000))));
  for (const sub of soon) {
    if (Number(sub.amount ?? 0) <= 0 && sub.gatewayProvider !== "trial") continue; // free plans don't expire meaningfully
    const later = await db.select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.userId, sub.userId), eq(subscriptions.status, "active"), gt(subscriptions.endDate, sub.endDate))).limit(1);
    if (later.length) continue; // already renewed
    const stage = sub.endDate.getTime() - now.getTime() <= 86_400_000 ? "1d" : "7d";
    if (sub.reminderStage === stage || sub.reminderStage === "1d") continue;
    await db.update(subscriptions).set({ reminderStage: stage }).where(eq(subscriptions.id, sub.id));
    await remind(sub, stage);
    reminded++;
  }
  const ended = await db.select().from(subscriptions).where(and(eq(subscriptions.status, "active"), lte(subscriptions.endDate, now)));
  for (const sub of ended) {
    const [res] = await db.update(subscriptions).set({ status: "expired", reminderStage: "expired" }).where(and(eq(subscriptions.id, sub.id), eq(subscriptions.status, "active")));
    if (!res.affectedRows) continue;
    expired++;
    if (await billingRepository.activeSubscription(sub.userId, now)) continue;
    // Nothing else active: back to the Free plan (and tell them, if it was a paid plan or a trial).
    const free = await billingRepository.findPlanByName("Free");
    if (free) await billingRepository.assign(sub.userId, free, "annual");
    if (Number(sub.amount ?? 0) > 0 || sub.gatewayProvider === "trial") await remind(sub, "expired");
  }
  const stale = await paymentsRepository.expireStale(now);
  return `${reminded} reminder(s), ${expired} expired, ${stale} abandoned checkout(s)`;
}
