import type { Request, Response } from "express";
import { assignSubscriptionSchema, planSchema } from "@shared/validation";
import { parseBody } from "../lib/http";
import { conflict, forbidden, notFound } from "../lib/errors";
import { billingRepository } from "../repositories/billing.repository";
import { usersRepository } from "../repositories/users.repository";
import { activityRepository } from "../repositories/activity.repository";
import { isDuplicateKeyError } from "../lib/errors";
import { quote } from "../services/coupon.service";

export async function listPlans(_req: Request, res: Response) {
  res.json({ data: await billingRepository.listPlans() });
}

export async function getPlan(req: Request, res: Response) {
  const plan = await billingRepository.findPlan(req.params.id);
  if (!plan) throw notFound("Plan");
  res.json({ data: plan });
}

const toRow = (p: ReturnType<typeof planSchema.parse>) => ({
  ...p,
  monthlyPrice: p.monthlyPrice.toFixed(2),
  annualPrice: p.annualPrice.toFixed(2),
});

export async function createPlan(req: Request, res: Response) {
  const plan = await billingRepository.createPlan(toRow(parseBody(planSchema, req)));
  await activityRepository.record(req, req.user!.id, "plan_created", { type: "plan", id: plan.id });
  res.status(201).json({ data: plan });
}

export async function updatePlan(req: Request, res: Response) {
  if (!(await billingRepository.findPlan(req.params.id))) throw notFound("Plan");
  const plan = await billingRepository.updatePlan(req.params.id, toRow(parseBody(planSchema, req)));
  res.json({ data: plan });
}

export async function deletePlan(req: Request, res: Response) {
  try {
    await billingRepository.deletePlan(req.params.id);
  } catch (err) {
    // FK from subscriptions (ER_ROW_IS_REFERENCED) or duplicate
    if (isDuplicateKeyError(err) || String((err as { code?: string }).code ?? (err as any)?.cause?.code).includes("ROW_IS_REFERENCED")) {
      throw conflict("This plan has subscriptions and cannot be deleted", "PLAN_IN_USE");
    }
    throw err;
  }
  res.json({ success: true });
}

export async function assignSubscription(req: Request, res: Response) {
  const input = parseBody(assignSubscriptionSchema, req);
  const [user, plan] = await Promise.all([usersRepository.findById(input.userId), billingRepository.findPlan(input.planId)]);
  if (!user || user.role !== "admin") throw notFound("Tenant admin");
  if (!plan) throw notFound("Plan");
  const pricing = await quote(plan, input.billingCycle, input.couponCode);
  const sub = await billingRepository.assign(user.id, plan, input.billingCycle, pricing);
  await activityRepository.record(req, req.user!.id, "subscription_assigned", { type: "user", id: user.id }, { plan: plan.name, coupon: pricing.coupon?.code ?? null });
  res.status(201).json({ data: sub });
}

export async function activeSubscription(req: Request, res: Response) {
  const userId = req.params.userId;
  if (req.user!.role !== "superadmin" && userId !== req.user!.tenantId) throw forbidden();
  res.json({ data: (await billingRepository.activeSubscription(userId)) ?? null });
}
