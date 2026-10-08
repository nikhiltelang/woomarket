import { Router } from "express";
import * as c from "../controllers/social.controller";
import { requirePermission } from "../middlewares/auth";
import { asyncHandler as h } from "../lib/http";

/** Instagram & Messenger connections (inside /api). */
export const socialRoutes = Router();
const manage = requirePermission("settings:edit");
socialRoutes.get("/", requirePermission("settings:view"), h(c.list));
socialRoutes.post("/", manage, h(c.connect));
socialRoutes.put("/:id", manage, h(c.update));
socialRoutes.delete("/:id", manage, h(c.remove));
socialRoutes.post("/:id/simulate", manage, h(c.simulate));
