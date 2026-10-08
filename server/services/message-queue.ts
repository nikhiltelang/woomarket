import { randomUUID } from "node:crypto";
import { campaignCounts, emitForChannel } from "./webhook-events";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { messageQueue, type Campaign, type Channel, type QueuedMessage, type Template } from "@shared/schema";
import { db } from "../db";
import { config } from "../config";
import { childLogger } from "../lib/logger";
import { channelsRepository } from "../repositories/channels.repository";
import { campaignsRepository } from "../repositories/campaigns.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { renderTemplateBody, templatesRepository } from "../repositories/templates.repository";
import { realtime } from "./realtime";
import { whatsappFactory, WhatsAppApiError } from "./whatsapp";
import { findOrCreateConversation } from "./messaging.service";
import { COEXISTENCE_MPS } from "@shared/whatsapp-signup";

const log = childLogger("message-queue");
const STUCK_AFTER_MS = 5 * 60 * 1000;

export const queueRepository = {
  async enqueue(rows: Omit<typeof messageQueue.$inferInsert, "id">[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(messageQueue).values(rows.slice(i, i + 500).map((r) => ({ ...r, id: randomUUID() })));
    }
  },

  async setStatusForCampaign(campaignId: string, from: string[], to: string): Promise<number> {
    const [res] = await db
      .update(messageQueue)
      .set({ status: to })
      .where(and(eq(messageQueue.campaignId, campaignId), inArray(messageQueue.status, from)));
    return res.affectedRows;
  },

  async pendingForCampaign(campaignId: string): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(messageQueue)
      .where(and(eq(messageQueue.campaignId, campaignId), inArray(messageQueue.status, ["queued", "processing", "paused"])));
    return Number(row.n);
  },

  /** Atomically claims due rows (SKIP LOCKED makes this safe across instances). */
  async claim(limit: number): Promise<QueuedMessage[]> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(messageQueue)
        .where(
          and(
            eq(messageQueue.status, "queued"),
            or(isNull(messageQueue.scheduledFor), lte(messageQueue.scheduledFor, sql`CURRENT_TIMESTAMP(3)`)),
          ),
        )
        .orderBy(messageQueue.createdAt)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length) {
        await tx
          .update(messageQueue)
          .set({ status: "processing", processedAt: sql`CURRENT_TIMESTAMP(3)` })
          .where(inArray(messageQueue.id, rows.map((r) => r.id)));
      }
      return rows;
    });
  },

  async recoverStuck(): Promise<number> {
    const [res] = await db
      .update(messageQueue)
      .set({ status: "queued" })
      .where(and(eq(messageQueue.status, "processing"), lt(messageQueue.processedAt, new Date(Date.now() - STUCK_AFTER_MS))));
    return res.affectedRows;
  },

  async update(id: string, patch: Partial<typeof messageQueue.$inferInsert>): Promise<void> {
    await db.update(messageQueue).set(patch).where(eq(messageQueue.id, id));
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends per second a number may make: Coexistence numbers are capped by Meta. */
export const channelRate = (channel: Pick<Channel, "isCoexistence">) => (channel.isCoexistence ? Math.min(COEXISTENCE_MPS, config.MESSAGE_RATE_PER_SECOND) : config.MESSAGE_RATE_PER_SECOND);

/** Single-server limiter (database mode): only Coexistence numbers need one below the batch pace. */
const windows = new Map<string, { second: number; n: number }>();
export async function localThrottle(channel: Channel): Promise<void> {
  if (!channel.isCoexistence) return;
  for (;;) {
    const second = Math.floor(Date.now() / 1000);
    const w = windows.get(channel.id);
    if (!w || w.second !== second) {
      windows.set(channel.id, { second, n: 1 });
      return;
    }
    if (w.n < channelRate(channel)) {
      w.n++;
      return;
    }
    await sleep(1000 - (Date.now() % 1000) + 5);
  }
}
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 15 * 60_000);

/** Finishes a running campaign once nothing is left in the queue for it. */
export async function completeCampaignIfDone(campaignId: string): Promise<void> {
  if ((await queueRepository.pendingForCampaign(campaignId)) > 0) return;
  // Held recipients still wait for the A/B winner.
  const running = await campaignsRepository.findById(campaignId);
  if ((running?.abTest as { phase?: string } | null)?.phase === "testing") return;
  // An automation step's campaign keeps sending for as long as the flow exists.
  if (running?.automationId) return;
  if (await campaignsRepository.transition(campaignId, ["running"], "completed", { completedAt: new Date() })) {
    const campaign = await campaignsRepository.findById(campaignId);
    realtime.toChannel(campaign?.channelId, "campaign_updated", { campaign });
    log.info({ campaignId }, "Campaign completed");
    if (campaign) emitForChannel(campaign.channelId, "campaign.completed", { channel: "whatsapp", campaignId, name: campaign.name, ...campaignCounts(campaign), completedAt: new Date().toISOString() });
  }
}

/** Database-polling worker that sends queued campaign messages at a controlled rate. */
export class MessageQueueWorker {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;
  /** Waits for a send slot on a channel; set to a cluster-wide limiter in Redis mode. */
  throttle: (channel: Channel) => Promise<void> = localThrottle;

  start(): void {
    if (this.timer) return;
    void queueRepository.recoverStuck().then((n) => n && log.warn({ n }, "Re-queued stuck messages"));
    this.timer = setInterval(() => {
      if (!this.current) this.current = this.tick().finally(() => (this.current = null));
    }, config.MESSAGE_QUEUE_INTERVAL_MS);
    log.info({ intervalMs: config.MESSAGE_QUEUE_INTERVAL_MS }, "Message queue worker started");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.current;
  }

  /** Processes one batch. Exposed for tests and manual runs. */
  async tick(): Promise<number> {
    let rows: QueuedMessage[];
    try {
      rows = await queueRepository.claim(config.MESSAGE_QUEUE_BATCH_SIZE);
    } catch (err) {
      log.error({ err: (err as Error).message }, "Failed to claim queue batch");
      return 0;
    }
    if (!rows.length) return 0;

    const channels = new Map<string, Channel | undefined>();
    const campaigns = new Map<string, Campaign | undefined>();
    const templates = new Map<string, Template | undefined>();
    const ctx = {
      channel: async (id: string) => {
        if (!channels.has(id)) channels.set(id, await channelsRepository.findById(id));
        return channels.get(id);
      },
      campaign: async (id: string) => {
        if (!campaigns.has(id)) campaigns.set(id, await campaignsRepository.findById(id));
        return campaigns.get(id);
      },
      template: async (id: string) => {
        if (!templates.has(id)) templates.set(id, await templatesRepository.findById(id));
        return templates.get(id);
      },
    };

    const concurrency = config.MESSAGE_QUEUE_CONCURRENCY;
    for (let i = 0; i < rows.length; i += concurrency) {
      await Promise.all(rows.slice(i, i + concurrency).map((row) => this.processOne(row, ctx)));
      if (config.MESSAGE_SEND_DELAY_MS) await sleep(config.MESSAGE_SEND_DELAY_MS);
    }

    for (const campaignId of new Set(rows.map((r) => r.campaignId).filter(Boolean) as string[])) {
      await completeCampaignIfDone(campaignId);
      const campaign = await campaignsRepository.findById(campaignId);
      realtime.toChannel(campaign?.channelId, "campaign_updated", { campaign });
    }
    return rows.length;
  }

  private async processOne(
    row: QueuedMessage,
    ctx: {
      channel: (id: string) => Promise<Channel | undefined>;
      campaign: (id: string) => Promise<Campaign | undefined>;
      template: (id: string) => Promise<Template | undefined>;
    },
  ): Promise<void> {
    const campaign = row.campaignId ? await ctx.campaign(row.campaignId) : undefined;
    if (campaign && campaign.status !== "running") {
      await queueRepository.update(row.id, { status: campaign.status === "paused" ? "paused" : "cancelled" });
      return;
    }
    const channel = row.channelId ? await ctx.channel(row.channelId) : undefined;
    if (!channel || channel.isActive === false) {
      await this.fail(row, "channel_inactive", "Channel is missing or inactive", true);
      return;
    }

    const attempt = (row.attempts ?? 0) + 1;
    try {
      await this.throttle(channel);
      const { messageId } = await whatsappFactory.create(channel).sendTemplate(row.recipientPhone, {
        name: row.templateName ?? "",
        language: row.templateLanguage ?? "en_US",
        params: row.templateParams ?? [],
      });
      await queueRepository.update(row.id, {
        status: "sent",
        attempts: attempt,
        whatsappMessageId: messageId,
        sentVia: whatsappFactory.create(channel).kind,
        errorCode: null,
        errorMessage: null,
      });
      if (campaign) await this.recordCampaignSend(row, campaign, channel, messageId, ctx);
    } catch (err) {
      const apiErr = err instanceof WhatsAppApiError ? err : null;
      const message = (err as Error).message;
      const permanent = apiErr ? !apiErr.retryable : false;
      if (!permanent && attempt < config.MESSAGE_QUEUE_MAX_ATTEMPTS) {
        await queueRepository.update(row.id, {
          status: "queued",
          attempts: attempt,
          errorCode: String(apiErr?.code ?? "error"),
          errorMessage: message,
          scheduledFor: new Date(Date.now() + backoffMs(attempt)),
        });
        if (campaign) await campaignsRepository.updateRecipientByPhone(campaign.id, row.recipientPhone, { retryCount: attempt });
        log.warn({ id: row.id, attempt, err: message }, "Send failed; will retry");
      } else {
        await queueRepository.update(row.id, { attempts: attempt });
        await this.fail(row, String(apiErr?.code ?? "error"), message, Boolean(campaign));
      }
    }
  }

  private async fail(row: QueuedMessage, code: string, message: string, countForCampaign: boolean) {
    await queueRepository.update(row.id, { status: "failed", errorCode: code, errorMessage: message });
    if (row.campaignId && countForCampaign) {
      await campaignsRepository.updateRecipientByPhone(row.campaignId, row.recipientPhone, {
        status: "failed",
        errorCode: code,
        errorMessage: message,
      });
      await campaignsRepository.increment(row.campaignId, "failedCount");
    }
  }

  private async recordCampaignSend(
    row: QueuedMessage,
    campaign: Campaign,
    channel: Channel,
    messageId: string,
    ctx: { template: (id: string) => Promise<Template | undefined> },
  ) {
    const now = new Date();
    await campaignsRepository.updateRecipientByPhone(campaign.id, row.recipientPhone, {
      status: "sent",
      whatsappMessageId: messageId,
      sentAt: now,
    });
    await campaignsRepository.increment(campaign.id, "sentCount");

    // Mirror the send into the inbox so agents see campaign messages in context.
    const contact = await contactsRepository.findByPhone(channel.id, row.recipientPhone);
    if (!contact) return;
    const template = campaign.templateId ? await ctx.template(campaign.templateId) : undefined;
    const content = template ? renderTemplateBody(template.body, row.templateParams ?? []) : `[template ${row.templateName}]`;
    const { conversation } = await findOrCreateConversation(channel, contact);
    const message = await messagesRepository.create({
      conversationId: conversation.id,
      whatsappMessageId: messageId,
      direction: "outbound",
      content,
      type: "template",
      fromType: "campaign",
      messageType: "template",
      status: "sent",
      timestamp: now,
      campaignId: campaign.id,
      metadata: { campaignName: campaign.name },
    });
    await conversationsRepository.recordMessage(conversation.id, { text: content, at: now, inbound: false });
    realtime.toChannel(channel.id, "new_message", { conversationId: conversation.id, message });
  }
}

export const messageQueueWorker = new MessageQueueWorker();
