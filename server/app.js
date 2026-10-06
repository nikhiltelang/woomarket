import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csrfMiddleware, issueCsrfToken } from "./csrf.js";
import { authRouter, requireAuth, requireRole } from "./auth.js";
import { appUpdateRouter } from "./app-update.js";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
const page = (name) => path.join(clientDir, "pages", name);

export function createApp({ sessionSecret } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "1mb" }));
  app.use(
    session({
      secret: sessionSecret || process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "true" },
    }),
  );

  // --- API ---------------------------------------------------------------
  app.get("/api/csrf-token", (req, res) => res.json({ token: issueCsrfToken(req) }));
  app.use("/api", csrfMiddleware);
  app.use("/api/auth", authRouter());
  app.use("/api/app-update", requireAuth, requireRole("superadmin"), appUpdateRouter());
  app.use("/api", (req, res) => res.status(404).json({ success: false, message: "Not found" }));

  // --- Pages -------------------------------------------------------------
  app.use("/assets", express.static(path.join(clientDir, "assets")));

  app.get("/login", (req, res) => {
    if (req.session.user) return res.redirect("/");
    res.sendFile(page("login.html"));
  });

  app.get("/", (req, res) => {
    if (!req.session.user) return res.redirect("/login");
    res.sendFile(page("home.html"));
  });

  app.get("/app-update", (req, res) => {
    if (!req.session.user) return res.redirect("/login?next=/app-update");
    if (req.session.user.role !== "superadmin") return res.redirect("/?denied=app-update");
    res.sendFile(page("app-update.html"));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[server] Unhandled error:", err);
    if (res.headersSent) return res.end();
    res.status(err.status || 500).json({ success: false, message: err.message || "Internal server error" });
  });

  return app;
}
