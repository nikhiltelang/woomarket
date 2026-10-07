import { Router } from "express";
import * as c from "../controllers/users.controller";
import { requireRole } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

/** Superadmin user management. */
export const userRoutes = Router();
const sa = requireRole("superadmin");
userRoutes.get("/admin/users/export", sa, h(c.exportUsers));
userRoutes.get("/admin/users", sa, h(c.listUsers));
userRoutes.put("/admin/users/bulk-status", sa, h(c.bulkStatus));
userRoutes.post("/admin/users/create", sa, h(c.createUser));
userRoutes.get("/admin/users/counts", sa, h(c.userCounts));
userRoutes.put("/admin/users/:id/ban", sa, h(c.banUser));
userRoutes.put("/admin/users/:id/unban", sa, h(c.unbanUser));
userRoutes.put("/admin/users/:id/toggle-email-verify", sa, h(c.toggleVerification));
userRoutes.put("/admin/users/:id/toggle-mobile-verify", sa, h(c.toggleVerification));
userRoutes.get("/admin/users/:id", sa, h(c.getUser));
userRoutes.put("/admin/users/:id/admin-update", sa, h(c.adminUpdateUser));
userRoutes.delete("/admin/users/:id", sa, h(c.deleteUser));
