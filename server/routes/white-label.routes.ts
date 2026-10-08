import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as c from "../controllers/white-label.controller";
import { requireRole } from "../middlewares/auth";
import { imageUpload } from "../lib/uploads";
import { asyncHandler as h } from "../lib/http";

/** Agency (tenant admin) endpoints, inside /api. */
export const whiteLabelRoutes = Router();
const admin = requireRole("admin");
whiteLabelRoutes.get("/white-label", admin, h(c.get));
whiteLabelRoutes.put("/white-label", admin, imageUpload.fields([{ name: "logo", maxCount: 1 }, { name: "favicon", maxCount: 1 }]), h(c.saveBrand));
whiteLabelRoutes.get("/white-label/clients", admin, h(c.clients));
whiteLabelRoutes.post("/white-label/domains", admin, h(c.addDomain));
whiteLabelRoutes.post("/white-label/domains/:id/verify", admin, h(c.verify));
whiteLabelRoutes.delete("/white-label/domains/:id", admin, h(c.removeDomain));

const sa = requireRole("superadmin");
whiteLabelRoutes.get("/admin/white-label", sa, h(c.adminList));
whiteLabelRoutes.put("/admin/white-label/domains/:id", sa, h(c.adminSetDomain));

/** Public: certificate "ask" endpoint for the reverse proxy. */
export const whiteLabelPublicRoutes = Router();
whiteLabelPublicRoutes.get(
  "/white-label/tls-check",
  rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-7", legacyHeaders: false }),
  h(c.tlsCheck),
);
