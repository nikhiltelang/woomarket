import { Router, type Request, type Response } from "express";
import { requireAuth, requireRole } from "../middlewares/auth";
import { issueCsrfToken } from "../middlewares/csrf";
import { asyncHandler as h } from "../lib/http";
import { pool } from "../db";
import { appUpdateRouter } from "../app-update/controller";
import { getRoot, readVersion } from "../app-update/controller";
import { globalWebhookUrl } from "../controllers/webhooks.controller";
import { authRoutes } from "./auth.routes";
import { userRoutes } from "./users.routes";
import { teamRoutes } from "./team.routes";
import { channelRoutes } from "./channels.routes";
import { contactRoutes } from "./contacts.routes";
import { groupRoutes } from "./groups.routes";
import { templateRoutes } from "./templates.routes";
import { conversationRoutes } from "./conversations.routes";
import { campaignRoutes } from "./campaigns.routes";
import { dashboardRoutes } from "./dashboard.routes";
import { planRoutes } from "./plans.routes";

/** All /api routes. Authentication, rate limiting and CSRF run before this router. */
export function apiRouter(): Router {
  const api = Router();

  // --- Public -------------------------------------------------------------
  api.get("/health", h(async (_req: Request, res: Response) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", database: "ok", uptime: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ status: "degraded", database: "unreachable" });
    }
  }));
  api.get("/version", (_req, res) => res.json({ version: readVersion(getRoot()) }));
  api.get("/csrf-token", (req, res) => res.json({ csrfToken: issueCsrfToken(req, res) }));
  api.use("/auth", authRoutes);
  api.use(planRoutes); // GET /admin/plans is public; the rest guard themselves

  // --- Authenticated ------------------------------------------------------
  api.use(requireAuth);
  api.get("/webhook/global-url", globalWebhookUrl);
  api.use(userRoutes);
  api.use("/team", teamRoutes);
  api.use(channelRoutes);
  api.use(contactRoutes);
  api.use("/groups", groupRoutes);
  api.use("/templates", templateRoutes);
  api.use("/conversations", conversationRoutes);
  api.use("/campaigns", campaignRoutes);
  api.use(dashboardRoutes);
  api.use("/app-update", requireRole("superadmin"), appUpdateRouter());

  return api;
}
