import { Router } from "express";
import * as c from "../controllers/groups.controller";
import { requirePermission } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

export const groupRoutes = Router();
const view = requirePermission("contacts:view");
const manage = requirePermission("groups:manage");
groupRoutes.get("/", view, h(c.listGroups));
groupRoutes.get("/contact-counts", view, h(c.contactCounts));
groupRoutes.post("/", manage, h(c.createGroup));
groupRoutes.post("/add-contacts", manage, h(c.addContacts));
groupRoutes.post("/remove-contacts", manage, h(c.removeContacts));
groupRoutes.post("/move-contacts", manage, h(c.moveContacts));
groupRoutes.get("/:id", view, h(c.getGroup));
groupRoutes.put("/:id", manage, h(c.updateGroup));
groupRoutes.delete("/:id", manage, h(c.deleteGroup));
