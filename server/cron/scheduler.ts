import { childLogger } from "../lib/logger";
import { startDueCampaigns } from "../services/campaign.service";
import { startDueMarketingCampaigns } from "../services/marketing.service";
import { channelsRepository } from "../repositories/channels.repository";
import { cronLogRepository } from "../repositories/platform.repository";
import { whatsappFactory } from "../services/whatsapp";

const log = childLogger("cron");

export interface Job {
  key: string;
  name: string;
  description: string;
  intervalMs: number;
  /** Returns a short summary for the log, if any. */
  run: () => Promise<string | void>;
}

export const jobs: Job[] = [
  {
    key: "scheduled-campaigns",
    name: "Scheduled WhatsApp campaigns",
    description: "Starts WhatsApp campaigns whose scheduled time has passed.",
    intervalMs: 60_000,
    run: async () => `${await startDueCampaigns()} campaign(s) started`,
  },
  {
    key: "scheduled-email-sms-campaigns",
    name: "Scheduled email & SMS campaigns",
    description: "Starts email and SMS campaigns whose scheduled time has passed.",
    intervalMs: 60_000,
    run: async () => {
      await startDueMarketingCampaigns();
    },
  },
  {
    key: "channel-health-monitor",
    name: "Channel health monitor",
    description: "Refreshes quality rating and messaging limits of every active WhatsApp number.",
    intervalMs: 6 * 60 * 60 * 1000,
    run: async () => {
      const list = await channelsRepository.listActive();
      for (const channel of list) {
        const health = await whatsappFactory.create(channel).checkHealth();
        await channelsRepository.recordHealth(channel.id, health.status, health.details);
      }
      return `${list.length} channel(s) checked`;
    },
  },
  {
    key: "cron-log-cleanup",
    name: "Cron log cleanup",
    description: "Deletes cron job logs older than 30 days.",
    intervalMs: 24 * 60 * 60 * 1000,
    run: async () => {
      await cronLogRepository.prune(30);
    },
  },
];

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();
export const nextRunAt = new Map<string, number>();

/** Runs a job now (no overlap with an in-flight run of the same job) and records the outcome. */
export async function executeJob(job: Job): Promise<{ status: "success" | "failed" | "skipped"; message: string; durationMs: number }> {
  if (running.has(job.key)) return { status: "skipped", message: "Already running", durationMs: 0 };
  running.add(job.key);
  const started = Date.now();
  let result: { status: "success" | "failed"; message: string };
  try {
    result = { status: "success", message: (await job.run()) || "OK" };
  } catch (err) {
    result = { status: "failed", message: (err as Error).message };
    log.error({ job: job.key, err: result.message }, "Job failed");
  } finally {
    running.delete(job.key);
  }
  const durationMs = Date.now() - started;
  await cronLogRepository.record({ jobKey: job.key, jobName: job.name, status: result.status, message: result.message, durationMs }).catch(() => {});
  return { ...result, durationMs };
}

export const isRunning = (key: string) => running.has(key);

export function startScheduler() {
  for (const job of jobs) {
    nextRunAt.set(job.key, Date.now() + 5_000);
    setTimeout(() => void executeJob(job), 5_000).unref();
    timers.push(
      setInterval(() => {
        nextRunAt.set(job.key, Date.now() + job.intervalMs);
        void executeJob(job);
      }, job.intervalMs),
    );
  }
  log.info({ jobs: jobs.map((j) => j.key) }, "Scheduler started");
}

export function stopScheduler() {
  for (const t of timers.splice(0)) clearInterval(t);
}
