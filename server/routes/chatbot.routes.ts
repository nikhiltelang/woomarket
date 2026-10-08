import { Router } from "express";
import * as c from "../controllers/chatbot.controller";
import { requirePermission } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

/** Chatbot and auto-replies (inside /api/chatbot). */
export const chatbotRoutes = Router();
const view = requirePermission("automations:view");
const manage = requirePermission("settings:edit");
chatbotRoutes.get("/", view, h(c.overview));
chatbotRoutes.put("/settings", manage, h(c.saveSettings));
chatbotRoutes.post("/rules", manage, h(c.createRule));
chatbotRoutes.put("/rules/order", manage, h(c.reorder));
chatbotRoutes.put("/rules/:id", manage, h(c.updateRule));
chatbotRoutes.patch("/rules/:id", manage, h(c.toggleRule));
chatbotRoutes.delete("/rules/:id", manage, h(c.deleteRule));
chatbotRoutes.post("/test", view, h(c.test));
chatbotRoutes.get("/events", view, h(c.events));
chatbotRoutes.post("/conversations/:id/pause", requirePermission("inbox:send"), h(c.pauseConversation));
