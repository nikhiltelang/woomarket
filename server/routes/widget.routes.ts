import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as c from "../controllers/widget.controller";
import { requirePermission } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";
import { config } from "../config";

const limiter = (windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs,
    limit: config.isTest ? 10_000 : limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => `${req.ip}:${req.params.id}`,
    handler: (_req, res) => res.status(429).json({ success: false, message, code: "RATE_LIMITED" }),
  });

/** Public visitor API (mounted at /api/widget, outside session auth and CSRF). */
export const widgetPublicRoutes = Router();
const reads = limiter(60_000, 120, "Too many requests. Please wait a moment.");
const starts = limiter(10 * 60_000, 6, "Too many new chats from your network. Please try again later.");
const sends = limiter(60_000, 20, "You're sending messages too quickly. Please wait a moment.");
widgetPublicRoutes.options("/:id/*", h(c.widgetCors));
widgetPublicRoutes.get("/:id/config", reads, h(c.widgetCors), h(c.config));
widgetPublicRoutes.post("/:id/chats", starts, h(c.widgetCors), h(c.startChat));
widgetPublicRoutes.get("/:id/messages", reads, h(c.widgetCors), h(c.listMessages));
widgetPublicRoutes.post("/:id/messages", sends, h(c.widgetCors), h(c.sendMessage));

/** Tenant management (inside /api, session-authenticated). */
export const widgetRoutes = Router();
const manage = requirePermission("settings:edit");
widgetRoutes.get("/", requirePermission("settings:view"), h(c.list));
widgetRoutes.post("/", manage, h(c.create));
widgetRoutes.put("/:id", manage, h(c.update));
widgetRoutes.delete("/:id", manage, h(c.remove));
