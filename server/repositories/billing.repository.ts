import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "../db";
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

  async listSubscriptions(userId: string): Promise<Subscription[]> {
    return db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).orderBy(desc(subscriptions.createdAt));
  },

  /** Replaces any active subscription with a new one for the plan. */
  async assign(userId: string, plan: Plan, billingCycle: "monthly" | "annual"): Promise<Subscription> {
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
      });
    });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    return row;
  },
};
