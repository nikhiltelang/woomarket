import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import * as c from "../controllers/public-api.controller";
import { apiKeyAuth } from "../middlewares/api-key-auth";
import { maintenanceGuard } from "../middlewares/platform";
import { requireRole } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";
import { config } from "../config";

/** /api/v1 — authenticated with access keys, never with cookies (so no CSRF token). */
export const publicApiRoutes = Router();

const perKeyLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.isTest ? 1000 : 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.apiKey!.id,
  handler: (_req, res) => res.status(429).json({ success: false, message: "Too many requests for this access key. Slow down and retry.", code: "RATE_LIMITED" }),
});

publicApiRoutes.use(maintenanceGuard);
publicApiRoutes.post("/send", h(apiKeyAuth), perKeyLimiter, h(c.send));
publicApiRoutes.use((_req: Request, res: Response, _next: NextFunction) => {
  res.status(404).json({ success: false, message: "Unknown API endpoint. Use POST /api/v1/send.", code: "NOT_FOUND" });
});

/** Key management for tenant admins (session-authenticated, inside /api). */
export const apiKeyRoutes = Router();
const admin = requireRole("admin");
apiKeyRoutes.get("/api-keys", admin, h(c.listKeys));
apiKeyRoutes.post("/api-keys", admin, h(c.createKey));
apiKeyRoutes.post("/api-keys/:id/revoke", admin, h(c.revokeKey));
apiKeyRoutes.delete("/api-keys/:id", admin, h(c.deleteKey));
