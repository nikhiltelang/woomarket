/**
 * Self-serve billing: tenants buy or renew a plan for a prepaid period (monthly / annual) through
 * Stripe Checkout or Razorpay Checkout. Each paid period gets an invoice.
 */
import { z } from "zod";

export const PROVIDERS = ["stripe", "razorpay", "simulator"] as const;
export type PaymentProvider = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<PaymentProvider, string> = { stripe: "Card (Stripe)", razorpay: "Razorpay (UPI, cards, netbanking)", simulator: "Test payment" };

export const CYCLES = ["monthly", "annual"] as const;
export type BillingCycle = (typeof CYCLES)[number];

export const PAYMENT_STATUSES = ["pending", "paid", "failed", "expired", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Superadmin settings (Settings → Payments). Secrets are write-only. */
export const paymentSettingsSchema = z.object({
  stripe: z.object({
    enabled: z.boolean().default(false),
    publishableKey: z.string().trim().max(200).default(""),
    secretKey: z.string().trim().max(300).optional(),
    webhookSecret: z.string().trim().max(300).optional(),
  }),
  razorpay: z.object({
    enabled: z.boolean().default(false),
    keyId: z.string().trim().max(100).default(""),
    keySecret: z.string().trim().max(300).optional(),
    webhookSecret: z.string().trim().max(300).optional(),
  }),
  /** Added on top of the price (0 = no tax line). */
  taxRate: z.coerce.number().min(0).max(50).default(0),
  taxLabel: z.string().trim().max(30).default("Tax"),
  /** Shown on invoices: legal name, address, tax number. */
  invoiceDetails: z.string().trim().max(1000).default(""),
  /** New sign-ups start with a free trial of this plan (none = the Free plan). */
  trialPlanId: z.string().uuid().nullish(),
  trialDays: z.coerce.number().int().min(0).max(90).default(0),
});
export type PaymentSettingsInput = z.infer<typeof paymentSettingsSchema>;

export const checkoutSchema = z.object({
  planId: z.string().uuid(),
  cycle: z.enum(CYCLES),
  couponCode: z.string().trim().max(40).optional(),
  provider: z.enum(PROVIDERS).optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Price breakdown shown before paying (and stored on the payment). */
export interface BillingQuote {
  planId: string;
  planName: string;
  cycle: BillingCycle;
  currency: string;
  price: number;
  discount: number;
  couponCode: string | null;
  /** Unused time of the current paid plan when switching plans. */
  credit: number;
  tax: number;
  taxRate: number;
  taxLabel: string;
  total: number;
  /** "renew" extends the current plan; "switch" replaces it now; "new" starts one. */
  kind: "new" | "renew" | "switch";
  startsAt: string;
  endsAt: string;
}

/** What the tenant's browser needs to choose how to pay. */
export interface PublicBillingConfig {
  currency: string;
  currencySymbol: string;
  providers: PaymentProvider[];
  razorpayKeyId: string | null;
  taxRate: number;
  taxLabel: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Credit for the unused part of a paid period (switching plans mid-way). */
export function unusedCredit(paid: number, start: Date, end: Date, now: Date): number {
  const total = end.getTime() - start.getTime();
  if (paid <= 0 || total <= 0 || now >= end) return 0;
  const left = Math.min(1, (end.getTime() - Math.max(now.getTime(), start.getTime())) / total);
  return round2(paid * left);
}

/** Totals from a price: coupon first, then credit, then tax on what's left. */
export function totals(price: number, discount: number, credit: number, taxRate: number): { discount: number; credit: number; tax: number; total: number } {
  const d = round2(Math.min(discount, price));
  const c = round2(Math.min(credit, price - d));
  const base = round2(price - d - c);
  const tax = round2((base * taxRate) / 100);
  return { discount: d, credit: c, tax, total: round2(base + tax) };
}

/** Same day next month / next year (31 Jan + 1 month = 28/29 Feb). */
export function addCycle(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  if (cycle === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  // Overflow (e.g. 31 → 3rd of the following month): go back to the last day of the month.
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d;
}

/** Currencies without minor units (Stripe and Razorpay amounts are in the smallest unit). */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
export const toMinorUnits = (amount: number, currency: string) => Math.round(amount * (ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100));

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Reminder stages before (and at) expiry. */
export const REMINDER_DAYS = [7, 1] as const;
