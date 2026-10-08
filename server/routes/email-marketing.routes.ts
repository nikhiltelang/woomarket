import { Router } from "express";
import { imageUpload } from "../lib/uploads";
import * as c from "../controllers/email-marketing.controller";
import { requirePermission, requireRole } from "../middlewares/auth";
import { requireChannelAccess } from "../middlewares/tenant";
import { asyncHandler as h } from "../lib/http";

/** Public endpoints reached from links inside sent emails (no session). */
export const emailPublicRoutes = Router();
emailPublicRoutes.get("/o/:token", h(c.openPixel));
emailPublicRoutes.get("/unsubscribe/:token", h(c.unsubscribePage));
emailPublicRoutes.post("/unsubscribe/:token", h(c.unsubscribe));

export const emailMarketingRoutes = Router();
const view = requirePermission("email:view");
const send = requirePermission("email:send");
emailMarketingRoutes.use(requireRole("admin", "team"));
emailMarketingRoutes.get("/campaigns", view, h(c.listCampaigns));
// Images for the email builder (stored per tenant, served from /uploads).
emailMarketingRoutes.post("/images", send, imageUpload.single("image"), h(c.uploadImage));
emailMarketingRoutes.post("/campaigns", send, requireChannelAccess(), h(c.createCampaign));
emailMarketingRoutes.get("/campaigns/:id/links", view, h(c.campaignLinks));
emailMarketingRoutes.get("/campaigns/:id/ab", view, h(c.abTest));
emailMarketingRoutes.post("/campaigns/:id/ab/decide", send, h(c.abDecide));
emailMarketingRoutes.get("/campaigns/:id", view, h(c.getCampaign));
emailMarketingRoutes.put("/campaigns/:id", send, h(c.updateCampaign));
emailMarketingRoutes.delete("/campaigns/:id", send, h(c.deleteCampaign));
emailMarketingRoutes.post("/campaigns/:id/send", send, h(c.sendCampaign));
emailMarketingRoutes.post("/campaigns/:id/test", send, h(c.testCampaign));
emailMarketingRoutes.patch("/campaigns/:id/status", send, h(c.updateStatus));
emailMarketingRoutes.get("/campaigns/:id/recipients", view, h(c.recipients));
emailMarketingRoutes.get("/audience", view, h(c.audienceCount));
emailMarketingRoutes.get("/templates", view, h(c.listTemplates));
emailMarketingRoutes.post("/templates", send, h(c.createTemplate));
emailMarketingRoutes.put("/templates/:id", send, h(c.updateTemplate));
emailMarketingRoutes.delete("/templates/:id", send, h(c.deleteTemplate));
emailMarketingRoutes.get("/analytics", view, h(c.analytics));
emailMarketingRoutes.get("/simulated-outbox", view, h(c.outbox));
