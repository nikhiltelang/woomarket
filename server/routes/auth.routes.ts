import { Router } from "express";
import * as c from "../controllers/auth.controller";
import { requireAuth } from "../middlewares/auth";
import { authRateLimiter } from "../middlewares/rate-limit";
import { asyncHandler as h } from "../lib/http";

export const authRoutes = Router();
authRoutes.post("/signup", authRateLimiter, h(c.signup));
authRoutes.post("/login", authRateLimiter, h(c.login));
authRoutes.post("/logout", h(c.logout));
authRoutes.get("/me", requireAuth, h(c.me));
authRoutes.get("/check", c.check);
authRoutes.put("/profile", requireAuth, h(c.updateProfile));
authRoutes.post("/change-password", requireAuth, authRateLimiter, h(c.changePassword));
