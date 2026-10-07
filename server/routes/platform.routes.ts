import { Router } from "express";
import * as sys from "../controllers/system-config.controller";
import * as auth from "../controllers/auth.controller";
import * as google from "../controllers/google-auth.controller";
import { languages, levels, notificationsCtl, policies } from "../controllers/platform.controller";
import * as coupons from "../controllers/coupons.controller";
import * as support from "../controllers/support.controller";
import * as sysinfo from "../controllers/system-info.controller";
import * as requestLogs from "../controllers/request-logs.controller";
import { requireAuth, requireRole } from "../middlewares/auth";
import { authRateLimiter } from "../middlewares/rate-limit";
import { maintenanceBypass } from "../middlewares/platform";
import { imageUpload } from "../lib/uploads";
import { asyncHandler as h } from "../lib/http";

/** Endpoints reachable without signing in. */
export const platformPublicRoutes = Router();
platformPublicRoutes.get("/system-config/public", h(sys.getPublic));
platformPublicRoutes.get("/brand-settings", h(sys.getBranding));
platformPublicRoutes.get("/policy-pages", h(policies.listPublic));
platformPublicRoutes.get("/policy-pages/:slug", (req, res, next) => (req.params.slug === "admin" ? next() : h(policies.bySlug)(req, res, next)));
platformPublicRoutes.get("/languages/enabled", h(languages.enabled));
platformPublicRoutes.get("/languages/translations/:code", h(languages.translations));
platformPublicRoutes.get("/maintenance/bypass", h(maintenanceBypass));
platformPublicRoutes.get("/auth/google", h(google.start));
platformPublicRoutes.get("/auth/google/callback", h(google.callback));
platformPublicRoutes.post("/users/verifyEmail", authRateLimiter, h(auth.verifyEmail));
platformPublicRoutes.post("/users/resend-verification", authRateLimiter, h(auth.resendVerification));

/** Signed-in endpoints (notifications for everyone; the rest superadmin-only). */
export const platformRoutes = Router();
const sa = requireRole("superadmin");
const tenant = requireRole("admin", "team");

platformRoutes.get("/notifications/users", requireAuth, h(notificationsCtl.mine));
platformRoutes.get("/notifications/unread-count", requireAuth, h(notificationsCtl.unread));
platformRoutes.post("/notifications/mark-all", requireAuth, h(notificationsCtl.readAll));
platformRoutes.post("/notifications/:id(\\d+)/read", requireAuth, h(notificationsCtl.read));
platformRoutes.get("/notifications", sa, h(notificationsCtl.listAdmin));
platformRoutes.post("/notifications", sa, h(notificationsCtl.send));
platformRoutes.delete("/notifications/:id(\\d+)", sa, h(notificationsCtl.remove));

platformRoutes.get("/system-config", sa, h(sys.getAll));
platformRoutes.get("/system-config/cron-jobs", sa, h(sys.listCronJobs));
platformRoutes.post("/system-config/cron-jobs/:jobKey/run", sa, h(sys.runCronJob));
platformRoutes.post("/system-config/test-email", sa, h(sys.testEmail));
platformRoutes.put("/system-config/:section", sa, h(sys.updateSection));
platformRoutes.put("/brand-settings", sa, imageUpload.fields([{ name: "logo", maxCount: 1 }, { name: "favicon", maxCount: 1 }]), h(sys.updateBranding));

platformRoutes.get("/policy-pages/admin", sa, h(policies.listAdmin));
platformRoutes.post("/policy-pages", sa, h(policies.create));
platformRoutes.put("/policy-pages/:id", sa, h(policies.update));
platformRoutes.delete("/policy-pages/:id", sa, h(policies.remove));

platformRoutes.get("/languages", sa, h(languages.list));
platformRoutes.post("/languages", sa, h(languages.create));
platformRoutes.put("/languages/:id", sa, h(languages.update));
platformRoutes.put("/languages/:id/translations", sa, h(languages.saveTranslations));
platformRoutes.post("/languages/:id/default", sa, h(languages.setDefault));
platformRoutes.delete("/languages/:id", sa, h(languages.remove));

platformRoutes.get("/superadmin/levels", sa, h(levels.list));
platformRoutes.post("/superadmin/levels", sa, h(levels.create));
platformRoutes.put("/superadmin/levels/:id", sa, h(levels.update));
platformRoutes.delete("/superadmin/levels/:id", sa, h(levels.remove));
platformRoutes.put("/admin/users/:id/level", sa, h(levels.assign));

platformRoutes.get("/superadmin/coupons", sa, h(coupons.list));
platformRoutes.post("/superadmin/coupons", sa, h(coupons.create));
platformRoutes.post("/superadmin/coupons/preview", sa, h(coupons.preview));
platformRoutes.put("/superadmin/coupons/:id(\\d+)", sa, h(coupons.update));
platformRoutes.put("/superadmin/coupons/:id(\\d+)/status", sa, h(coupons.toggleStatus));
platformRoutes.delete("/superadmin/coupons/:id(\\d+)", sa, h(coupons.remove));

// Report & request: tenants and their team file them; the superadmin triages.
platformRoutes.get("/support-requests", tenant, h(support.mine));
platformRoutes.post("/support-requests", tenant, h(support.create));
platformRoutes.get("/superadmin/support-requests", sa, h(support.list));
platformRoutes.get("/superadmin/support-requests/counts", sa, h(support.counts));
platformRoutes.put("/superadmin/support-requests/:id(\\d+)", sa, h(support.update));

platformRoutes.get("/superadmin/system-info/application", sa, h(sysinfo.application));
platformRoutes.get("/superadmin/system-info/server", sa, h(sysinfo.server));
platformRoutes.get("/superadmin/cache", sa, h(sysinfo.cacheStatus));
platformRoutes.post("/superadmin/cache/clear", sa, h(sysinfo.clearCache));

platformRoutes.get("/superadmin/request-logs", sa, h(requestLogs.list));
platformRoutes.get("/superadmin/request-logs/stats", sa, h(requestLogs.stats));
platformRoutes.post("/superadmin/request-logs/clear", sa, h(requestLogs.clear));
platformRoutes.get("/superadmin/request-logs/:id(\\d+)", sa, h(requestLogs.get));
