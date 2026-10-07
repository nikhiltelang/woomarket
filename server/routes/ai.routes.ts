import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as c from "../controllers/ai.controller";
import { requirePermission } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";
import { config } from "../config";

/** AI assistant (tenant users). */
export const aiRoutes = Router();

// Each request costs money: a per-user burst limit on top of the monthly quota.
const perUser = rateLimit({
  windowMs: 60_000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  handler: (_req, res) => res.status(429).json({ success: false, message: "Too many AI requests. Wait a minute and try again.", code: "RATE_LIMITED" }),
});

aiRoutes.get("/status", h(c.status));
aiRoutes.post("/draft", perUser, requirePermission("campaigns:create", "email:send", "sms:send", "templates:create", "templates:edit"), h(c.draft));
aiRoutes.post("/conversations/:id/replies", perUser, requirePermission("inbox:send"), h(c.replies));
aiRoutes.post("/conversations/:id/insights", perUser, requirePermission("inbox:view"), h(c.insights));
