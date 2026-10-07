import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { systemConfig } from "../services/system-config.service";
import { timingSafeEqualStr } from "../lib/crypto";

/** API paths that keep working during maintenance so the superadmin can sign in and switch it off. */
const MAINTENANCE_ALLOW = [
  "/api/health",
  "/api/version",
  "/api/csrf-token",
  "/api/system-config/public",
  "/api/auth/",
  "/api/maintenance/",
  "/api/policy-pages",
  "/api/languages/",
];

/**
 * Maintenance mode: non-superadmin API traffic gets 503 with the configured message.
 * Webhooks (outside /api) keep flowing so no inbound WhatsApp data is lost.
 */
export async function maintenanceGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const pub = await systemConfig.public();
    if (!pub.maintenance.enabled) return next();
    if (req.user?.role === "superadmin" || req.session?.maintenanceBypass) return next();
    const path = req.originalUrl.split("?")[0];
    if (MAINTENANCE_ALLOW.some((p) => path === p || path.startsWith(p))) return next();
    res.setHeader("Retry-After", "600");
    res.status(503).json({ success: false, code: "MAINTENANCE", message: pub.maintenance.content, title: pub.maintenance.title });
  } catch {
    next(); // never take the API down because the config couldn't be read
  }
}

/** `?secret=` link that lets testers use the app during maintenance (session-scoped). */
export async function maintenanceBypass(req: Request, res: Response) {
  const s = await systemConfig.get();
  const secret = String(req.query.secret ?? "");
  const expected = s.maintenanceMode?.bypassSecret ?? "";
  if (expected && secret && timingSafeEqualStr(secret, expected)) {
    req.session.maintenanceBypass = true;
    return res.redirect("/");
  }
  res.status(403).json({ success: false, message: "Invalid bypass link" });
}

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** "Force SSL": redirects plain-HTTP page loads to HTTPS (needs `trust proxy` behind a proxy). */
export async function forceSsl(req: Request, res: Response, next: NextFunction) {
  if (req.secure || !config.isProduction || LOCAL_HOSTS.test(req.get("host") ?? "")) return next();
  try {
    const s = await systemConfig.get();
    if (!s.forceSsl) return next();
  } catch {
    return next();
  }
  if (req.method === "GET" || req.method === "HEAD") return res.redirect(301, `https://${req.get("host")}${req.originalUrl}`);
  res.status(403).json({ success: false, code: "HTTPS_REQUIRED", message: "HTTPS is required" });
}
