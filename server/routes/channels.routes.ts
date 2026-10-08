import { Router } from "express";
import * as c from "../controllers/channels.controller";
import { requirePermission, requireRole } from "../middlewares/auth";
import { requireChannelAccess } from "../middlewares/tenant";
import { requireSubscription } from "../middlewares/subscription";
import { asyncHandler as h } from "../lib/http";
import * as signup from "../controllers/whatsapp-signup.controller";

export const channelRoutes = Router();
const tenant = requireRole("admin", "team");
channelRoutes.get("/channels/all", requireRole("superadmin"), h(c.listAllChannels));
channelRoutes.get("/admin/channels", requireRole("superadmin"), h(c.listAllChannels));
channelRoutes.get("/channels", tenant, h(c.listChannels));
channelRoutes.get("/channels/active", tenant, h(c.activeChannel));
channelRoutes.post("/channels", requireRole("admin"), requirePermission("settings:edit"), requireSubscription("channel"), h(c.createChannel));
channelRoutes.put("/channels/:id", requirePermission("settings:edit"), requireChannelAccess("id"), h(c.updateChannel));
channelRoutes.delete("/channels/:id", requireRole("admin"), requirePermission("settings:edit"), requireChannelAccess("id"), h(c.deleteChannel));
channelRoutes.post("/channels/:id/health", requirePermission("settings:view"), requireChannelAccess("id"), h(c.checkHealth));
channelRoutes.get("/whatsapp-signup/config", tenant, h(signup.getConfig));
// Plan limits are checked inside for new numbers (reconnecting an existing one is always allowed).
channelRoutes.post("/whatsapp-signup/complete", requireRole("admin"), requirePermission("settings:edit"), h(signup.complete));
channelRoutes.post("/channels/:id/coexistence/sync", requireRole("admin"), requirePermission("settings:edit"), requireChannelAccess("id"), h(signup.sync));
channelRoutes.get("/channels/:id/pin", requireRole("admin"), requirePermission("settings:edit"), requireChannelAccess("id"), h(signup.revealPin));
channelRoutes.post("/channels/:id/simulate-inbound", requirePermission("settings:view"), requireChannelAccess("id"), h(c.simulateInbound));
