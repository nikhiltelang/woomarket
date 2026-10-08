import { Router } from "express";
import * as c from "../controllers/automations.controller";
import { requirePermission } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

/** Automation flows (inside /api/automations). */
export const automationRoutes = Router();
const view = requirePermission("automations:view");
const manage = requirePermission("settings:edit");
automationRoutes.get("/", view, h(c.list));
automationRoutes.post("/", manage, h(c.create));
automationRoutes.get("/runs/:runId", view, h(c.runDetail));
automationRoutes.post("/runs/:runId/exit", manage, h(c.exitRun));
automationRoutes.get("/:id", view, h(c.get));
automationRoutes.put("/:id", manage, h(c.update));
automationRoutes.delete("/:id", manage, h(c.remove));
automationRoutes.post("/:id/status", manage, h(c.setStatus));
automationRoutes.post("/:id/duplicate", manage, h(c.duplicate));
automationRoutes.get("/:id/stats", view, h(c.stats));
automationRoutes.get("/:id/runs", view, h(c.runs));
automationRoutes.post("/:id/enroll", manage, h(c.enrol));
