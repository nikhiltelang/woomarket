import { couponDiscount } from "@shared/platform";
import type { Coupon, Plan } from "@shared/schema";
import { unprocessable } from "../lib/errors";
import { couponsRepository } from "../repositories/coupons.repository";

export interface Quote {
  price: number;
  discount: number;
  total: number;
  coupon: Coupon | null;
}

/** Why a coupon can't be used right now, or null when it can. */
export function couponProblem(c: Coupon, now = new Date()): string | null {
  if (!c.status) return "This coupon is inactive";
  if (c.expiryType === "date" && (!c.expiresAt || c.expiresAt <= now)) return "This coupon has expired";
  if (c.usageLimit !== -1 && c.usedCount >= c.usageLimit) return "This coupon has reached its usage limit";
  return null;
}

export const planPrice = (plan: Plan, cycle: "monthly" | "annual") => Number(cycle === "annual" ? plan.annualPrice : plan.monthlyPrice) || 0;

/** Prices a plan for a cycle, applying a coupon code when given (throws COUPON_INVALID). */
export async function quote(plan: Plan, cycle: "monthly" | "annual", code?: string | null): Promise<Quote> {
  const price = planPrice(plan, cycle);
  if (!code) return { price, discount: 0, total: price, coupon: null };
  const coupon = await couponsRepository.findByCode(code);
  if (!coupon) throw unprocessable("Coupon code not found", "COUPON_INVALID");
  const problem = couponProblem(coupon);
  if (problem) throw unprocessable(problem, "COUPON_INVALID");
  const discount = couponDiscount(coupon, price);
  return { price, discount, total: Math.round((price - discount) * 100) / 100, coupon };
}
