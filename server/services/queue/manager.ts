/**
 * Runs the background work in one of two modes, chosen by the superadmin:
 *
 * - database (default): one server (the cron leader) polls the database for work, as before.
 * - redis: every server runs BullMQ workers. Ticks for WhatsApp, email/SMS and webhook delivery
 *   are BullMQ jobs, cron jobs are BullMQ job schedulers (each runs once across the cluster),
 *   WhatsApp sends share a per-number rate limit, and Socket.IO broadcasts through Redis.
 *
 * The database stays the record of every message; rows are claimed atomically, so any number of
 * servers can work at once. The mode is re-checked every 15 seconds and switches without a restart.
 */
import crypto from "node:crypto";
import os from "node:os";
import IORedis, { type Redis } from "ioredis";
import { Queue, Worker } from "bullmq";
import { createAdapter } from "@socket.io/redis-adapter";
import { WORK_KINDS, type QueueStatus, type WorkKind } from "@shared/queue";
import { config } from "../../config";
import { decryptStoredSecret } from "../../lib/crypto";
import { childLogger } from "../../lib/logger";
import { executeJob, jobs, startScheduler, stopScheduler } from "../../cron/scheduler";
import { messageQueueWorker } from "../message-queue";
import { marketingWorker } from "../marketing-worker";
import { webhookWorker } from "../webhooks.service";
import { setRealtimeAdapter } from "../realtime";
import { systemConfig } from "../system-config.service";
import { setWakeImpl } from "./wake";

const log = childLogger("queue");
const TICK_MS = 3000;
const RECONCILE_MS = 15_000;
const HEARTBEAT_MS = 10_000;

export interface QueueSettings {
  enabled: boolean;
  url: string | null;
  prefix: string;
  concurrency: number;
}

export async function queueSettings(): Promise<QueueSettings> {
  const q = (await systemConfig.get()).extensionSettings?.queue;
  const url = q?.url ? decryptStoredSecret(q.url) : (config.REDIS_URL ?? null);
  return { enabled: q ? q.enabled : Boolean(config.REDIS_URL), url, prefix: q?.prefix || "wm360", concurrency: q?.concurrency ?? 2 };
}

/** Connects, pings and reads the server version (superadmin "Test connection"). */
export async function testRedis(url: string): Promise<{ version: string | null; latencyMs: number }> {
  const r = new IORedis(url, { lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  r.on("error", () => {});
  try {
    const started = Date.now();
    await r.connect();
    await r.ping();
    const latencyMs = Date.now() - started;
    const info = await r.info("server");
    return { version: /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? null, latencyMs };
  } finally {
    r.disconnect();
  }
}

/** Fixed-window limit shared by all servers: waits until the channel has a free slot this second. */
export async function acquireSendSlot(redis: Redis, prefix: string, channelId: string, perSecond: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const second = Math.floor(Date.now() / 1000);
    const key = `${prefix}:rate:${channelId}:${second}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 3);
    if (n <= perSecond) return;
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + Math.floor(Math.random() * 25)));
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]);

class QueueManager {
  mode: "database" | "redis" = "database";
  private desired: "database" | "redis" = "database";
  private key = "";
  private lastError: string | null = null;
  private since = new Date();
  readonly instance = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
  private started = new Date();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private redis: Redis | null = null;
  private realtimeClients: Redis[] = [];
  private prefix = "wm360";
  private queues: Queue[] = [];
  private workers: Worker[] = [];
  private workQueue: Queue | null = null;
  private realtimeOn = false;
  private downSince: number | null = null;

  /** A dedicated connection (BullMQ workers block on theirs), closed when the mode stops. */
  private extra(redis: Redis): Redis {
    const c = redis.duplicate();
    c.on("error", () => {});
    this.realtimeClients.push(c);
    return c;
  }

  async start() {
    await this.reconcile();
    this.reconcileTimer = setInterval(() => void this.reconcile(), RECONCILE_MS);
    this.reconcileTimer.unref();
  }

  async stop() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    await this.chain;
    await this.stopMode();
  }

  /** Applies the saved settings (serialised: one switch at a time). */
  reconcile(): Promise<void> {
    this.chain = this.chain.then(() => this.apply()).catch((err) => log.error({ err: (err as Error).message }, "Queue reconcile failed"));
    return this.chain;
  }

  private async apply() {
    const s = await queueSettings();
    const wantRedis = s.enabled && Boolean(s.url);
    this.desired = wantRedis ? "redis" : "database";
    const key = wantRedis ? `redis|${s.url}|${s.prefix}|${s.concurrency}` : `database|${config.isCronLeader}`;
    // Redis went away while in use: after 30s, fall back to database polling until it returns.
    if (key === this.key && this.mode === "redis" && this.redis?.status !== "ready") {
      this.downSince ??= Date.now();
      if (Date.now() - this.downSince < 30_000) return;
      log.error("Redis unreachable for 30s; switching to database polling");
      this.key = "";
      this.downSince = null;
    } else if (key === this.key) {
      this.downSince = null;
      return;
    }
    // A failed Redis start is retried every reconcile (it may come back).
    await this.stopMode();
    if (wantRedis) {
      try {
        await Promise.race([this.startRedis(s), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out starting Redis mode")), 20_000).unref())]);
        this.key = key;
        this.lastError = null;
        return;
      } catch (err) {
        this.lastError = `Redis unavailable, using database mode: ${(err as Error).message}`;
        log.error({ err: (err as Error).message }, "Could not start Redis mode; falling back to database polling");
        await this.stopMode();
      }
    }
    await this.startDatabase();
    this.key = wantRedis ? "" : key;
  }

  private async startDatabase() {
    this.mode = "database";
    this.since = new Date();
    setWakeImpl((kind) => {
      if (kind === "webhooks") webhookWorker.wake();
    });
    // Without Redis only one server (the cron leader) works, so nothing runs twice.
    if (!config.isCronLeader) {
      log.info("Database mode: this server isn't the worker leader; workers run on instance 0");
      return;
    }
    messageQueueWorker.start();
    await marketingWorker.start();
    webhookWorker.start();
    startScheduler();
    log.info("Queue mode: database polling");
  }

  private async startRedis(s: QueueSettings) {
    // A one-shot probe first: the long-lived connection below retries forever by design
    // (BullMQ needs that), so its connect() would never fail while Redis is down.
    await testRedis(s.url!);
    const redis = new IORedis(s.url!, { maxRetriesPerRequest: null, lazyConnect: true, connectTimeout: 5000 });
    let lastWarn = 0;
    redis.on("error", (err) => {
      // ioredis retries constantly while Redis is down: log at most every 30 seconds.
      if (Date.now() - lastWarn < 30_000) return;
      lastWarn = Date.now();
      log.warn({ err: err.message }, "Redis connection error");
    });
    this.redis = redis;
    await redis.connect();
    await redis.ping();
    this.prefix = s.prefix;
    const connection = redis;
    const opts = { connection, prefix: s.prefix };

    // Work ticks: any server picks them up; rows are claimed atomically in the database.
    const work = new Queue("work", opts);
    this.workQueue = work;
    this.queues.push(work);
    for (const kind of WORK_KINDS) {
      await work.upsertJobScheduler(`tick:${kind}`, { every: TICK_MS }, { name: kind, opts: { removeOnComplete: 50, removeOnFail: 200 } });
    }
    this.workers.push(
      new Worker(
        "work",
        async (job) => {
          if (job.name === "whatsapp") return messageQueueWorker.tick();
          if (job.name === "marketing") return marketingWorker.tick();
          if (job.name === "webhooks") return webhookWorker.tick();
        },
        { ...opts, connection: this.extra(redis), concurrency: s.concurrency * WORK_KINDS.length },
      ),
    );

    // Cron: one run per interval across the whole cluster.
    const cron = new Queue("cron", opts);
    this.queues.push(cron);
    const keys = new Set(jobs.map((j) => j.key));
    for (const sched of await cron.getJobSchedulers()) if (sched.key && !keys.has(sched.key)) await cron.removeJobScheduler(sched.key);
    for (const j of jobs) await cron.upsertJobScheduler(j.key, { every: j.intervalMs }, { name: j.key, opts: { removeOnComplete: 20, removeOnFail: 50 } });
    this.workers.push(
      new Worker(
        "cron",
        async (job) => {
          const j = jobs.find((x) => x.key === job.name);
          if (!j) return;
          // A slow run must not overlap the next one on another server.
          const lock = await redis.set(`${s.prefix}:lock:cron:${j.key}`, this.instance, "PX", Math.max(j.intervalMs, 60_000), "NX");
          if (!lock) return "skipped: still running elsewhere";
          try {
            return (await executeJob(j)).message;
          } finally {
            await redis.del(`${s.prefix}:lock:cron:${j.key}`);
          }
        },
        { ...opts, connection: this.extra(redis), concurrency: 2 },
      ),
    );
    for (const w of this.workers) w.on("failed", (job, err) => log.warn({ queue: w.name, job: job?.name, err: err.message }, "Queue job failed"));

    messageQueueWorker.throttle = (channelId) => acquireSendSlot(redis, s.prefix, channelId, config.MESSAGE_RATE_PER_SECOND);
    setWakeImpl((kind) => void work.add(kind, {}, { jobId: `wake-${kind}`, removeOnComplete: true, removeOnFail: true }).catch(() => {}));

    // Realtime events reach users connected to any server.
    const pub = redis.duplicate();
    const sub = redis.duplicate();
    this.realtimeClients = [pub, sub];
    this.realtimeOn = true;
    setRealtimeAdapter(createAdapter(pub, sub, { key: `${s.prefix}:socket.io` }));

    const beat = () => void redis.set(`${s.prefix}:instance:${this.instance}`, JSON.stringify({ id: this.instance, host: os.hostname(), pid: process.pid, mode: "redis", startedAt: this.started.toISOString(), seenAt: new Date().toISOString() }), "EX", 30).catch(() => {});
    beat();
    this.heartbeat = setInterval(beat, HEARTBEAT_MS);
    this.heartbeat.unref();

    this.mode = "redis";
    this.since = new Date();
    log.info({ prefix: s.prefix, concurrency: s.concurrency }, "Queue mode: Redis / BullMQ");
  }

  private async stopMode() {
    if (this.mode === "database") {
      stopScheduler();
      await Promise.allSettled([messageQueueWorker.stop(), marketingWorker.stop(), webhookWorker.stop()]);
      return;
    }
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    messageQueueWorker.throttle = async () => {};
    // With Redis down, closing would wait for it forever: drop the connections first, then
    // close without waiting for running jobs (their rows stay claimed and are recovered later).
    const healthy = this.redis?.status === "ready";
    if (!healthy) {
      this.redis?.disconnect();
      for (const c of this.realtimeClients) c.disconnect();
    }
    await Promise.allSettled(this.workers.map((w) => withTimeout(w.close(!healthy), 5000)));
    await Promise.allSettled(this.queues.map((q) => withTimeout(q.close(), 5000)));
    this.workers = [];
    this.queues = [];
    this.workQueue = null;
    if (this.realtimeOn) setRealtimeAdapter(null);
    this.realtimeOn = false;
    // BullMQ leaves connections it was given open: close ours.
    for (const c of this.realtimeClients) c.disconnect();
    this.realtimeClients = [];
    if (this.redis) {
      await this.redis.del(`${this.prefix}:instance:${this.instance}`).catch(() => {});
      this.redis.disconnect();
    }
    this.redis = null;
    this.mode = "database";
  }

  async status(): Promise<QueueStatus> {
    const base: QueueStatus = { mode: this.mode, desired: this.desired, lastError: this.lastError, since: this.since.toISOString(), instance: this.instance, instances: [], queues: [], scheduled: 0, redis: null };
    if (this.mode !== "redis" || !this.redis) return base;
    const redis = this.redis;
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", `${this.prefix}:instance:*`, "COUNT", 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0" && keys.length < 500);
    const instances = (keys.length ? await redis.mget(...keys) : []).filter(Boolean).map((v) => JSON.parse(v!));
    const queues = await Promise.all(
      this.queues.map(async (q) => {
        const c = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed");
        return { name: q.name, waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, completed: c.completed ?? 0 };
      }),
    );
    const scheduled = (await Promise.all(this.queues.map((q) => q.getJobSchedulersCount()))).reduce((a, b) => a + b, 0);
    const info = await redis.info();
    return {
      ...base,
      instances: instances.sort((a, b) => a.id.localeCompare(b.id)),
      queues,
      scheduled,
      redis: { version: /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? null, usedMemory: /used_memory_human:([^\r\n]+)/.exec(info)?.[1] ?? null },
    };
  }

  wake(kind: WorkKind) {
    if (this.workQueue) void this.workQueue.add(kind, {}, { jobId: `wake-${kind}`, removeOnComplete: true, removeOnFail: true }).catch(() => {});
  }
}

export const queueManager = new QueueManager();
