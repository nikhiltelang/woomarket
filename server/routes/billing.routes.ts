import { Router } from "express";
import * as c from "../controllers/billing.controller";
import { requireRole } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

/** Self-serve billing for tenant admins (inside /api/billing). */
export const billingRoutes = Router();
const owner = requireRole("admin");
billingRoutes.get("/", owner, h(c.overview));
billingRoutes.post("/quote", owner, h(c.quote));
billingRoutes.post("/checkout", owner, h(c.checkout));
billingRoutes.get("/payments/:id", owner, h(c.getPayment));
billingRoutes.post("/payments/:id/razorpay", owner, h(c.razorpayCallback));
billingRoutes.post("/payments/:id/simulate", owner, h(c.simulate));
billingRoutes.get("/payments/:id/invoice", owner, h(c.invoice));

/** Superadmin: every payment (inside /api/admin/payments). */
export const adminPaymentRoutes = Router();
adminPaymentRoutes.get("/", requireRole("superadmin"), h(c.adminList));
adminPaymentRoutes.get("/:id/invoice", requireRole("superadmin"), h(c.adminInvoice));
