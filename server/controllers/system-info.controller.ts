import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { z } from "zod";
import { count, eq, lt, or } from "drizzle-orm";
import { otpVerifications, session, webhookDedup } from "@shared/schema";
import { db, pool } from "../db";
import { config } from "../config";
import { parseBody } from "../lib/http";
import { activityRepository } from "../repositories/activity.repository";
import { systemConfig } from "../services/system-config.service";
import { getRoot, readVersion } from "../app-update/controller";

interface Row {
  label: string;
  value: string;
}

const startedAt = new Date();

function packageVersion(name: string): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(getRoot(), "node_modules", name, "package.json"), "utf8")).version);
  } catch {
    return "unknown";
  }
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** First non-internal address, IPv4 preferred. */
function serverIp(): string {
  const all = Object.values(os.networkInterfaces()).flatMap((list) => list ?? []).filter((a) => !a.internal);
  return (all.find((a) => a.family === "IPv4") ?? all[0])?.address ?? "127.0.0.1";
}

async function database(): Promise<{ version: string; name: string; migrations: string }> {
  const [[info]] = (await pool.query("SELECT VERSION() AS version, DATABASE() AS name")) as unknown as [[{ version: string; name: string }]];
  let migrations = "not tracked (db:push)";
  try {
    const [[m]] = (await pool.query("SELECT COUNT(*) AS n FROM `__drizzle_migrations`")) as unknown as [[{ n: number }]];
    migrations = String(m.n);
  } catch {}
  return { version: info.version, name: info.name, migrations };
}

/** GET /api/superadmin/system-info/application */
export async function application(_req: Request, res: Response) {
  const [sys, db] = await Promise.all([systemConfig.get(), database()]);
  const rows: Row[] = [
    { label: "Application name", value: sys.siteTitle ?? "WooMarket360" },
    { label: "Application version", value: readVersion(getRoot()) },
    { label: "Environment", value: config.NODE_ENV },
    { label: "Node.js version", value: process.version.replace(/^v/, "") },
    { label: "Express version", value: packageVersion("express") },
    { label: "Drizzle ORM version", value: packageVersion("drizzle-orm") },
    { label: "Default timezone", value: sys.timezone ?? "UTC" },
    { label: "Database server", value: `MySQL ${db.version}` },
    { label: "Database name", value: db.name },
    { label: "Migrations applied", value: db.migrations },
    { label: "Started at", value: startedAt.toISOString() },
    { label: "Application uptime", value: formatDuration(process.uptime()) },
  ];
  res.json({ data: rows });
}

/** GET /api/superadmin/system-info/server */
export async function server(req: Request, res: Response) {
  const cpus = os.cpus();
  const mem = process.memoryUsage();
  const load = os.loadavg();
  const rows: Row[] = [
    { label: "Runtime", value: `Node.js ${process.version.replace(/^v/, "")}` },
    { label: "Server software", value: `Node.js HTTP server (Express ${packageVersion("express")})` },
    { label: "Server IP address", value: serverIp() },
    { label: "Server protocol", value: `${req.secure ? "HTTPS" : "HTTP"}/${req.httpVersion}` },
    { label: "HTTP host", value: req.get("host") ?? req.hostname },
    { label: "Server port", value: String(req.socket.localPort ?? config.PORT) },
    { label: "Hostname", value: os.hostname() },
    { label: "Operating system", value: `${os.type()} ${os.release()} (${os.arch()})` },
    { label: "CPU", value: cpus.length ? `${cpus[0].model.trim()} × ${cpus.length}` : "unknown" },
    { label: "Load average (1 / 5 / 15 min)", value: load.map((l) => l.toFixed(2)).join(" / ") },
    { label: "System memory", value: `${formatBytes(os.totalmem() - os.freemem())} used of ${formatBytes(os.totalmem())}` },
    { label: "Process memory", value: `${formatBytes(mem.rss)} resident, ${formatBytes(mem.heapUsed)} heap` },
    { label: "System uptime", value: formatDuration(os.uptime()) },
  ];
  res.json({ data: rows });
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const WEBHOOK_KEEP_DAYS = 7; // Meta retries webhook deliveries for up to 7 days

const CACHES = {
  settings: {
    name: "Settings cache",
    description: "In-memory copy of system settings, branding, policies and languages (refreshes every 10 seconds on its own).",
    count: async () => (systemConfig.isCached() ? 1 : 0),
    clear: async () => {
      const n = systemConfig.isCached() ? 1 : 0;
      systemConfig.invalidate();
      return n;
    },
  },
  sessions: {
    name: "Expired sessions",
    description: "Sign-in sessions that have expired but are still stored.",
    count: async () => countRows(session, lt(session.expire, new Date())),
    clear: async () => affected(await db.delete(session).where(lt(session.expire, new Date()))),
  },
  verification: {
    name: "Used & expired verification codes",
    description: "Email verification codes that were used or have expired.",
    count: async () => countRows(otpVerifications, or(eq(otpVerifications.isUsed, true), lt(otpVerifications.expiresAt, new Date()))),
    clear: async () => affected(await db.delete(otpVerifications).where(or(eq(otpVerifications.isUsed, true), lt(otpVerifications.expiresAt, new Date())))),
  },
  webhooks: {
    name: "Old webhook duplicate-check keys",
    description: `WhatsApp message IDs older than ${WEBHOOK_KEEP_DAYS} days, kept to ignore repeated webhook deliveries.`,
    count: async () => countRows(webhookDedup, lt(webhookDedup.createdAt, webhookCutoff())),
    clear: async () => affected(await db.delete(webhookDedup).where(lt(webhookDedup.createdAt, webhookCutoff()))),
  },
} as const;

type CacheKey = keyof typeof CACHES;
const CACHE_KEYS = Object.keys(CACHES) as [CacheKey, ...CacheKey[]];

const webhookCutoff = () => new Date(Date.now() - WEBHOOK_KEEP_DAYS * 86400_000);
const affected = (res: unknown) => Number((res as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
async function countRows(table: typeof session | typeof otpVerifications | typeof webhookDedup, where: ReturnType<typeof lt> | undefined) {
  const [{ n }] = await db.select({ n: count() }).from(table).where(where);
  return Number(n);
}

/** GET /api/superadmin/cache */
export async function cacheStatus(_req: Request, res: Response) {
  const data = await Promise.all(CACHE_KEYS.map(async (key) => ({ key, name: CACHES[key].name, description: CACHES[key].description, entries: await CACHES[key].count() })));
  res.json({ data });
}

const clearSchema = z.object({ keys: z.array(z.enum(CACHE_KEYS)).min(1).optional() });

/** POST /api/superadmin/cache/clear — clears the given caches (all when none given). */
export async function clearCache(req: Request, res: Response) {
  const keys = parseBody(clearSchema, req).keys ?? CACHE_KEYS;
  const cleared: Record<string, number> = {};
  for (const key of keys) cleared[key] = await CACHES[key].clear();
  await activityRepository.record(req, req.user!.id, "cache_cleared", { type: "system", id: "cache" }, cleared);
  res.json({ data: cleared });
}
