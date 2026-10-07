import { REQUEST_LOG_DEFAULTS } from "@shared/platform";
import type { RequestLogSettings } from "@shared/schema";
import { childLogger } from "../lib/logger";
import { requestLogsRepository, type NewRequestLog } from "../repositories/request-logs.repository";
import { systemConfig } from "./system-config.service";

const log = childLogger("request-log");

// Rows are buffered and written in batches, off the request path. If the database falls
// behind, the oldest buffered rows are dropped rather than growing memory without bound.
const FLUSH_MS = 2000;
const BATCH = 200;
const MAX_QUEUE = 5000;

const queue: NewRequestLog[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let dropped = 0;

export type ResolvedLogSettings = Required<RequestLogSettings>;

export async function requestLogSettings(): Promise<ResolvedLogSettings> {
  const s = (await systemConfig.get()).requestLogSettings ?? {};
  return { ...REQUEST_LOG_DEFAULTS, ...s };
}

export function enqueueRequestLog(row: NewRequestLog) {
  queue.push(row);
  if (queue.length > MAX_QUEUE) dropped += queue.splice(0, queue.length - MAX_QUEUE).length;
  if (queue.length >= BATCH) void flushRequestLogs();
  else if (!timer) {
    timer = setTimeout(() => void flushRequestLogs(), FLUSH_MS);
    timer.unref();
  }
}

/** Writes everything buffered so far (also called on shutdown). */
export async function flushRequestLogs(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (flushing) await flushing;
  flushing = (async () => {
    while (queue.length) {
      const batch = queue.splice(0, BATCH);
      try {
        await requestLogsRepository.insertMany(batch);
      } catch (err) {
        dropped += batch.length;
        log.warn({ err: (err as Error).message, rows: batch.length }, "Could not store request logs");
        break;
      }
    }
    if (dropped) {
      log.warn({ dropped }, "Request log rows dropped");
      dropped = 0;
    }
  })().finally(() => (flushing = null));
  await flushing;
}

export const pendingRequestLogs = () => queue.length;
