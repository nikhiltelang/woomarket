import { Router } from "express";
import * as c from "../controllers/team.controller";
import { requirePermission, requireRole } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

export const teamRoutes = Router();
teamRoutes.use(requireRole("admin", "team"));
teamRoutes.get("/members", requirePermission("team:view"), h(c.listMembers));
teamRoutes.get("/assignees", requirePermission("inbox:view", "team:view"), h(c.listAssignees));
teamRoutes.get("/activity-logs", requirePermission("team:view"), h(c.activityLogs));
teamRoutes.get("/members/:id", requirePermission("team:view"), h(c.getMember));
teamRoutes.post("/members", requireRole("admin"), requirePermission("team:create"), h(c.createMember));
teamRoutes.put("/members/:id", requirePermission("team:edit"), h(c.updateMember));
teamRoutes.patch("/members/:id/status", requirePermission("team:edit"), h(c.updateMemberStatus));
teamRoutes.patch("/members/:id/password", requireRole("admin"), requirePermission("team:edit"), h(c.setMemberPassword));
teamRoutes.patch("/members/:id/permissions", requireRole("admin"), requirePermission("team:permissions"), h(c.updateMemberPermissions));
teamRoutes.delete("/members/:id", requireRole("admin"), requirePermission("team:delete"), h(c.deleteMember));
