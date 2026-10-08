/**
 * Outgoing webhooks: tenants receive signed JSON POSTs when events happen.
 *
 * - emitEvent() records one delivery per subscribed endpoint (never throws, never blocks).
 * - The worker delivers due rows, retrying with backoff (WEBHOOK_RETRY_DELAYS_S).
 * - Every request goes through a DNS lookup that refuses private, loopback and link-local
 *   addresses at connect time, so endpoints can't be used to reach the internal network
 *   (including by DNS rebinding). Redirects are not followed.
 */
import { wakeWork } from "./queue/wake";
import crypto from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { webhookDeliveries, webhookEndpoints, type WebhookDelivery, type WebhookEndpoint } from "@shared/schema";
import { WEBHOOK_HEADERS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_S, type WebhookEnvelope, type WebhookEvent } from "@shared/webhooks";
import { db } from "../db";
import { config } from "../config";
import { decryptStoredSecret, encryptStoredSecret } from "../lib/crypto";
import { unprocessable } from "../lib/errors";
import { childLogger } from "../lib/logger";

const log = childLogger("webhooks");
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE = 2000;
/** Endpoints are switched off after this many deliveries in a row fail for good. */
export const DISABLE_AFTER_FAILURES = 20;

// ---------------------------------------------------------------------------
// Address safety
// ---------------------------------------------------------------------------

/** Private-network URLs are allowed only when explicitly enabled (local development, tests). */
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE_URLS === "true";

export function isPrivateAddress(ip: string): boolean {
  let addr = ip.toLowerCase();
  if (addr.startsWith("::ffff:")) addr = addr.slice(7); // IPv4-mapped IPv6
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (net.isIPv6(addr)) {
    return addr === "::" || addr === "::1" || addr.startsWith("fc") || addr.startsWith("fd") || addr.startsWith("fe8") || addr.startsWith("fe9") || addr.startsWith("fea") || addr.startsWith("feb") || addr.startsWith("ff") || addr.startsWith("64:ff9b:") || addr.startsWith("2001:db8");
  }
  return true;
}

/** Validates an endpoint URL when it is saved (the connect-time check is the real guard). */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unprocessable("Enter a full URL starting with https://", "INVALID_URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowPrivate())) throw unprocessable("Webhook URLs must use https://", "INVALID_URL");
  if (url.username || url.password) throw unprocessable("Don't put a username or password in the URL; verify our signature instead.", "INVALID_URL");
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw unprocessable("Webhook URLs must be reachable on the public internet.", "PRIVATE_URL");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw unprocessable(`We couldn't find ${host}. Check the address.`, "UNRESOLVABLE_URL");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw unprocessable("Webhook URLs must be reachable on the public internet.", "PRIVATE_URL");
  return url;
}

/** DNS lookup that refuses private addresses (used for every connection). */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = (addresses as unknown as dns.LookupAddress[]) ?? [];
    const bad = !allowPrivate() && list.some((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return callback(Object.assign(new Error(`Refusing to connect to a private address for ${hostname}`), { code: "EPRIVATE" }), "", 4);
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

// ---------------------------------------------------------------------------
// Signing and sending
// ---------------------------------------------------------------------------

export const generateWebhookSecret = () => `whsec_${crypto.randomBytes(24).toString("base64url")}`;

/** "t=<unix>,v1=<hmac>" over `${t}.${body}`. */
export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  durationMs: number;
}

/** POSTs one envelope. Never follows redirects; reads at most a little of the response. */
export function postWebhook(urlStr: string, secret: string, envelope: WebhookEnvelope): Promise<SendResult> {
  const started = Date.now();
  const body = JSON.stringify(envelope);
  const url = new URL(urlStr);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const done = (r: Omit<SendResult, "durationMs">) => resolve({ ...r, durationMs: Date.now() - started });
    if (url.protocol === "http:" && !allowPrivate()) return done({ ok: false, status: null, body: null, error: "Webhook URLs must use https://" });
    const req = lib.request(
      url,
      {
        method: "POST",
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": `${config.APP_NAME}-Webhooks/1.0`,
          [WEBHOOK_HEADERS.event]: envelope.event,
          [WEBHOOK_HEADERS.delivery]: envelope.id,
          [WEBHOOK_HEADERS.timestamp]: String(Math.floor(Date.now() / 1000)),
          [WEBHOOK_HEADERS.signature]: signPayload(secret, body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < MAX_RESPONSE) text += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          done({ ok: status >= 200 && status < 300, status, body: text.slice(0, MAX_RESPONSE) || null, error: status >= 300 && status < 400 ? "Redirects aren't followed; use the final URL" : null });
        });
        res.on("error", (e) => done({ ok: false, status: res.statusCode ?? null, body: null, error: e.message }));
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error(`No response within ${TIMEOUT_MS / 1000}s`), { code: "ETIMEDOUT" })));
    req.on("error", (e: NodeJS.ErrnoException) => done({ ok: false, status: null, body: null, error: e.code === "EPRIVATE" ? "Refused: the URL points to a private network address" : e.message }));
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Endpoints and deliveries
// ---------------------------------------------------------------------------

export const webhooksRepository = {
  listEndpoints(userId: string) {
    return db.select().from(webhookEndpoints).where(eq(webhookEndpoints.userId, userId)).orderBy(desc(webhookEndpoints.createdAt));
  },
  async findEndpoint(id: string): Promise<WebhookEndpoint | undefined> {
    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).limit(1);
    return row;
  },
  async createEndpoint(values: Omit<typeof webhookEndpoints.$inferInsert, "id" | "secret">, secret = generateWebhookSecret()) {
    const id = crypto.randomUUID();
    await db.insert(webhookEndpoints).values({ ...values, id, secret: encryptStoredSecret(secret) });
    return { endpoint: (await this.findEndpoint(id))!, secret };
  },
  async updateEndpoint(id: string, patch: Partial<typeof webhookEndpoints.$inferInsert>) {
    await db.update(webhookEndpoints).set(patch).where(eq(webhookEndpoints.id, id));
    return this.findEndpoint(id);
  },
  async deleteEndpoint(id: string) {
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
  },
  async subscribed(userId: string, event: string) {
    return db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.userId, userId), eq(webhookEndpoints.enabled, true), sql`(JSON_CONTAINS(${webhookEndpoints.events}, JSON_QUOTE(${event})) OR JSON_CONTAINS(${webhookEndpoints.events}, '"*"'))`));
  },
  async listDeliveries(endpointId: string, opts: { limit: number; status?: string }) {
    const conds = [eq(webhookDeliveries.endpointId, endpointId)];
    if (opts.status) conds.push(eq(webhookDeliveries.status, opts.status));
    return db.select().from(webhookDeliveries).where(and(...conds)).orderBy(desc(webhookDeliveries.id)).limit(opts.limit);
  },
  async findDelivery(id: number): Promise<WebhookDelivery | undefined> {
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).limit(1);
    return row;
  },
  async stats(endpointIds: string[]) {
    if (!endpointIds.length) return new Map<string, { succeeded: number; failed: number; pending: number }>();
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await db
      .select({ endpointId: webhookDeliveries.endpointId, status: webhookDeliveries.status, n: sql<number>`COUNT(*)` })
      .from(webhookDeliveries)
      .where(and(inArray(webhookDeliveries.endpointId, endpointIds), sql`${webhookDeliveries.createdAt} >= ${since}`))
      .groupBy(webhookDeliveries.endpointId, webhookDeliveries.status);
    const map = new Map<string, { succeeded: number; failed: number; pending: number }>();
    for (const r of rows) {
      const m = map.get(r.endpointId) ?? { succeeded: 0, failed: 0, pending: 0 };
      if (r.status === "succeeded") m.succeeded += Number(r.n);
      else if (r.status === "failed") m.failed += Number(r.n);
      else m.pending += Number(r.n);
      map.set(r.endpointId, m);
    }
    return map;
  },
  async deleteOldDeliveries(before: Date) {
    const [res] = await db.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, before));
    return res.affectedRows;
  },
};

/**
 * Queues `event` for every endpoint of the tenant subscribed to it. Safe to call anywhere:
 * failures are logged, never thrown, and delivery happens in the background.
 */
export async function emitEvent(tenantId: string | null | undefined, event: WebhookEvent, data: Record<string, unknown>): Promise<number> {
  if (!tenantId) return 0;
  try {
    const endpoints = await webhooksRepository.subscribed(tenantId, event);
    if (!endpoints.length) return 0;
    const eventId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await db.insert(webhookDeliveries).values(
      endpoints.map((e) => ({ endpointId: e.id, eventId, event, payload: { id: eventId, event, createdAt, data }, status: "pending", nextAttemptAt: new Date() })),
    );
    wakeWork("webhooks");
    return endpoints.length;
  } catch (err) {
    log.warn({ event, err: (err as Error).message }, "Could not queue webhook event");
    return 0;
  }
}

/** Fire-and-forget form for hot paths. */
export function emit(tenantId: string | null | undefined, event: WebhookEvent, data: Record<string, unknown>): void {
  void emitEvent(tenantId, event, data);
}

async function recordOutcome(d: WebhookDelivery, endpoint: WebhookEndpoint, r: SendResult) {
  const attempts = d.attempts + 1;
  const base = { attempts, responseStatus: r.status, responseBody: r.body, error: r.error?.slice(0, 500) ?? null, durationMs: r.durationMs, lockedUntil: null };
  if (r.ok) {
    await db.update(webhookDeliveries).set({ ...base, status: "succeeded", deliveredAt: new Date(), nextAttemptAt: null }).where(eq(webhookDeliveries.id, d.id));
    await db.update(webhookEndpoints).set({ lastSuccessAt: new Date(), consecutiveFailures: 0 }).where(eq(webhookEndpoints.id, endpoint.id));
    return;
  }
  // 410 Gone: the receiver (e.g. a deleted Zap) asks us to stop.
  const gone = r.status === 410;
  const final = gone || attempts >= WEBHOOK_MAX_ATTEMPTS;
  await db
    .update(webhookDeliveries)
    .set({ ...base, status: final ? "failed" : "pending", nextAttemptAt: final ? null : new Date(Date.now() + WEBHOOK_RETRY_DELAYS_S[attempts - 1] * 1000) })
    .where(eq(webhookDeliveries.id, d.id));
  const failures = endpoint.consecutiveFailures + (final ? 1 : 0);
  const disable = gone || failures >= DISABLE_AFTER_FAILURES;
  await db
    .update(webhookEndpoints)
    .set({
      lastFailureAt: new Date(),
      consecutiveFailures: failures,
      ...(disable && endpoint.enabled ? { enabled: false, disabledReason: gone ? "The receiver answered 410 Gone (unsubscribed)." : `Turned off after ${failures} deliveries in a row failed.` } : {}),
    })
    .where(eq(webhookEndpoints.id, endpoint.id));
  if (disable && endpoint.enabled) log.warn({ endpointId: endpoint.id, gone, failures }, "Webhook endpoint disabled");
}

/** Sends one delivery now and records the result. */
export async function attemptDelivery(d: WebhookDelivery): Promise<SendResult> {
  const endpoint = await webhooksRepository.findEndpoint(d.endpointId);
  if (!endpoint || !endpoint.enabled) {
    const r = { ok: false, status: null, body: null, error: "Endpoint is turned off", durationMs: 0 };
    await db.update(webhookDeliveries).set({ status: "failed", error: r.error, lockedUntil: null, nextAttemptAt: null }).where(eq(webhookDeliveries.id, d.id));
    return r;
  }
  const result = await postWebhook(endpoint.url, decryptStoredSecret(endpoint.secret), d.payload as unknown as WebhookEnvelope);
  await recordOutcome(d, endpoint, result);
  return result;
}

/** Sends a sample event right away (the "Send test" button). */
export async function sendTest(endpoint: WebhookEndpoint, event: WebhookEvent, data: Record<string, unknown>) {
  const eventId = crypto.randomUUID();
  const payload = { id: eventId, event, createdAt: new Date().toISOString(), test: true, data };
  const [res] = await db.insert(webhookDeliveries).values({ endpointId: endpoint.id, eventId, event, payload, status: "sending", lockedUntil: new Date(Date.now() + 60_000) });
  const d = (await webhooksRepository.findDelivery(Number(res.insertId)))!;
  const result = await postWebhook(endpoint.url, decryptStoredSecret(endpoint.secret), payload as WebhookEnvelope);
  // Tests never retry and don't count towards turning the endpoint off.
  await db
    .update(webhookDeliveries)
    .set({ status: result.ok ? "succeeded" : "failed", attempts: 1, responseStatus: result.status, responseBody: result.body, error: result.error?.slice(0, 500) ?? null, durationMs: result.durationMs, lockedUntil: null, deliveredAt: result.ok ? new Date() : null })
    .where(eq(webhookDeliveries.id, d.id));
  return result;
}

/** Puts a failed delivery back in the queue with a fresh set of retries. */
export async function redeliver(d: WebhookDelivery) {
  await db.update(webhookDeliveries).set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lockedUntil: null }).where(eq(webhookDeliveries.id, d.id));
  webhookWorker.wake();
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class WebhookWorker {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;

  start(intervalMs = 3000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), intervalMs);
    log.info({ intervalMs }, "Webhook worker started");
  }

  /** Runs a tick soon (coalesced). */
  wake() {
    if (!this.timer || this.current) return;
    this.current = this.tick()
      .catch((err) => log.error({ err: (err as Error).message }, "Webhook tick failed"))
      .finally(() => (this.current = null));
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.current;
  }

  /** Claims due deliveries (and ones stuck in "sending") and sends them, a few at a time. */
  async tick(batch = 25, concurrency = 5): Promise<number> {
    const now = new Date();
    const due = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(or(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)), and(eq(webhookDeliveries.status, "sending"), or(isNull(webhookDeliveries.lockedUntil), lt(webhookDeliveries.lockedUntil, now)))))
      .orderBy(webhookDeliveries.id)
      .limit(batch);
    const claimed: WebhookDelivery[] = [];
    for (const { id } of due) {
      const [res] = await db
        .update(webhookDeliveries)
        .set({ status: "sending", lockedUntil: new Date(Date.now() + 2 * TIMEOUT_MS + 10_000) })
        .where(and(eq(webhookDeliveries.id, id), or(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)), and(eq(webhookDeliveries.status, "sending"), or(isNull(webhookDeliveries.lockedUntil), lt(webhookDeliveries.lockedUntil, now))))));
      if (res.affectedRows === 1) claimed.push((await webhooksRepository.findDelivery(id))!);
    }
    for (let i = 0; i < claimed.length; i += concurrency) {
      await Promise.all(claimed.slice(i, i + concurrency).map((d) => attemptDelivery(d).catch((err) => log.warn({ deliveryId: d.id, err: (err as Error).message }, "Delivery crashed"))));
    }
    return claimed.length;
  }
}

export const webhookWorker = new WebhookWorker();
