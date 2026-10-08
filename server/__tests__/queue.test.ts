import { describe, it, expect, afterEach, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import type { Redis } from "ioredis";
import { maskRedisUrl, queueSettingsSchema } from "@shared/queue";
import { acquireSendSlot, queueSettings, testRedis } from "../services/queue/manager";
import { systemConfig } from "../services/system-config.service";
import { makeSystemConfig } from "./helpers";
import { encryptStoredSecret } from "../lib/crypto";
import { config } from "../config";
import { db } from "../db";
import { emailCampaignsRepository, STALE_CLAIM_MS } from "../repositories/email.repository";

afterEach(() => vi.restoreAllMocks());

describe("settings", () => {
  it("validates and masks", () => {
    expect(queueSettingsSchema.safeParse({ enabled: true, url: "http://x" }).success).toBe(false);
    expect(queueSettingsSchema.parse({ enabled: true, url: "rediss://:pw@cache.example.com:6380/0" }).prefix).toBe("wm360");
    expect(queueSettingsSchema.safeParse({ enabled: true, prefix: "bad prefix" }).success).toBe(false);
    expect(maskRedisUrl("redis://default:s3cret@host:6379/1")).toBe("redis://default:%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2@host:6379/1");
  });

  it("uses the saved settings, else REDIS_URL from the environment", async () => {
    vi.spyOn(systemConfig, "get").mockResolvedValue(makeSystemConfig({ extensionSettings: { queue: { enabled: true, url: encryptStoredSecret("redis://saved:6379"), prefix: "acme", concurrency: 4 } } }));
    expect(await queueSettings()).toEqual({ enabled: true, url: "redis://saved:6379", prefix: "acme", concurrency: 4 });
    vi.spyOn(systemConfig, "get").mockResolvedValue(makeSystemConfig());
    const prev = config.REDIS_URL;
    (config as { REDIS_URL?: string }).REDIS_URL = "redis://env:6379";
    expect(await queueSettings()).toMatchObject({ enabled: true, url: "redis://env:6379" });
    (config as { REDIS_URL?: string }).REDIS_URL = undefined;
    expect(await queueSettings()).toMatchObject({ enabled: false, url: null });
    (config as { REDIS_URL?: string }).REDIS_URL = prev;
  });

  it("reports an unreachable Redis", async () => {
    await expect(testRedis("redis://127.0.0.1:1")).rejects.toThrow();
  });
});

describe("cluster-wide send limit", () => {
  it("lets N sends per second through and makes the next one wait for the next second", async () => {
    const counts = new Map<string, number>();
    const fake = {
      incr: vi.fn(async (k: string) => {
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return counts.get(k)!;
      }),
      expire: vi.fn(async () => 1),
    } as unknown as Redis;
    // Start just after a second boundary so the three sends share one window.
    await new Promise((r) => setTimeout(r, 1005 - (Date.now() % 1000)));
    const started = Date.now();
    for (let i = 0; i < 3; i++) await acquireSendSlot(fake, "t", "chan", 3);
    expect(Date.now() - started).toBeLessThan(300);
    await acquireSendSlot(fake, "t", "chan", 3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect([...counts.keys()].every((k) => k.startsWith("t:rate:chan:"))).toBe(true);
  });
});

describe("stale claim recovery", () => {
  it("only resets recipients claimed longer ago than the limit", async () => {
    const where = vi.fn(async () => [{}]);
    const set = vi.fn(() => ({ where }));
    vi.spyOn(db, "update").mockReturnValue({ set } as never);
    await emailCampaignsRepository.recoverProcessing();
    expect(set).toHaveBeenCalledWith({ status: "pending", claimedAt: null });
    const q = new MySqlDialect().sqlToQuery((where.mock.calls[0] as unknown as [SQL])[0]);
    expect(q.sql).toMatch(/`status` = \? and \(`email_campaign_recipients`\.`claimed_at` is null or `email_campaign_recipients`\.`claimed_at` < \?\)/);
    expect(Math.abs(Date.now() - STALE_CLAIM_MS - new Date(`${String(q.params[1]).replace(" ", "T")}Z`).getTime())).toBeLessThan(5000);
    expect(STALE_CLAIM_MS).toBe(600_000);
  });
});
