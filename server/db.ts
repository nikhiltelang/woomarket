import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "node:path";
import { config } from "./config";
import * as schema from "@shared/schema";
import { childLogger } from "./lib/logger";

const log = childLogger("db");

const safeDecode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v; // raw special characters (e.g. an unencoded % in a password)
  }
};

/**
 * Parses mysql://user:password@host:port/database. Tolerates unencoded special
 * characters in the password (splits on the last "@"), which a strict URL parser rejects.
 */
export function parseDatabaseUrl(url: string) {
  const m = url.match(/^mysql:\/\/(.*)@([^@/]+)\/([^?]*)(?:\?(.*))?$/);
  if (!m) throw new Error("DATABASE_URL must look like mysql://user:password@host:3306/database");
  const [, auth, hostPort, database] = m;
  const sep = auth.indexOf(":");
  const [host, port] = hostPort.split(":");
  return {
    user: safeDecode(sep === -1 ? auth : auth.slice(0, sep)),
    password: sep === -1 ? undefined : safeDecode(auth.slice(sep + 1)),
    host,
    port: port ? Number(port) : 3306,
    database: safeDecode(database),
  };
}

export const pool = mysql.createPool({
  ...parseDatabaseUrl(config.DATABASE_URL ?? "mysql://root@127.0.0.1:3306/woomarket360"),
  connectionLimit: config.DB_POOL_MAX,
  timezone: "Z", // all DATETIME values are UTC
  charset: "utf8mb4",
  waitForConnections: true,
  enableKeepAlive: true,
});

export const db = drizzle(pool, { schema, mode: "default" });
export type Db = typeof db;

/** Connects with retries; in production an unreachable database is fatal. */
export async function connectDatabase(): Promise<void> {
  if (!config.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const attempts = config.isProduction ? config.DB_CONNECT_RETRIES : 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      log.info("Database connection established");
      return;
    } catch (err) {
      log.warn({ err: (err as Error).message, attempt: i, attempts }, "Database not reachable");
      if (i === attempts) throw new Error(`Database is unreachable: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (i - 1), 10000)));
    }
  }
}

async function tableExists(name: string): Promise<boolean> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [name],
  );
  return Number(rows[0]?.n) > 0;
}

/**
 * Applies bundled migrations:
 * - empty database → full schema ("fresh"; the caller seeds it),
 * - database created by the migrator → pending migrations only ("migrated"),
 * - database managed with `db:push` (no migrations journal) → left alone ("skipped").
 */
export async function applyMigrations(): Promise<"fresh" | "migrated" | "skipped"> {
  const migrationsFolder = path.resolve(process.cwd(), "migrations");
  if (!(await tableExists("users"))) {
    log.info("Empty database detected; applying migrations");
    await migrate(db, { migrationsFolder });
    return "fresh";
  }
  if (await tableExists("__drizzle_migrations")) {
    await migrate(db, { migrationsFolder });
    return "migrated";
  }
  log.info("No migrations journal found (schema managed with db:push); skipping migrations");
  return "skipped";
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
