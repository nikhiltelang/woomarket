import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { forbidden } from "../lib/errors";
import { timingSafeEqualStr } from "../lib/crypto";
import { config } from "../config";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths that never carry a browser session or have their own authentication. */
const EXEMPT_PREFIXES = [
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/verify-otp",
  "/api/users/verifyEmail",
  "/api/users/resend-verification",
  "/api/v1/",
  "/api/widget/",
  "/api/email-marketing/unsubscribe/",
  "/api/sms-marketing/calculate-segments",
  "/webhook/",
  "/webhooks/",
];

export const CSRF_COOKIE = "csrf_token";

function cookieOptions(req: Request) {
  const secure = config.FORCE_HTTPS !== "false" && req.secure;
  return { httpOnly: false, sameSite: secure ? ("none" as const) : ("lax" as const), secure, path: "/" };
}

export function issueCsrfToken(req: Request, res: Response, rotate = false): string {
  if (!req.session.csrfToken || rotate) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.cookie(CSRF_COOKIE, req.session.csrfToken, cookieOptions(req));
  return req.session.csrfToken;
}

/**
 * Session-bound CSRF token (also mirrored to the `csrf_token` cookie for the client).
 * Required on state-changing requests that authenticate with the session cookie.
 */
export function csrfMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const path = req.originalUrl.split("?")[0];
  if (EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p))) return next();
  // Bearer-token clients don't send cookies, so they cannot be CSRF'd.
  if (req.authMethod === "bearer" && !req.session?.userId) return next();
  const sent = req.get("x-csrf-token") ?? "";
  const expected = req.session?.csrfToken ?? "";
  if (!sent || !expected || !timingSafeEqualStr(sent, expected)) {
    return next(forbidden("Invalid or missing CSRF token", "CSRF_INVALID"));
  }
  next();
}
