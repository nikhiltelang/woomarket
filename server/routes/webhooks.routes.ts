import { Router } from "express";
import * as c from "../controllers/webhooks.controller";
import * as sms from "../controllers/sms-marketing.controller";
import { asyncHandler as h } from "../lib/http";

/** Inbound Meta webhooks (mounted at the site root, outside /api). */
export const webhookRoutes = Router();
webhookRoutes.get("/webhook/global", c.verifyWebhook);
webhookRoutes.post("/webhook/global", h(c.receiveWebhook));
webhookRoutes.get("/webhook/:id", c.verifyWebhook);
webhookRoutes.post("/webhook/:id", h(c.receiveWebhook));

// SMS delivery receipts
webhookRoutes.post("/webhooks/sms/twilio/:gatewayId", h(sms.twilioStatus));
webhookRoutes.get("/webhooks/sms/vonage/:gatewayId", h(sms.vonageStatus));
webhookRoutes.post("/webhooks/sms/vonage/:gatewayId", h(sms.vonageStatus));
