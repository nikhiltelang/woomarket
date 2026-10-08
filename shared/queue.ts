/**
 * Optional Redis / BullMQ mode, managed by the superadmin. Without it, one server runs the
 * workers by polling the database (the default, nothing to set up).
 */
import { z } from "zod";

export const queueSettingsSchema = z.object({
  enabled: z.boolean(),
  /** redis://[user:password@]host:6379[/db] or rediss:// for TLS. Omit to keep the stored URL. */
  url: z
    .string()
    .trim()
    .max(500)
    .regex(/^rediss?:\/\/[^\s]+$/, "Use a URL like redis://:password@redis.internal:6379/0 (rediss:// for TLS)")
    .optional()
    .or(z.literal("")),
  prefix: z.string().trim().regex(/^[a-z0-9:_-]{1,40}$/i, "Letters, numbers, : _ and - only").default("wm360"),
  /** Batches each server works on at once, per kind of work. */
  concurrency: z.coerce.number().int().min(1).max(20).default(2),
});
export type QueueSettingsInput = z.infer<typeof queueSettingsSchema>;

export const WORK_KINDS = ["whatsapp", "marketing", "webhooks"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export interface QueueStatus {
  /** Mode this server is running in. */
  mode: "database" | "redis";
  desired: "database" | "redis";
  lastError: string | null;
  since: string;
  instance: string;
  /** Servers seen in the last 30 seconds (Redis mode). */
  instances: { id: string; host: string; pid: number; mode: string; startedAt: string; seenAt: string }[];
  queues: { name: string; waiting: number; active: number; delayed: number; failed: number; completed: number }[];
  scheduled: number;
  redis: { version: string | null; usedMemory: string | null } | null;
}

/** Masks the password in a Redis URL for display. */
export function maskRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "••••";
    return u.toString();
  } catch {
    return "redis://…";
  }
}
