import express from "express";
import crypto from "node:crypto";
import { newCsrfToken } from "./csrf.js";

// Minimal in-memory user directory: one platform superadmin and one tenant admin.
// Credentials come from the environment; the defaults are for local development only.
function makeUser({ id, username, password, role, tenant = null }) {
  const salt = crypto.randomBytes(16);
  return { id, username, role, tenant, salt, hash: crypto.scryptSync(password, salt, 32) };
}

const USERS = [
  makeUser({
    id: "u-superadmin",
    username: process.env.SUPERADMIN_USERNAME || "superadmin",
    password: process.env.SUPERADMIN_PASSWORD || "superadmin123",
    role: "superadmin",
  }),
  makeUser({
    id: "u-admin",
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "admin123",
    role: "admin",
    tenant: "demo",
  }),
];

export function usingDefaultCredentials() {
  return !process.env.SUPERADMIN_PASSWORD || !process.env.ADMIN_PASSWORD;
}

function verifyPassword(user, password) {
  const hash = crypto.scryptSync(String(password ?? ""), user.salt, 32);
  return crypto.timingSafeEqual(hash, user.hash);
}

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, tenant: u.tenant });

export function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ success: false, message: "Authentication required" });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ success: false, message: "Authentication required" });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ success: false, message: "You do not have permission to perform this action" });
    }
    next();
  };
}

export function authRouter() {
  const router = express.Router();

  router.post("/login", (req, res, next) => {
    const { username, password } = req.body || {};
    const user = USERS.find((u) => u.username === username);
    if (!user || !verifyPassword(user, password)) {
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = publicUser(user);
      req.session.csrfToken = newCsrfToken();
      res.json({ success: true, user: req.session.user, csrfToken: req.session.csrfToken });
    });
  });

  router.post("/logout", (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  });

  router.get("/me", requireAuth, (req, res) => res.json({ user: req.session.user }));

  return router;
}
