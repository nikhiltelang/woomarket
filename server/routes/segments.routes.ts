import { Router } from "express";
import * as c from "../controllers/segments.controller";
import { requirePermission } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

export const segmentRoutes = Router();
const view = requirePermission("contacts:view");
const manage = requirePermission("groups:manage");
segmentRoutes.get("/", view, h(c.listSegments));
segmentRoutes.post("/preview", view, h(c.previewSegment));
segmentRoutes.post("/", manage, h(c.createSegment));
segmentRoutes.get("/:id", view, h(c.getSegment));
segmentRoutes.get("/:id/contacts", view, h(c.segmentContacts));
segmentRoutes.put("/:id", manage, h(c.updateSegment));
segmentRoutes.delete("/:id", manage, h(c.deleteSegment));
