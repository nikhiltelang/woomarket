import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express, { type Express } from "express";
import { config, sessionSecret } from "./config";
import { logger } from "./lib/logger";
import { applyMigrations, closeDatabase, connectDatabase } from "./db";
import { runStartupMigrations } from "./startup-migration";
import { createApp } from "./app";
import { MySqlSessionStore } from "./session-store";
import { attachRealtime, closeRealtime } from "./services/realtime";
import { messageQueueWorker } from "./services/message-queue";
import { marketingWorker } from "./services/marketing-worker";
import { startScheduler, stopScheduler } from "./cron/scheduler";
import { reconcileStaleRuns } from "./app-update/reconciler";
import { runSeed } from "./seed";

process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "Unhandled promise rejection"));
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — exiting so the process manager restarts the app");
  process.exit(1);
});

async function attachClient(app: Express, server: http.Server) {
  const isApiPath = (url: string) => url.startsWith("/api") || url.startsWith("/webhook") || url.startsWith("/socket.io");

  if (!config.isProduction) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: path.resolve(process.cwd(), "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "custom",
    });
    app.use(vite.middlewares);
    app.use(async (req, res, next) => {
      if (req.method !== "GET" || isApiPath(req.originalUrl)) return next();
      try {
        const template = await fs.promises.readFile(path.resolve(process.cwd(), "client/index.html"), "utf8");
        res.status(200).set({ "Content-Type": "text/html" }).end(await vite.transformIndexHtml(req.originalUrl, template));
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
    return;
  }

  const publicDir = path.resolve(process.cwd(), "dist/public");
  if (!fs.existsSync(path.join(publicDir, "index.html"))) {
    throw new Error(`Client build not found in ${publicDir}. Run \`npm run build\` first.`);
  }
  app.use("/assets", express.static(path.join(publicDir, "assets"), { immutable: true, maxAge: "1y" }));
  app.use(express.static(publicDir, { index: false, maxAge: "1h" }));
  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || isApiPath(req.originalUrl)) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

async function main() {
  sessionSecret(); // refuses to start in production without a real secret
  await connectDatabase();
  if ((await applyMigrations()) === "fresh") await runSeed();
  await runStartupMigrations();

  const sessionStore = new MySqlSessionStore();
  const { app, sessionMiddleware } = createApp({ sessionStore });
  const server = http.createServer(app);
  attachRealtime(server, sessionMiddleware);
  await attachClient(app, server);

  await new Promise<void>((resolve) => server.listen(config.PORT, config.HOST, resolve));
  logger.info({ port: config.PORT, env: config.NODE_ENV }, `${config.APP_NAME} listening on http://localhost:${config.PORT}`);

  if (config.isCronLeader) {
    await reconcileStaleRuns().catch((err) => logger.error({ err }, "Update-run reconciler failed"));
    messageQueueWorker.start();
    await marketingWorker.start();
    startScheduler();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    const force = setTimeout(() => {
      logger.warn("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    force.unref();
    stopScheduler();
    await messageQueueWorker.stop();
    await marketingWorker.stop();
    await closeRealtime();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    sessionStore.close();
    await closeDatabase();
    logger.info("Shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : err }, "Failed to start");
  process.exit(1);
});
