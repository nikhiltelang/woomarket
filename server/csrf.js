import crypto from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function newCsrfToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function issueCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = newCsrfToken();
  return req.session.csrfToken;
}

/** Rejects state-changing requests whose `X-CSRF-Token` header doesn't match the session token. */
export function csrfMiddleware(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const sent = req.get("X-CSRF-Token") || "";
  const expected = req.session?.csrfToken || "";
  const ok =
    sent.length > 0 &&
    sent.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) return res.status(403).json({ success: false, message: "Invalid or missing CSRF token" });
  next();
}
