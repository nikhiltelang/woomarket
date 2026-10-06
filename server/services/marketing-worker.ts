import type { EmailCampaign, EmailRecipient, SmsCampaign, SmsGateway, SmsRecipient } from "@shared/schema";
import { renderMergeTags } from "@shared/sms";
import { config } from "../config";
import { childLogger } from "../lib/logger";
import { publicBaseUrl } from "../lib/tokens";
import { emailCampaignsRepository } from "../repositories/email.repository";
import { smsCampaignsRepository, smsGatewayRepository } from "../repositories/sms.repository";
import { classifySmtpError, resolveSmtp, sendEmail, type ResolvedSmtp } from "./email/mailer";
import { renderEmail } from "./email/render";
import { getSmsProvider, SmsProviderError } from "./sms/providers";
import { completeEmailCampaignIfDone, completeSmsCampaignIfDone } from "./marketing.service";

const log = childLogger("marketing-worker");
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls for pending email / SMS recipients of campaigns in `sending` state and delivers them. */
export class MarketingWorker {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;
  /** Transient-failure counts per recipient (in memory; resets on restart, which only means extra retries). */
  private attempts = new Map<string, number>();

  async start(intervalMs = Math.min(config.MESSAGE_QUEUE_INTERVAL_MS, 3000)) {
    if (this.timer) return;
    await Promise.all([emailCampaignsRepository.recoverProcessing(), smsCampaignsRepository.recoverProcessing()]).catch((err) =>
      log.warn({ err: (err as Error).message }, "Recovery of in-flight recipients failed"),
    );
    this.timer = setInterval(() => {
      if (!this.current) this.current = this.tick().finally(() => (this.current = null));
    }, intervalMs);
    log.info({ intervalMs }, "Marketing worker started");
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.current;
  }

  async tick(): Promise<{ email: number; sms: number }> {
    const [email, sms] = await Promise.all([this.emailBatch().catch(this.logError("email")), this.smsBatch().catch(this.logError("sms"))]);
    return { email: email ?? 0, sms: sms ?? 0 };
  }

  private logError(kind: string) {
    return (err: unknown) => {
      log.error({ kind, err: (err as Error).message }, "Batch failed");
      return 0;
    };
  }

  private retryOrFail(id: string): boolean {
    const n = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, n);
    if (n >= MAX_ATTEMPTS) this.attempts.delete(id);
    return n < MAX_ATTEMPTS;
  }

  // --- Email ----------------------------------------------------------------

  private async emailBatch(): Promise<number> {
    const rows = await emailCampaignsRepository.claim(config.MARKETING_BATCH_SIZE);
    if (!rows.length) return 0;
    const byCampaign = new Map<string, EmailRecipient[]>();
    for (const r of rows) byCampaign.set(r.campaignId, [...(byCampaign.get(r.campaignId) ?? []), r]);

    for (const [campaignId, recipients] of byCampaign) {
      const campaign = await emailCampaignsRepository.find(campaignId);
      if (!campaign || campaign.status !== "sending") {
        for (const r of recipients) await emailCampaignsRepository.updateRecipient(r.id, { status: campaign?.status === "cancelled" ? "cancelled" : "pending" });
        continue;
      }
      let smtp: ResolvedSmtp;
      try {
        smtp = await resolveSmtp(campaign.userId);
      } catch (err) {
        await this.haltEmail(campaign, recipients, (err as Error).message);
        continue;
      }
      for (let i = 0; i < recipients.length; i++) {
        const halted = await this.sendOneEmail(campaign, smtp, recipients[i]);
        if (halted) {
          await this.haltEmail(campaign, recipients.slice(i + 1), halted);
          break;
        }
        if (config.MARKETING_SEND_DELAY_MS) await sleep(config.MARKETING_SEND_DELAY_MS);
      }
      await completeEmailCampaignIfDone(campaignId);
    }
    return rows.length;
  }

  /** Returns an error message when the whole campaign must stop (SMTP connection/auth problem). */
  private async sendOneEmail(c: EmailCampaign, smtp: ResolvedSmtp, r: EmailRecipient): Promise<string | null> {
    const rendered = renderEmail(c, { id: r.id, name: r.name, email: r.email });
    try {
      await sendEmail(smtp, { to: r.email, toName: r.name, subject: rendered.subject, html: rendered.html, text: rendered.text, senderName: c.senderName, replyTo: c.replyTo, headers: rendered.headers }, c.userId);
      const now = new Date();
      await emailCampaignsRepository.updateRecipient(r.id, { status: "sent", sentAt: now, deliveredAt: now, errorMessage: null });
      await emailCampaignsRepository.increment(c.id, "sentCount");
      await emailCampaignsRepository.increment(c.id, "deliveredCount");
      this.attempts.delete(r.id);
      return null;
    } catch (err) {
      const kind = classifySmtpError(err);
      const message = (err as Error).message;
      if (kind === "config") {
        await emailCampaignsRepository.updateRecipient(r.id, { status: "pending" });
        return `SMTP error: ${message}`;
      }
      if (kind === "temporary" && this.retryOrFail(r.id)) {
        await emailCampaignsRepository.updateRecipient(r.id, { status: "pending", errorMessage: message });
        return null;
      }
      await emailCampaignsRepository.updateRecipient(r.id, { status: "failed", errorMessage: message });
      await emailCampaignsRepository.increment(c.id, "failedCount");
      return null;
    }
  }

  private async haltEmail(c: EmailCampaign, unsent: EmailRecipient[], reason: string) {
    for (const r of unsent) await emailCampaignsRepository.updateRecipient(r.id, { status: "pending" });
    await emailCampaignsRepository.transition(c.id, ["sending"], "failed", { errorMessage: reason });
    log.warn({ campaignId: c.id, reason }, "Email campaign halted; fix the SMTP settings and resume");
  }

  // --- SMS ------------------------------------------------------------------

  private async smsBatch(): Promise<number> {
    const rows = await smsCampaignsRepository.claim(config.MARKETING_BATCH_SIZE);
    if (!rows.length) return 0;
    const byCampaign = new Map<string, SmsRecipient[]>();
    for (const r of rows) byCampaign.set(r.campaignId, [...(byCampaign.get(r.campaignId) ?? []), r]);

    for (const [campaignId, recipients] of byCampaign) {
      const campaign = await smsCampaignsRepository.find(campaignId);
      if (!campaign || campaign.status !== "sending") {
        for (const r of recipients) await smsCampaignsRepository.updateRecipient(r.id, { status: campaign?.status === "cancelled" ? "cancelled" : "pending" });
        continue;
      }
      const gateway = await smsGatewayRepository.get(campaign.userId);
      for (let i = 0; i < recipients.length; i++) {
        const halted = await this.sendOneSms(campaign, gateway, recipients[i]);
        if (halted) {
          for (const r of recipients.slice(i + 1)) await smsCampaignsRepository.updateRecipient(r.id, { status: "pending" });
          await smsCampaignsRepository.transition(campaign.id, ["sending"], "failed", { errorMessage: halted });
          break;
        }
        if (config.MARKETING_SEND_DELAY_MS) await sleep(config.MARKETING_SEND_DELAY_MS);
      }
      await completeSmsCampaignIfDone(campaignId);
    }
    return rows.length;
  }

  private async sendOneSms(c: SmsCampaign, gateway: SmsGateway | undefined, r: SmsRecipient): Promise<string | null> {
    const body = renderMergeTags(c.message, { name: r.name, phone: r.phone });
    const callback = gateway && gateway.provider !== "simulator" ? `${publicBaseUrl()}/webhooks/sms/${gateway.provider}/${gateway.id}` : undefined;
    try {
      const { messageId } = await getSmsProvider(gateway).send(r.phone, body, { statusCallbackUrl: callback });
      await smsCampaignsRepository.updateRecipient(r.id, { status: "sent", sentAt: new Date(), messageId, errorMessage: null });
      await smsCampaignsRepository.increment(c.id, "sentCount");
      this.attempts.delete(r.id);
      return null;
    } catch (err) {
      const e = err as SmsProviderError;
      // Account-level rejections (bad credentials, unverified sender) stop the campaign.
      if (e instanceof SmsProviderError && e.permanent && ["20003", "401", "4", "2"].includes(String(e.code))) {
        await smsCampaignsRepository.updateRecipient(r.id, { status: "pending" });
        return `SMS gateway error: ${e.message}`;
      }
      if (!(e instanceof SmsProviderError && e.permanent) && this.retryOrFail(r.id)) {
        await smsCampaignsRepository.updateRecipient(r.id, { status: "pending", errorMessage: e.message });
        return null;
      }
      await smsCampaignsRepository.updateRecipient(r.id, { status: "failed", errorMessage: e.message });
      await smsCampaignsRepository.increment(c.id, "failedCount");
      return null;
    }
  }
}

export const marketingWorker = new MarketingWorker();
