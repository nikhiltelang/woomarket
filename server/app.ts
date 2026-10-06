import express, { type Express, type RequestHandler } from "express";
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

  app.use(
    express.json({
      limit: "2mb",
      // Webhook signatures are computed over the exact bytes received.
      verify: (req, _res, buf) => {
        if ((req as express.Request).originalUrl?.startsWith("/webhook")) (req as express.Request).rawBody = Buffer.from(buf);
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

  app.use(webhookRoutes);
  app.use("/api", authenticate, apiRateLimiter, csrfMiddleware, apiRouter());
  app.use("/api", notFoundApi);
  app.use(errorHandler);

  return { app, sessionMiddleware };
}
