import { Router } from "express";
import * as c from "../controllers/plans.controller";
import { requireAuth, requireRole } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

export const planRoutes = Router();
const sa = requireRole("superadmin");
planRoutes.get("/admin/plans", h(c.listPlans));
planRoutes.get("/admin/plans/:id", requireAuth, h(c.getPlan));
planRoutes.post("/admin/plans", sa, h(c.createPlan));
planRoutes.put("/admin/plans/:id", sa, h(c.updatePlan));
planRoutes.delete("/admin/plans/:id", sa, h(c.deletePlan));
planRoutes.post("/assignSubscription", sa, h(c.assignSubscription));
planRoutes.get("/subscriptions/active/:userId", requireAuth, h(c.activeSubscription));
