import express, { type Express, type RequestHandler } from "express";
import { resolveBrand } from "./services/white-label.service";
import { WIDGET_JS } from "./widget/script";
import { widgetPublicRoutes } from "./routes/widget.routes";
import session from "express-session";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { config, sessionSecret } from "./config";
import { logger } from "./lib/logger";
import { authenticate } from "./middlewares/auth";
import { csrfMiddleware } from "./middlewares/csrf";
import { apiRateLimiter } from "./middlewares/rate-limit";
import { errorHandler, notFoundApi } from "./middlewares/error-handler";
import { apiRouter } from "./routes";
import { webhookRoutes } from "./routes/webhooks.routes";
import { forceSsl, maintenanceGuard } from "./middlewares/platform";
import { robotsTxt, sitemapXml } from "./controllers/system-config.controller";
import { asyncHandler } from "./lib/http";
import { UPLOADS_DIR } from "./lib/uploads";
import { requestLogger } from "./middlewares/request-log";
import { publicApiRoutes } from "./routes/public-api.routes";
import { trackingRoutes } from "./routes/tracking.routes";

export interface CreateAppOptions {
  sessionStore?: session.Store;
}

export interface AppBundle {
  app: Express;
  sessionMiddleware: RequestHandler;
}

/** Builds the Express app (API + webhooks). Static/SPA serving is attached by the server entry. */
export function createApp(opts: CreateAppOptions = {}): AppBundle {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    helmet({
      // The chat widget is embedded in customer sites, so framing stays allowed.
      frameguard: false,
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: config.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
              fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
              imgSrc: ["'self'", "data:", "blob:", "https:"],
              connectSrc: ["'self'", "ws:", "wss:"],
              frameAncestors: ["*"],
            },
          }
        : false,
      hsts: config.isProduction && config.FORCE_HTTPS !== "false",
    }),
  );

  app.use(forceSsl);

  // Request id + access log for API calls.
  app.use((req, res, next) => {
    req.requestId = (req.get("x-request-id") ?? randomUUID()).slice(0, 64);
    res.setHeader("X-Request-Id", req.requestId);
    if (!req.path.startsWith("/api") && !req.path.startsWith("/webhook")) return next();
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      logger[level](
        { requestId: req.requestId, method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode, ms: Math.round(ms), userId: req.user?.id },
        "request",
      );
    });
    next();
  });

  // Stores each API/webhook request and its response for Superadmin → Logs.
  app.use(requestLogger);
  // White-label: which agency's domain (if any) this request arrived on.
  app.use(resolveBrand);

  app.use(
    express.json({
      limit: "2mb",
      // Webhook signatures are computed over the exact bytes received.
      verify: (req, _res, buf) => {
        // Webhook signatures and signed API requests are computed over the exact bytes received.
        const url = (req as express.Request).originalUrl ?? "";
        if (url.startsWith("/webhook") || url.startsWith("/api/v1/")) (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));

  const secureCookie = config.isProduction && config.FORCE_HTTPS !== "false";
  const sessionMiddleware = session({
    name: "connect.sid",
    secret: sessionSecret(),
    store: opts.sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: secureCookie ? "auto" : false,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
  app.use(sessionMiddleware);

  // User uploads (branding images): never executable, never sniffed.
  app.use(
    "/uploads",
    express.static(UPLOADS_DIR, {
      maxAge: "7d",
      setHeaders: (res) => {
        res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    }),
  );
  // Website chat widget script, loaded by customers' sites.
  app.get("/widget.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(WIDGET_JS);
  });
  app.get("/robots.txt", asyncHandler(robotsTxt));
  app.get("/sitemap.xml", asyncHandler(sitemapXml));

  app.use(webhookRoutes);
  app.use(trackingRoutes);
  // Public API: access-key authentication only (no session, no CSRF).
  app.use("/api/v1", publicApiRoutes);
  app.use("/api/widget", widgetPublicRoutes);
  app.use("/api", authenticate, maintenanceGuard, apiRateLimiter, csrfMiddleware, apiRouter());
  app.use("/api", notFoundApi);
  app.use(errorHandler);

  return { app, sessionMiddleware };
}
