import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import * as c from "../controllers/public-api.controller";
import * as wh from "../controllers/outgoing-webhooks.controller";
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
// Zapier / Make: connection test and REST-hook subscriptions.
publicApiRoutes.get("/me", h(apiKeyAuth), perKeyLimiter, wh.me);
publicApiRoutes.get("/webhooks/events", h(apiKeyAuth), perKeyLimiter, wh.events);
publicApiRoutes.get("/webhooks/samples/:event", h(apiKeyAuth), perKeyLimiter, wh.sample);
publicApiRoutes.get("/webhooks", h(apiKeyAuth), perKeyLimiter, h(wh.listSubscriptions));
publicApiRoutes.post("/webhooks", h(apiKeyAuth), perKeyLimiter, h(wh.subscribe));
publicApiRoutes.delete("/webhooks/:id", h(apiKeyAuth), perKeyLimiter, h(wh.unsubscribe));
publicApiRoutes.use((_req: Request, res: Response, _next: NextFunction) => {
  res.status(404).json({ success: false, message: "Unknown API endpoint. See /developers/api-keys for the available endpoints.", code: "NOT_FOUND" });
});

/** Key management for tenant admins (session-authenticated, inside /api). */
export const apiKeyRoutes = Router();
const admin = requireRole("admin");
apiKeyRoutes.get("/api-keys", admin, h(c.listKeys));
apiKeyRoutes.post("/api-keys", admin, h(c.createKey));
apiKeyRoutes.post("/api-keys/:id/revoke", admin, h(c.revokeKey));
apiKeyRoutes.delete("/api-keys/:id", admin, h(c.deleteKey));

/** Outgoing webhooks (session-authenticated, tenant admins). */
apiKeyRoutes.get("/webhooks", admin, h(wh.list));
apiKeyRoutes.post("/webhooks", admin, h(wh.create));
apiKeyRoutes.put("/webhooks/:id", admin, h(wh.update));
apiKeyRoutes.delete("/webhooks/:id", admin, h(wh.remove));
apiKeyRoutes.get("/webhooks/:id/secret", admin, h(wh.revealSecret));
apiKeyRoutes.post("/webhooks/:id/rotate-secret", admin, h(wh.rotateSecret));
apiKeyRoutes.post("/webhooks/:id/test", admin, h(wh.test));
apiKeyRoutes.get("/webhooks/:id/deliveries", admin, h(wh.deliveries));
apiKeyRoutes.post("/webhooks/deliveries/:deliveryId(\\d+)/retry", admin, h(wh.retry));
