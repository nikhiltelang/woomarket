import { Router } from "express";
import * as c from "../controllers/campaigns.controller";
import { requirePermission } from "../middlewares/auth";
import { requireChannelAccess } from "../middlewares/tenant";
import { asyncHandler as h } from "../lib/http";

export const campaignRoutes = Router();
const view = requirePermission("campaigns:view");
campaignRoutes.get("/", view, requireChannelAccess(), h(c.listCampaigns));
campaignRoutes.post("/", requirePermission("campaigns:create"), requireChannelAccess(), h(c.create));
campaignRoutes.get("/:id", view, h(c.getCampaign));
campaignRoutes.get("/:id/analytics", view, h(c.analytics));
campaignRoutes.get("/:id/recipients", view, h(c.recipients));
campaignRoutes.get("/:id/ab", view, h(c.abTest));
campaignRoutes.post("/:id/ab/decide", requirePermission("campaigns:send"), h(c.abDecide));
campaignRoutes.post("/:id/start", requirePermission("campaigns:send"), h(c.start));
campaignRoutes.patch("/:id/status", requirePermission("campaigns:edit"), h(c.updateStatus));
campaignRoutes.delete("/:id", requirePermission("campaigns:delete"), h(c.remove));
