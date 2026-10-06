import { childLogger } from "../lib/logger";
import { startDueCampaigns } from "../services/campaign.service";
import { startDueMarketingCampaigns } from "../services/marketing.service";
import { channelsRepository } from "../repositories/channels.repository";
import { whatsappFactory } from "../services/whatsapp";

const log = childLogger("cron");

interface Job {
  key: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

const jobs: Job[] = [
  { key: "scheduled-campaigns", intervalMs: 60_000, run: () => startDueCampaigns() },
  { key: "scheduled-email-sms-campaigns", intervalMs: 60_000, run: () => startDueMarketingCampaigns() },
  {
    key: "channel-health-monitor",
    intervalMs: 6 * 60 * 60 * 1000,
    run: async () => {
      for (const channel of await channelsRepository.listActive()) {
        const health = await whatsappFactory.create(channel).checkHealth();
        await channelsRepository.recordHealth(channel.id, health.status, health.details);
      }
    },
  },
];

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

async function execute(job: Job) {
  if (running.has(job.key)) return; // never overlap runs of the same job
  running.add(job.key);
  const started = Date.now();
  try {
    await job.run();
    log.debug({ job: job.key, ms: Date.now() - started }, "Job finished");
  } catch (err) {
    log.error({ job: job.key, err: (err as Error).message }, "Job failed");
  } finally {
    running.delete(job.key);
  }
}

export function startScheduler() {
  for (const job of jobs) {
    timers.push(setInterval(() => void execute(job), job.intervalMs));
    setTimeout(() => void execute(job), 5_000).unref();
  }
  log.info({ jobs: jobs.map((j) => j.key) }, "Scheduler started");
}

export function stopScheduler() {
  for (const t of timers.splice(0)) clearInterval(t);
}
