/**
 * Amazon SES feedback through Amazon SNS: bounce, complaint and delivery notifications.
 * Every SNS message is signature-checked against Amazon's signing certificate before use.
 */
import { emit } from "../webhooks.service";
import crypto from "node:crypto";
import { childLogger } from "../../lib/logger";
import { contactsRepository } from "../../repositories/contacts.repository";
import { emailCampaignsRepository, smtpRepository, suppressionsRepository } from "../../repositories/email.repository";

const log = childLogger("ses-feedback");

export interface SnsMessage {
  Type: "SubscriptionConfirmation" | "Notification" | "UnsubscribeConfirmation" | string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

/** SNS certificates and confirmation links only ever come from sns.<region>.amazonaws.com. */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
export const isSnsUrl = (u: string | undefined, pathPattern?: RegExp) => {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && SNS_HOST.test(url.hostname) && (!pathPattern || pathPattern.test(url.pathname));
  } catch {
    return false;
  }
};

/** The canonical string SNS signs (field order is fixed by AWS). */
export function snsStringToSign(m: SnsMessage): string {
  const fields =
    m.Type === "Notification"
      ? ["Message", "MessageId", ...(m.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return fields.map((f) => `${f}\n${(m as unknown as Record<string, string>)[f]}\n`).join("");
}

const certCache = new Map<string, { pem: string; at: number }>();
let fetchCert = async (url: string): Promise<string> => {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Certificate download failed (${res.status})`);
  return res.text();
};
/** Test seam: replace the certificate download. */
export const __setCertFetcher = (fn: typeof fetchCert) => (fetchCert = fn);

export async function verifySnsSignature(m: SnsMessage): Promise<boolean> {
  if (!isSnsUrl(m.SigningCertURL, /\.pem$/)) return false;
  if (!["1", "2"].includes(m.SignatureVersion) || !m.Signature) return false;
  let cached = certCache.get(m.SigningCertURL);
  if (!cached || Date.now() - cached.at > 24 * 3600_000) {
    try {
      cached = { pem: await fetchCert(m.SigningCertURL), at: Date.now() };
    } catch (err) {
      log.warn({ url: m.SigningCertURL, err: (err as Error).message }, "Couldn't fetch the SNS signing certificate");
      return false; // unverifiable is treated as invalid
    }
    certCache.set(m.SigningCertURL, cached);
  }
  const verifier = crypto.createVerify(m.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
  verifier.update(snsStringToSign(m), "utf8");
  try {
    return verifier.verify(cached.pem, m.Signature, "base64");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SES event handling
// ---------------------------------------------------------------------------

interface SesEvent {
  notificationType?: string; // identity notifications
  eventType?: string; // configuration-set event publishing
  mail?: { messageId?: string; tags?: Record<string, string[]> };
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress: string }[]; complaintFeedbackType?: string };
  delivery?: { timestamp?: string };
}

/** Finds the campaign recipient a notification is about (by SES MessageId, then by our tag). */
async function recipientFor(e: SesEvent) {
  const byId = e.mail?.messageId ? await emailCampaignsRepository.findRecipientByMessageId(e.mail.messageId) : undefined;
  if (byId) return byId;
  const tagged = e.mail?.tags?.wm_recipient?.[0];
  return tagged ? emailCampaignsRepository.findRecipient(tagged) : undefined;
}

export async function handleSesEvent(e: SesEvent, configOwner: string | null): Promise<string> {
  const type = (e.eventType ?? e.notificationType ?? "").toLowerCase();
  const r = await recipientFor(e);
  const campaign = r ? await emailCampaignsRepository.find(r.campaignId) : undefined;
  // Suppress for the tenant that sent the campaign; system emails fall back to the config's owner.
  const owner = campaign?.userId ?? configOwner;

  if (type === "bounce") {
    if (e.bounce?.bounceType !== "Permanent") return "transient bounce ignored";
    for (const b of e.bounce.bouncedRecipients ?? []) await suppressionsRepository.add(owner, b.emailAddress, "bounce", b.diagnosticCode ?? e.bounce.bounceSubType);
    if (r && r.status !== "bounced") {
      const wasDelivered = r.status === "sent" && r.deliveredAt;
      await emailCampaignsRepository.updateRecipient(r.id, { status: "bounced", deliveredAt: null, errorMessage: `Bounced: ${e.bounce.bouncedRecipients?.[0]?.diagnosticCode ?? e.bounce.bounceSubType ?? "permanent"}`.slice(0, 1000) });
      if (wasDelivered) await emailCampaignsRepository.increment(r.campaignId, "deliveredCount", -1);
      await emailCampaignsRepository.increment(r.campaignId, "failedCount");
      emit(owner, "email.bounced", { campaignId: r.campaignId, email: r.email, contactId: r.contactId, reason: e.bounce.bouncedRecipients?.[0]?.diagnosticCode ?? e.bounce.bounceSubType ?? "permanent", permanent: true, at: new Date().toISOString() });
    }
    return "bounce recorded";
  }
  if (type === "complaint") {
    for (const c of e.complaint?.complainedRecipients ?? []) await suppressionsRepository.add(owner, c.emailAddress, "complaint", e.complaint?.complaintFeedbackType);
    if (r) {
      await emailCampaignsRepository.updateRecipient(r.id, { errorMessage: "complaint" });
      if (r.contactId) await contactsRepository.update(r.contactId, { status: "unsubscribed" });
    }
    return "complaint recorded";
  }
  if (type === "delivery") {
    if (r && r.status === "sent") await emailCampaignsRepository.updateRecipient(r.id, { deliveredAt: e.delivery?.timestamp ? new Date(e.delivery.timestamp) : new Date() });
    return "delivery recorded";
  }
  return `ignored ${type || "unknown"} event`;
}

/**
 * Handles one SNS POST for an SES configuration. Subscriptions are confirmed automatically;
 * the first confirmed topic is pinned and others are refused afterwards.
 */
export async function handleSnsMessage(configId: string, m: SnsMessage): Promise<{ status: number; result: string }> {
  const cfg = await smtpRepository.findById(configId);
  if (!cfg || cfg.provider !== "ses") return { status: 404, result: "unknown configuration" };
  if (!(await verifySnsSignature(m))) {
    log.warn({ configId, topic: m.TopicArn }, "Rejected SNS message with an invalid signature");
    return { status: 403, result: "invalid signature" };
  }
  if (cfg.snsTopicArn && cfg.snsTopicArn !== m.TopicArn) return { status: 403, result: "unexpected topic" };

  if (m.Type === "SubscriptionConfirmation") {
    if (!isSnsUrl(m.SubscribeURL)) return { status: 400, result: "bad subscribe url" };
    const res = await fetch(m.SubscribeURL!, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { status: 502, result: `confirmation failed (${res.status})` };
    await smtpRepository.setTopic(cfg.id, m.TopicArn);
    log.info({ configId, topic: m.TopicArn }, "SNS subscription confirmed for SES feedback");
    return { status: 200, result: "subscription confirmed" };
  }
  if (m.Type === "Notification") {
    let event: SesEvent;
    try {
      event = JSON.parse(m.Message);
    } catch {
      return { status: 400, result: "message is not JSON" };
    }
    if (!cfg.snsTopicArn) await smtpRepository.setTopic(cfg.id, m.TopicArn); // raw delivery set up before confirmation tracking
    return { status: 200, result: await handleSesEvent(event, cfg.userId) };
  }
  return { status: 200, result: "ignored" };
}
