import { Router } from "express";
import * as c from "../controllers/auth.controller";
import * as tf from "../controllers/two-factor.controller";
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

// Two-factor authentication
authRoutes.post("/2fa/verify", authRateLimiter, h(tf.verifyLogin));
authRoutes.get("/2fa", requireAuth, h(tf.getStatus));
authRoutes.post("/2fa/setup", requireAuth, h(tf.setup));
authRoutes.post("/2fa/enable", requireAuth, authRateLimiter, h(tf.enable));
authRoutes.post("/2fa/disable", requireAuth, authRateLimiter, h(tf.disable));
authRoutes.post("/2fa/recovery-codes", requireAuth, authRateLimiter, h(tf.newRecoveryCodes));
