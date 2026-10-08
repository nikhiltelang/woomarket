import type { Request, Response } from "express";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { checkoutSchema } from "@shared/billing";
import { users, type Payment } from "@shared/schema";
import { db } from "../db";
import { parseBody, parseQuery } from "../lib/http";
import { notFound, unprocessable } from "../lib/errors";
import { requireTenantId } from "../middlewares/tenant";
import { activityRepository } from "../repositories/activity.repository";
import { billingRepository } from "../repositories/billing.repository";
import { usersRepository } from "../repositories/users.repository";
import {
  confirmPayment,
  handleRazorpayWebhook,
  handleStripeWebhook,
  invoicePdf,
  paymentsRepository,
  publicBillingConfig,
  quoteFor,
  simulatePayment,
  startCheckout,
  verifyRazorpayCheckout,
} from "../services/billing.service";

const publicPayment = (p: Payment) => ({
  id: p.id,
  planName: p.planName,
  billingCycle: p.billingCycle,
  currency: p.currency,
  price: Number(p.price),
  discount: Number(p.discount),
  credit: Number(p.credit),
  tax: Number(p.tax),
  total: Number(p.total),
  couponCode: p.couponCode,
  provider: p.provider,
  status: p.status,
  failureReason: p.failureReason,
  invoiceNumber: p.invoiceNumber,
  paidAt: p.paidAt,
  createdAt: p.createdAt,
});

async function ownPayment(req: Request): Promise<Payment> {
  const p = await paymentsRepository.find(req.params.id);
  if (!p || p.userId !== requireTenantId(req.user)) throw notFound("Payment");
  return p;
}

/** GET /api/billing — how to pay, the current plan and past payments. */
export async function overview(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const [config, subscription, history] = await Promise.all([publicBillingConfig(), billingRepository.activeSubscription(tenantId), paymentsRepository.forTenant(tenantId)]);
  res.json({ data: { config, subscription: subscription ?? null, payments: history.map(publicPayment) } });
}

const quoteSchema = checkoutSchema.pick({ planId: true, cycle: true, couponCode: true });

export async function quote(req: Request, res: Response) {
  const { quote } = await quoteFor(requireTenantId(req.user), parseBody(quoteSchema, req));
  res.json({ data: quote });
}

/** POST /api/billing/checkout — starts paying (or switches right away when nothing is due). */
export async function checkout(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const user = await usersRepository.findById(tenantId);
  if (!user) throw notFound("Account");
  const input = parseBody(checkoutSchema, req);
  const r = await startCheckout(user, input);
  await activityRepository.record(req, req.user!.id, "checkout_started", { type: "plan", id: input.planId }, { cycle: input.cycle, kind: r.kind, provider: r.payment?.provider ?? null });
  if (r.kind === "done") return res.json({ data: { kind: "done", subscription: r.subscription } });
  if (r.kind === "redirect") return res.json({ data: { kind: "redirect", url: r.url, paymentId: r.payment.id } });
  if (r.kind === "razorpay") return res.json({ data: { kind: "razorpay", paymentId: r.payment.id, order: r.order } });
  res.json({ data: { kind: "simulate", payment: publicPayment(r.payment) } });
}

/** GET /api/billing/payments/:id — status (asks the gateway if still pending). */
export async function getPayment(req: Request, res: Response) {
  const p = await confirmPayment(await ownPayment(req));
  res.json({ data: publicPayment(p) });
}

export async function razorpayCallback(req: Request, res: Response) {
  const input = parseBody(z.object({ orderId: z.string().min(1).max(100), paymentId: z.string().min(1).max(100), signature: z.string().min(1).max(200) }), req);
  const p = await verifyRazorpayCheckout(await ownPayment(req), input);
  res.json({ data: publicPayment(p) });
}

export async function simulate(req: Request, res: Response) {
  const { outcome } = parseBody(z.object({ outcome: z.enum(["paid", "failed"]) }), req);
  res.json({ data: publicPayment(await simulatePayment(await ownPayment(req), outcome)) });
}

async function sendInvoice(res: Response, p: Payment) {
  if (p.status !== "paid" && p.status !== "refunded") throw unprocessable("Invoices are available once the payment is complete.", "NOT_PAID");
  const pdf = await invoicePdf(p);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${p.invoiceNumber ?? "invoice"}.pdf"`);
  res.send(pdf);
}

export async function invoice(req: Request, res: Response) {
  await sendInvoice(res, await ownPayment(req));
}

// --- Superadmin -------------------------------------------------------------------

export async function adminList(req: Request, res: Response) {
  const q = parseQuery(z.object({ status: z.enum(["pending", "paid", "failed", "expired", "refunded"]).optional() }), req);
  const rows = await paymentsRepository.list({ status: q.status });
  const ids = [...new Set(rows.map((r) => r.userId))];
  const owners = ids.length ? await db.select({ id: users.id, username: users.username, email: users.email }).from(users).where(inArray(users.id, ids)) : [];
  const byId = new Map(owners.map((o) => [o.id, o]));
  const since = new Date(Date.now() - 30 * 86_400_000);
  res.json({ data: rows.map((r) => ({ ...publicPayment(r), tenant: byId.get(r.userId) ?? null })), revenue30d: await paymentsRepository.revenue(since) });
}

export async function adminInvoice(req: Request, res: Response) {
  const p = await paymentsRepository.find(req.params.id);
  if (!p) throw notFound("Payment");
  await sendInvoice(res, p);
}

// --- Gateway webhooks (outside /api, signature-checked) ---------------------------------

export async function stripeWebhook(req: Request, res: Response) {
  const r = await handleStripeWebhook(req.rawBody, req.get("stripe-signature"));
  res.status(r.status).json({ received: r.status === 200, result: r.result });
}

export async function razorpayWebhook(req: Request, res: Response) {
  const r = await handleRazorpayWebhook(req.rawBody, req.get("x-razorpay-signature"));
  res.status(r.status).json({ received: r.status === 200, result: r.result });
}
