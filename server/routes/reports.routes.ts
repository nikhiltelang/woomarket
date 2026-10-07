import { Router } from "express";
import * as c from "../controllers/reports.controller";
import { requirePermission } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

export const reportRoutes = Router();
const view = requirePermission("analytics:view");
const exp = requirePermission("analytics:export");
reportRoutes.get("/", view, h(c.getReport));
reportRoutes.get("/export", exp, h(c.exportReport));
reportRoutes.get("/schedules", exp, h(c.listSchedules));
reportRoutes.post("/schedules", exp, h(c.createSchedule));
reportRoutes.put("/schedules/:id", exp, h(c.updateSchedule));
reportRoutes.delete("/schedules/:id", exp, h(c.deleteSchedule));
reportRoutes.post("/schedules/:id/send", exp, h(c.sendNow));
