import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db";
import { unprocessable } from "../lib/errors";
import type { Quote } from "../services/coupon.service";
import { couponsRepository } from "./coupons.repository";
import { plans, subscriptions, type Plan, type PlanLimits, type Subscription } from "@shared/schema";

type NewPlan = typeof plans.$inferInsert;

export const billingRepository = {
  async listPlans(): Promise<Plan[]> {
    return db.select().from(plans).orderBy(asc(plans.monthlyPrice));
  },

  async findPlan(id: string): Promise<Plan | undefined> {
    const [row] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
    return row;
  },

  async findPlanByName(name: string): Promise<Plan | undefined> {
    const [row] = await db.select().from(plans).where(eq(plans.name, name)).limit(1);
    return row;
  },

  async createPlan(values: Omit<NewPlan, "id">): Promise<Plan> {
    const id = randomUUID();
    await db.insert(plans).values({ ...values, id });
    return (await this.findPlan(id))!;
  },

  async updatePlan(id: string, patch: Partial<NewPlan>): Promise<Plan | undefined> {
    await db.update(plans).set(patch).where(eq(plans.id, id));
    return this.findPlan(id);
  },

  async deletePlan(id: string): Promise<void> {
    await db.delete(plans).where(eq(plans.id, id));
  },

  async activeSubscription(userId: string, now = new Date()): Promise<Subscription | undefined> {
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active"), gte(subscriptions.endDate, now)))
      .orderBy(desc(subscriptions.endDate))
      .limit(1);
    return row;
  },

  /** Active subscription per user (latest end date wins). */
  async activeForUsers(userIds: string[]): Promise<Map<string, Subscription>> {
    const map = new Map<string, Subscription>();
    if (!userIds.length) return map;
    const rows = await db
      .select()
      .from(subscriptions)
      .where(and(inArray(subscriptions.userId, userIds), eq(subscriptions.status, "active"), gte(subscriptions.endDate, new Date())))
      .orderBy(asc(subscriptions.endDate));
    for (const r of rows) map.set(r.userId, r);
    return map;
  },

  async listSubscriptions(userId: string): Promise<Subscription[]> {
    return db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).orderBy(desc(subscriptions.createdAt));
  },

  /**
   * Replaces any active subscription with a new one for the plan. With a quote that carries a
   * coupon, the coupon use is counted in the same transaction (COUPON_INVALID rolls back).
   */
  async assign(userId: string, plan: Plan, billingCycle: "monthly" | "annual", pricing?: Quote): Promise<Subscription> {
    const start = new Date();
    const end = new Date(start);
    if (billingCycle === "annual") end.setFullYear(end.getFullYear() + 1);
    else end.setMonth(end.getMonth() + 1);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx
        .update(subscriptions)
        .set({ status: "replaced" })
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active")));
      await tx.insert(subscriptions).values({
        id,
        userId,
        planId: plan.id,
        planData: { name: plan.name, permissions: (plan.permissions ?? {}) as PlanLimits },
        status: "active",
        billingCycle,
        startDate: start,
        endDate: end,
        amount: pricing ? pricing.total.toFixed(2) : null,
        discount: (pricing?.discount ?? 0).toFixed(2),
        couponCode: pricing?.coupon?.code ?? null,
      });
      if (pricing?.coupon && !(await couponsRepository.redeem(tx, pricing.coupon.id, userId, id, pricing.discount.toFixed(2)))) {
        throw unprocessable("This coupon is no longer available", "COUPON_INVALID");
      }
    });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    return row;
  },
};
