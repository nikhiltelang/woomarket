import "dotenv/config";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  APP_URL: z.string().url().optional(),
  APP_NAME: z.string().default("WooMarket360"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  NODE_APP_INSTANCE: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),

  DATABASE_URL: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(25),
  DB_CONNECT_RETRIES: z.coerce.number().int().min(1).default(10),

  SESSION_SECRET: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  SEED_SUPERADMIN_PASSWORD: z.string().optional(),
  FORCE_HTTPS: z.string().optional(),

  API_RATE_LIMIT: z.coerce.number().int().positive().default(600),
  API_RATE_LIMIT_AUTHED: z.coerce.number().int().positive().default(1200),
  API_RATE_LIMIT_UNAUTHED: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),

  WHATSAPP_API_VERSION: z.string().default("v25.0"),
  WHATSAPP_GRAPH_URL: z.string().url().default("https://graph.facebook.com"),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_SIMULATE: bool,

  MESSAGE_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  MESSAGE_QUEUE_INTERVAL_MS: z.coerce.number().int().min(200).default(5000),
  MESSAGE_QUEUE_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
  MESSAGE_SEND_DELAY_MS: z.coerce.number().int().min(0).default(100),
  MESSAGE_QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),

  APP_UPDATE_ROOT: z.string().optional(),

  // Platform SMTP fallback (used when neither the tenant nor the superadmin saved SMTP settings)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_FROM_NAME: z.string().optional(),
  SMTP_SECURE: bool,
  /** Capture emails locally instead of sending (defaults to on outside production when no SMTP is configured). */
  EMAIL_SIMULATE: z.enum(["true", "false", "1", "0", ""]).optional(),
  /** Route all SMS through the simulator. */
  SMS_SIMULATE: bool,
  MARKETING_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
  MARKETING_SEND_DELAY_MS: z.coerce.number().int().min(0).default(50),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === "production",
  isTest: parsed.data.NODE_ENV === "test" || Boolean(process.env.VITEST),
  /** Only one instance (PM2 instance 0, or a single process) runs cron jobs and the queue. */
  isCronLeader: !parsed.data.NODE_APP_INSTANCE || parsed.data.NODE_APP_INSTANCE === "0",
};

const PLACEHOLDER_SECRETS = new Set(["", "change-me", "changeme", "secret", "<openssl rand -hex 32>"]);

export function sessionSecret(): string {
  const s = config.SESSION_SECRET ?? "";
  if (PLACEHOLDER_SECRETS.has(s) || s.length < 32) {
    if (config.isProduction) {
      throw new Error("SESSION_SECRET must be set to a random value of at least 32 characters in production (openssl rand -hex 32).");
    }
    return "development-only-session-secret-do-not-use-in-production";
  }
  return s;
}

export function jwtSecret(): string {
  return config.JWT_SECRET && config.JWT_SECRET.length >= 32 ? config.JWT_SECRET : sessionSecret();
}
