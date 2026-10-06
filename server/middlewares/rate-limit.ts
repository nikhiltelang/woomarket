import rateLimit from "express-rate-limit";
import type { Request } from "express";
import { config } from "../config";

const json = (message: string) => ({ success: false, message, code: "RATE_LIMITED" });

/** General API limiter: per user when logged in, per IP otherwise. */
export const apiRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: (req: Request) => (req.user ? config.API_RATE_LIMIT_AUTHED : config.API_RATE_LIMIT_UNAUTHED),
  keyGenerator: (req: Request) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: json("Too many requests, please slow down."),
  skip: () => config.isTest,
});

/** Brute-force protection for credential endpoints. */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.AUTH_RATE_LIMIT,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: json("Too many attempts. Try again in a few minutes."),
  skip: () => config.isTest,
});
