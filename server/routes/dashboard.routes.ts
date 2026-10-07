import { Router } from "express";
import * as c from "../controllers/dashboard.controller";
import { requireRole } from "../middlewares/auth";
import { requireChannelAccess } from "../middlewares/tenant";
import { asyncHandler as h } from "../lib/http";

export const dashboardRoutes = Router();
dashboardRoutes.get("/dashboard/stats", requireChannelAccess(), h(c.channelStats));
dashboardRoutes.get("/agents/online", c.onlineAgents);
dashboardRoutes.get("/superadmin/dashboard-overview", requireRole("superadmin"), h(c.platformOverview));
dashboardRoutes.get("/superadmin/server-info", requireRole("superadmin"), h(c.serverInfo));
dashboardRoutes.get("/superadmin/reports", requireRole("superadmin"), h(c.platformReport));
dashboardRoutes.get("/superadmin/login-stats", requireRole("superadmin"), h(c.loginStats));
