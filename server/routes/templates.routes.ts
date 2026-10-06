import { Router } from "express";
import * as c from "../controllers/templates.controller";
import { requirePermission } from "../middlewares/auth";
import { requireChannelAccess } from "../middlewares/tenant";
import { asyncHandler as h } from "../lib/http";

export const templateRoutes = Router();
const channel = requireChannelAccess();
templateRoutes.get("/", requirePermission("templates:view"), channel, h(c.listTemplates));
templateRoutes.post("/sync", requirePermission("templates:sync"), channel, h(c.syncTemplates));
templateRoutes.post("/", requirePermission("templates:create"), channel, h(c.createTemplate));
templateRoutes.get("/:id", requirePermission("templates:view"), h(c.getTemplate));
templateRoutes.put("/:id", requirePermission("templates:edit"), h(c.updateTemplate));
templateRoutes.delete("/:id", requirePermission("templates:delete"), h(c.deleteTemplate));
