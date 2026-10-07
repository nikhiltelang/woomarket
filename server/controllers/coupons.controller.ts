import type { Request, Response } from "express";
import { couponPreviewSchema, couponSchema } from "@shared/platform";
import { paginationQuery } from "@shared/validation";
import { paginated, parseBody, parseQuery } from "../lib/http";
import { conflict, isDuplicateKeyError, notFound } from "../lib/errors";
import { activityRepository } from "../repositories/activity.repository";
import { billingRepository } from "../repositories/billing.repository";
import { couponsRepository } from "../repositories/coupons.repository";
import { quote } from "../services/coupon.service";

const toRow = (c: ReturnType<typeof couponSchema.parse>) => ({
  ...c,
  discountValue: c.discountValue.toFixed(2),
  expiresAt: c.expiryType === "date" ? (c.expiresAt ?? null) : null,
});

const dupCode = (err: unknown) => {
  if (isDuplicateKeyError(err)) throw conflict("A coupon with this code already exists", "COUPON_CODE_TAKEN");
  throw err;
};

export async function list(req: Request, res: Response) {
  const q = parseQuery(paginationQuery, req);
  const { rows, total } = await couponsRepository.list(q);
  res.json(paginated(rows, total, q.page, q.limit));
}

export async function create(req: Request, res: Response) {
  const coupon = await couponsRepository.create(toRow(parseBody(couponSchema, req))).catch(dupCode);
  await activityRepository.record(req, req.user!.id, "coupon_created", { type: "coupon", id: String(coupon.id) });
  res.status(201).json({ data: coupon });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!(await couponsRepository.find(id))) throw notFound("Coupon");
  const coupon = await couponsRepository.update(id, toRow(parseBody(couponSchema, req))).catch(dupCode);
  await activityRepository.record(req, req.user!.id, "coupon_updated", { type: "coupon", id: String(id) });
  res.json({ data: coupon });
}

export async function toggleStatus(req: Request, res: Response) {
  const coupon = await couponsRepository.find(Number(req.params.id));
  if (!coupon) throw notFound("Coupon");
  res.json({ data: await couponsRepository.update(coupon.id, { status: !coupon.status }) });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!(await couponsRepository.find(id))) throw notFound("Coupon");
  await couponsRepository.delete(id);
  await activityRepository.record(req, req.user!.id, "coupon_deleted", { type: "coupon", id: String(id) });
  res.json({ success: true });
}

/** POST /api/superadmin/coupons/preview — price breakdown for a plan with a code. */
export async function preview(req: Request, res: Response) {
  const input = parseBody(couponPreviewSchema, req);
  const plan = await billingRepository.findPlan(input.planId);
  if (!plan) throw notFound("Plan");
  const q = await quote(plan, input.billingCycle, input.code);
  res.json({ data: { price: q.price, discount: q.discount, total: q.total, code: q.coupon?.code ?? null } });
}
