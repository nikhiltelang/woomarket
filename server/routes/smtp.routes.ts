import { Router } from "express";
import * as c from "../controllers/smtp.controller";
import { requirePermission, requireRole } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

/** Tenant SMTP settings (/api/smtp/*) and the platform default (/api/admin/*, superadmin). */
export const smtpRoutes = Router();
const superadmin = requireRole("superadmin");
smtpRoutes.get("/smtp/config", requireRole("admin", "team", "superadmin"), h(c.getConfig));
smtpRoutes.post("/smtp/config", requireRole("admin", "superadmin"), requirePermission("settings:edit"), h(c.saveConfig));
smtpRoutes.delete("/smtp/config", requireRole("admin", "superadmin"), requirePermission("settings:edit"), h(c.deleteConfig));
smtpRoutes.post("/smtp/test", requireRole("admin", "superadmin"), requirePermission("settings:edit"), h(c.testConfig));
smtpRoutes.get("/admin/getSmtpConfig", superadmin, h(c.getConfig));
smtpRoutes.post("/admin/smtpConfig", superadmin, h(c.saveConfig));
