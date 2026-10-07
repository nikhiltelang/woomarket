/**
 * Web installer. Runs instead of the application while no database is configured: serves the
 * setup wizard, tests database credentials, then migrates, seeds, creates the superadmin and
 * writes .env. Application modules (config, db, repositories) are imported only after the
 * database settings have been verified, because they read their configuration on import.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import mysql from "mysql2/promise";
import { ZodError, type z } from "zod";
import { databaseSchema, installSchema, INSTALL_STEPS, type DatabaseCheck, type InstallStepKey, type Requirement } from "@shared/install";
import { envFilePath } from "./state";

type Db = z.infer<typeof databaseSchema>;
type Install = z.infer<typeof installSchema>;

class InstallError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "INSTALL_ERROR",
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Setup code: proves the person in the browser can read the server's console.
// ---------------------------------------------------------------------------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
function newSetupCode(): string {
  const bytes = crypto.randomBytes(8);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
const normaliseCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function canWrite(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function requirements(production: boolean): Requirement[] {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const envDir = path.dirname(envFilePath());
  const uploads = path.resolve(process.cwd(), "uploads");
  const list: Requirement[] = [
    { key: "node", label: "Node.js 20 or newer", ok: nodeMajor >= 20, detail: `Running ${process.version}` },
    { key: "config", label: "Configuration file is writable", ok: canWrite(envDir), detail: envFilePath() },
    { key: "uploads", label: "Uploads folder is writable", ok: canWrite(uploads), detail: uploads },
  ];
  if (production) {
    const built = fs.existsSync(path.resolve(process.cwd(), "dist/public/index.html"));
    list.push({ key: "build", label: "Web app is built", ok: built, detail: built ? "dist/public" : "Run `npm run build`" });
  }
  return list;
}

function friendlyDbError(err: unknown, db: Db): InstallError {
  const e = err as { code?: string; message?: string };
  const where = `${db.host}:${db.port}`;
  const map: Record<string, string> = {
    ECONNREFUSED: `Nothing is accepting connections at ${where}. Is MySQL running, and is the port right?`,
    ENOTFOUND: `The host "${db.host}" couldn't be found.`,
    EAI_AGAIN: `The host "${db.host}" couldn't be resolved.`,
    ETIMEDOUT: `Connecting to ${where} timed out. Check the host, port and any firewall.`,
    ER_ACCESS_DENIED_ERROR: "MySQL refused the username or password.",
    ER_DBACCESS_DENIED_ERROR: `The user "${db.user}" has no access to the database "${db.database}".`,
    ER_TABLEACCESS_DENIED_ERROR: `The user "${db.user}" can't create tables in "${db.database}". Grant ALL PRIVILEGES on it.`,
    ER_SPECIFIC_ACCESS_DENIED_ERROR: `The user "${db.user}" lacks a required privilege.`,
  };
  return new InstallError(map[e.code ?? ""] ?? `Database error: ${e.message ?? String(err)}`, 422, "DATABASE_ERROR");
}

async function connect(db: Db, withDatabase: boolean) {
  return mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password || undefined,
    database: withDatabase ? db.database : undefined,
    connectTimeout: 8000,
    multipleStatements: false,
  });
}

/** Connects, checks the server version and (optionally) creates the database and checks privileges. */
async function checkDatabase(db: Db, apply: boolean): Promise<DatabaseCheck> {
  let conn: mysql.Connection | null = null;
  try {
    conn = await connect(db, false);
    const [[v]] = (await conn.query("SELECT VERSION() AS v")) as unknown as [[{ v: string }]];
    const version = String(v.v);
    if (/mariadb/i.test(version)) throw new InstallError(`MariaDB (${version}) isn't supported. Use MySQL 8.0.13 or newer.`, 422, "UNSUPPORTED_DATABASE");
    const [maj, min, patch] = version.split(/[.-]/).map(Number);
    if (maj < 8 || (maj === 8 && min === 0 && patch < 13)) throw new InstallError(`MySQL ${version} is too old. Use MySQL 8.0.13 or newer.`, 422, "UNSUPPORTED_DATABASE");

    const [schemas] = (await conn.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [db.database])) as unknown as [unknown[]];
    let exists = schemas.length > 0;
    if (!exists) {
      if (!db.createDatabase) throw new InstallError(`The database "${db.database}" doesn't exist. Create it, or tick "Create it if missing".`, 422, "DATABASE_MISSING");
      if (apply) {
        await conn.query(`CREATE DATABASE \`${db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        exists = true;
      }
    }
    if (!exists) return { ok: true, version, databaseExists: false, tableCount: 0, existingSuperadmins: 0 };

    await conn.changeUser({ database: db.database });
    const [[t]] = (await conn.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()")) as unknown as [[{ n: number }]];
    let superadmins = 0;
    try {
      const [[s]] = (await conn.query("SELECT COUNT(*) AS n FROM `users` WHERE role = 'superadmin'")) as unknown as [[{ n: number }]];
      superadmins = Number(s.n);
    } catch {
      /* no users table yet */
    }
    // Privilege check: the app needs to create and alter tables.
    const probe = `__wm_install_check_${crypto.randomBytes(4).toString("hex")}`;
    await conn.query(`CREATE TABLE \`${probe}\` (id INT PRIMARY KEY)`);
    await conn.query(`DROP TABLE \`${probe}\``);
    return { ok: true, version, databaseExists: true, tableCount: Number(t.n), existingSuperadmins: superadmins };
  } catch (err) {
    if (err instanceof InstallError) throw err;
    throw friendlyDbError(err, db);
  } finally {
    await conn?.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

const PLACEHOLDERS = new Set(["", "change-me", "changeme", "secret", "<openssl rand -hex 32>"]);
const randomHex = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");

export function databaseUrl(db: Db): string {
  const auth = `${encodeURIComponent(db.user)}${db.password ? `:${encodeURIComponent(db.password)}` : ""}`;
  return `mysql://${auth}@${db.host}:${db.port}/${db.database}`;
}

/** Quotes a value so dotenv reads it back unchanged. */
export function envValue(v: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/.test(v)) return v;
  if (!v.includes("'") && !/[\r\n]/.test(v)) return `'${v}'`;
  if (!v.includes('"') && !/[\r\n\\]/.test(v)) return `"${v}"`;
  throw new InstallError("A value contains characters that can't be saved to .env (quotes of both kinds or line breaks).", 400, "UNSAFE_VALUE");
}

/** Replaces existing KEY= lines and appends new keys; other lines (and comments) are kept. */
export function mergeEnv(existing: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !pending.has(m[1])) return line;
    const v = pending.get(m[1])!;
    pending.delete(m[1]);
    return `${m[1]}=${envValue(v)}`;
  });
  if (pending.size) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(`# --- Written by the installer on ${new Date().toISOString()} ---`);
    for (const [k, v] of pending) out.push(`${k}=${envValue(v)}`);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

function existingEnv(): Record<string, string> {
  try {
    const raw = fs.readFileSync(envFilePath(), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

type StepState = { key: InstallStepKey; label: string; status: "pending" | "done" | "failed"; error?: string };

async function install(input: Install): Promise<StepState[]> {
  const steps: StepState[] = INSTALL_STEPS.map((s) => ({ ...s, status: "pending" }));
  const step = async <T>(key: InstallStepKey, fn: () => Promise<T>): Promise<T> => {
    const s = steps.find((x) => x.key === key)!;
    try {
      const r = await fn();
      s.status = "done";
      return r;
    } catch (err) {
      s.status = "failed";
      s.error = err instanceof Error ? err.message : String(err);
      throw Object.assign(err instanceof InstallError ? err : new InstallError(s.error, 500), { steps });
    }
  };

  await step("database", () => checkDatabase(input.database, true));

  const url = databaseUrl(input.database);
  const env = await step("configure", async () => {
    // Application modules read process.env once, when first imported. After a failed attempt
    // that got that far, only the same database can be used without restarting.
    if (process.env.DATABASE_URL && process.env.DATABASE_URL !== url) {
      throw new InstallError("A previous attempt already connected to a different database. Restart the server, then run the installer again.", 409, "RESTART_REQUIRED");
    }
    const prev = existingEnv();
    const keep = (k: string) => (prev[k] && !PLACEHOLDERS.has(prev[k]) ? prev[k] : undefined);
    const values: Record<string, string> = {
      DATABASE_URL: url,
      APP_URL: input.application.appUrl,
      APP_NAME: input.application.siteName,
      SESSION_SECRET: keep("SESSION_SECRET") ?? randomHex(),
      JWT_SECRET: keep("JWT_SECRET") ?? randomHex(),
      ENCRYPTION_KEY: keep("ENCRYPTION_KEY") ?? randomHex(),
      WEBHOOK_VERIFY_TOKEN: keep("WEBHOOK_VERIFY_TOKEN") ?? randomHex(16),
    };
    if (input.smtp) {
      Object.assign(values, {
        SMTP_HOST: input.smtp.host,
        SMTP_PORT: String(input.smtp.port),
        SMTP_SECURE: String(input.smtp.secure),
        SMTP_USER: input.smtp.user,
        SMTP_PASS: input.smtp.pass,
        SMTP_FROM_EMAIL: input.smtp.fromEmail,
        SMTP_FROM_NAME: input.smtp.fromName || input.application.siteName,
      });
    }
    for (const v of Object.values(values)) envValue(v); // refuse unsavable values before changing anything
    Object.assign(process.env, values);
    return values;
  });

  await step("migrate", async () => {
    const db = await import("../db");
    await db.connectDatabase();
    await db.applyMigrations();
  });

  await step("seed", async () => {
    const { runSeed } = await import("../seed");
    const { runStartupMigrations } = await import("../startup-migration");
    const { systemConfig } = await import("../services/system-config.service");
    const a = input.admin;
    await runSeed({ superadmin: { username: a.username, email: a.email, password: a.password, firstName: a.firstName, lastName: a.lastName }, demo: input.application.demoData });
    await runStartupMigrations();
    await systemConfig.update({ siteTitle: input.application.siteName });
    await systemConfig.updatePanel({ name: input.application.siteName });
  });

  // Last: once DATABASE_URL is on disk the app counts as installed.
  await step("save", async () => {
    const file = envFilePath();
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (before) fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
    fs.writeFileSync(file, mergeEnv(before, env), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  });
  return steps;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Serves the wizard until installation succeeds; resolves after the installer has shut down. */
export async function runInstaller(): Promise<void> {
  const production = process.env.NODE_ENV === "production";
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "0.0.0.0";
  const setupCode = process.env.INSTALL_SETUP_CODE?.trim() || newSetupCode();
  const failures: number[] = [];
  let busy = false;
  let finished: (() => void) | null = null;
  const done = new Promise<void>((resolve) => (finished = resolve));

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "100kb" }));

  const requireCode = (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();
    while (failures.length && now - failures[0] > FAILURE_WINDOW_MS) failures.shift();
    if (failures.length >= MAX_FAILURES) return next(new InstallError("Too many wrong setup codes. Wait 15 minutes, or restart the server for a new code.", 429, "TOO_MANY_ATTEMPTS"));
    const given = normaliseCode(String(req.get("x-setup-code") ?? ""));
    const expected = normaliseCode(setupCode);
    const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) {
      failures.push(now);
      return next(new InstallError("That setup code isn't right. Copy it from the server's console output.", 401, "BAD_SETUP_CODE"));
    }
    next();
  };
  const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

  app.get("/api/install/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      installed: false,
      requirements: requirements(production),
      defaults: { siteName: process.env.APP_NAME || "WooMarket360", appUrl: process.env.APP_URL || `${req.protocol}://${req.get("host")}`, database: "woomarket360" },
    });
  });
  app.post("/api/install/verify", requireCode, (_req, res) => res.json({ ok: true }));
  app.post(
    "/api/install/test-database",
    requireCode,
    h(async (req, res) => res.json({ data: await checkDatabase(databaseSchema.parse(req.body), false) })),
  );
  app.post(
    "/api/install/run",
    requireCode,
    h(async (req, res) => {
      if (busy) throw new InstallError("Installation is already running.", 409, "IN_PROGRESS");
      if (requirements(production).some((r) => !r.ok)) throw new InstallError("Fix the failed requirements first.", 422, "REQUIREMENTS");
      const input = installSchema.parse(req.body);
      busy = true;
      try {
        const steps = await install(input);
        console.log(`\n  Installation complete. Sign in as "${input.admin.username}".\n`);
        res.on("finish", () => setTimeout(() => finished?.(), 300));
        res.json({ ok: true, steps, next: "/login" });
      } finally {
        busy = false;
      }
    }),
  );
  // Everything else under /api waits for installation.
  app.use(["/api", "/webhook", "/socket.io"], (_req, res) => {
    res.status(503).json({ success: false, code: "NOT_INSTALLED", message: "The application isn't installed yet. Open /install in your browser." });
  });

  const server = http.createServer(app);
  const flag = `<script>window.__WM_INSTALLER__=true</script>`;
  let closeVite: (() => Promise<void>) | null = null;
  if (production) {
    const publicDir = path.resolve(process.cwd(), "dist/public");
    app.use("/assets", express.static(path.join(publicDir, "assets"), { immutable: true, maxAge: "1y" }));
    app.use(express.static(publicDir, { index: false }));
    app.get("*", (_req, res) => {
      const file = path.join(publicDir, "index.html");
      if (!fs.existsSync(file)) return res.status(500).type("text").send("Client build not found. Run `npm run build`, then restart.");
      res.setHeader("Cache-Control", "no-store");
      res.type("html").send(fs.readFileSync(file, "utf8").replace("</head>", `${flag}</head>`));
    });
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ configFile: path.resolve(process.cwd(), "vite.config.ts"), server: { middlewareMode: true, hmr: { server } }, appType: "custom" });
    closeVite = () => vite.close();
    app.use(vite.middlewares);
    app.get("*", async (req, res, next) => {
      try {
        const template = await fs.promises.readFile(path.resolve(process.cwd(), "client/index.html"), "utf8");
        res.setHeader("Cache-Control", "no-store");
        res.type("html").send((await vite.transformIndexHtml(req.originalUrl, template)).replace("</head>", `${flag}</head>`));
      } catch (err) {
        next(err);
      }
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return res.status(400).json({ success: false, code: "BAD_REQUEST", message: `${first.path.join(".")}: ${first.message}`, details: err.flatten().fieldErrors });
    }
    const e = err as InstallError & { steps?: StepState[] };
    const status = e instanceof InstallError ? e.status : 500;
    if (status >= 500) console.error("Installer error:", e);
    res.status(status).json({ success: false, code: e.code ?? "INSTALL_ERROR", message: e.message, steps: e.steps });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const shown = process.env.APP_URL || `http://localhost:${port}`;
  const lines = ["WooMarket360 isn't installed yet.", `Open ${shown}/install`, `Setup code: ${setupCode}`];
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  console.log(["", `  ┌${"─".repeat(width + 2)}┐`, ...lines.map((l) => `  │  ${l.padEnd(width)}│`), `  └${"─".repeat(width + 2)}┘`, ""].join("\n"));

  await done;
  await closeVite?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
}
