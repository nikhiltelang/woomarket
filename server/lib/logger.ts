import pino from "pino";
import { config } from "../config";

export const logger = pino({
  level: config.LOG_LEVEL ?? (config.isTest ? "silent" : config.isProduction ? "info" : "debug"),
  base: { app: config.APP_NAME },
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.accessToken", "*.access_token", "*.token"],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const childLogger = (module: string) => logger.child({ module });
