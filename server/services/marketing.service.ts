import { and, eq, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { wakeWork } from "./queue/wake";
import { emit } from "./webhooks.service";
import { campaignCounts, emitForCampaign } from "./webhook-events";
import { contacts, type EmailCampaign, type SmsCampaign } from "@shared/schema";
import { calculateSegments, renderMergeTags } from "@shared/sms";
import { db } from "../db";
import { conflict, notFound, unprocessable } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { verifyToken } from "../lib/tokens";
import { emailCampaignsRepository, suppressionsRepository } from "../repositories/email.repository";
import { smsCampaignsRepository, smsGatewayRepository } from "../repositories/sms.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { resolveSmtp } from "./email/mailer";
import { getSmsProvider, setSmsStatusSink } from "./sms/providers";
import { prepareEmailLinks, prepareSmsLinks, smsWithShortLinkPlaceholders } from "./tracking.service";
import { scheduleRecipients } from "./delivery.service";
import { saveAbState, testingState } from "./ab-test.service";
import { segmentCondition } from "./segments.service";
import { splitAudience } from "@shared/ab-test";
import type { AbTestState } from "@shared/schema";

const log = childLogger("marketing");

type Audience = { userId: string; targetAudience: string | null; targetGroupId: string | null; targetSegmentId?: string | null; channelId: string | null };

async function audienceContacts(a: Audience, extra: SQL[]) {
  if (!a.channelId) return [];
  const conds: SQL[] = [eq(contacts.channelId, a.channelId), eq(contacts.status, "active"), ...extra];
  if (a.targetAudience === "group" && a.targetGroupId) conds.push(sql`JSON_CONTAINS(${contacts.groups}, JSON_QUOTE(${a.targetGroupId}))`);
  if (a.targetAudience === "segment") {
    if (!a.targetSegmentId) return [];
    conds.push(await segmentCondition(a.userId, a.targetSegmentId));
  }
  return db
    .select({ id: contacts.id, name: contacts.name, email: contacts.email, phone: contacts.phone, metadata: contacts.metadata })
    .from(contacts)
    .where(and(...conds));
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export async function resolveEmailAudience(c: EmailCampaign) {
  const rows =
    c.targetAudience === "csv"
      ? (c.csvData ?? []).map((r) => ({ contactId: r.contactId ?? null, email: r.email, name: r.name ?? null }))
      : (await audienceContacts(c, [isNotNull(contacts.email), ne(contacts.email, "")])).map((r) => ({ contactId: r.id, email: r.email!, name: r.name }));
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const key = r.email.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Hard bounces, spam complaints and manual entries are never emailed again.
  const suppressed = await suppressionsRepository.filter(c.userId, unique.map((r) => r.email));
  return suppressed.size ? unique.filter((r) => !suppressed.has(r.email.trim().toLowerCase())) : unique;
}

export async function startEmailCampaign(id: string): Promise<EmailCampaign> {
  const campaign = await emailCampaignsRepository.find(id);
  if (!campaign) throw notFound("Campaign");
  if (!["draft", "scheduled"].includes(campaign.status ?? "")) throw conflict(`Campaign is ${campaign.status}; only draft or scheduled campaigns can be sent`);
  await resolveSmtp(campaign.userId); // fail fast when no SMTP is configured
  const audience = await resolveEmailAudience(campaign);
  if (!audience.length) throw unprocessable("This audience has no active contacts with an email address", "EMPTY_AUDIENCE");

  const ab = campaign.abTest?.enabled ? (campaign.abTest as AbTestState & { testPercent: number; contentHtmlB?: string | null }) : null;
  if (campaign.trackClicks) await prepareEmailLinks(campaign, ab?.contentHtmlB ? [ab.contentHtmlB] : []);
  const ok = await emailCampaignsRepository.transition(id, ["draft", "scheduled"], "sending", { totalRecipients: audience.length, errorMessage: null });
  if (!ok) throw conflict("Campaign was started by someone else");
  const sendAfter = await scheduleRecipients(campaign.userId, "email", campaign.delivery, audience.map((r) => ({ contactId: r.contactId })));
  const variants = abAssignments(audience.length, ab);
  await emailCampaignsRepository.insertRecipients(
    audience.map((r, i) => ({ campaignId: id, contactId: r.contactId, email: r.email, name: r.name, status: variants[i] === "held" ? "held" : "pending", variant: variants[i] === "held" ? null : variants[i], sendAfter: sendAfter[i] })),
  );
  if (ab) await saveAbState("email", id, abStartState(ab, variants));
  log.info({ campaignId: id, recipients: audience.length, abTest: Boolean(ab) }, "Email campaign started");
  wakeWork("marketing");
  return (await emailCampaignsRepository.find(id))!;
}

export async function changeEmailCampaignStatus(c: EmailCampaign, to: "paused" | "sending" | "cancelled"): Promise<EmailCampaign> {
  let ok = false;
  if (to === "paused") ok = await emailCampaignsRepository.transition(c.id, ["sending"], "paused");
  else if (to === "sending") ok = await emailCampaignsRepository.transition(c.id, ["paused", "failed"], "sending", { errorMessage: null });
  else {
    ok = await emailCampaignsRepository.transition(c.id, ["draft", "scheduled", "sending", "paused", "failed"], "cancelled");
    if (ok) await emailCampaignsRepository.setPendingStatus(c.id, "cancelled");
  }
  if (!ok) throw conflict(`Cannot change a ${c.status} campaign to ${to}`);
  return (await emailCampaignsRepository.find(c.id))!;
}

export async function completeEmailCampaignIfDone(id: string): Promise<void> {
  if ((await emailCampaignsRepository.pendingCount(id)) > 0) return;
  // An automation step's campaign keeps sending for as long as the flow exists.
  if ((await emailCampaignsRepository.find(id))?.automationId) return;
  if (await emailCampaignsRepository.transition(id, ["sending"], "sent", { sentAt: new Date() })) {
    log.info({ campaignId: id }, "Email campaign sent");
    const c = await emailCampaignsRepository.find(id);
    if (c) emit(c.userId, "campaign.completed", { channel: "email", campaignId: id, name: c.name, ...campaignCounts(c), completedAt: new Date().toISOString() });
  }
}

/** Open-tracking pixel hit. Returns silently for invalid tokens. */
export async function recordEmailOpen(token: string): Promise<void> {
  const id = verifyToken("open", token);
  if (!id) return;
  const recipient = await emailCampaignsRepository.findRecipient(id);
  if (recipient && (await emailCampaignsRepository.markOpened(id))) {
    await emailCampaignsRepository.increment(recipient.campaignId, "openedCount");
    emitForCampaign("email", recipient.campaignId, "email.opened", { campaignId: recipient.campaignId, email: recipient.email, contactId: recipient.contactId, at: new Date().toISOString() });
  }
}

/** One-click unsubscribe: flags the contact so no future campaign reaches it. */
export async function unsubscribeEmail(token: string): Promise<{ email: string } | null> {
  const id = verifyToken("unsubscribe", token);
  if (!id) return null;
  const recipient = await emailCampaignsRepository.findRecipient(id);
  if (!recipient) return null;
  if (recipient.contactId) await contactsRepository.update(recipient.contactId, { status: "unsubscribed" });
  await emailCampaignsRepository.updateRecipient(id, { errorMessage: "unsubscribed" });
  log.info({ recipientId: id }, "Recipient unsubscribed");
  emitForCampaign("email", recipient.campaignId, "contact.unsubscribed", { channel: "email", email: recipient.email, contactId: recipient.contactId, campaignId: recipient.campaignId, at: new Date().toISOString() });
  return { email: recipient.email };
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

export async function resolveSmsAudience(c: SmsCampaign) {
  const rows =
    c.targetAudience === "csv"
      ? (c.csvData ?? []).map((r) => ({ contactId: r.contactId ?? null, phone: r.phone, name: r.name ?? null, email: null as string | null, fields: {} as Record<string, string> }))
      : (await audienceContacts(c, [])).map((r) => ({ contactId: r.id, phone: r.phone, name: r.name, email: r.email, fields: r.metadata ?? {} }));
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.phone) && seen.add(r.phone));
}

export async function startSmsCampaign(id: string): Promise<SmsCampaign> {
  const campaign = await smsCampaignsRepository.find(id);
  if (!campaign) throw notFound("Campaign");
  if (!["draft", "scheduled"].includes(campaign.status ?? "")) throw conflict(`Campaign is ${campaign.status}; only draft or scheduled campaigns can be sent`);
  const gateway = await smsGatewayRepository.get(campaign.userId);
  const provider = getSmsProvider(gateway);
  const audience = await resolveSmsAudience(campaign);
  if (!audience.length) throw unprocessable("This audience has no active contacts", "EMPTY_AUDIENCE");

  const ab = campaign.abTest?.enabled ? (campaign.abTest as AbTestState & { testPercent: number; messageB?: string }) : null;
  const variants = abAssignments(audience.length, ab);
  // With click tracking, links become short /s/<code> links: estimate with that length.
  const estimate = (m: string) => (campaign.trackClicks ? smsWithShortLinkPlaceholders(m) : m);
  const rows = audience.map((r, i) => ({ ...r, segments: calculateSegments(renderMergeTags(estimate(variants[i] === "B" && ab?.messageB ? ab.messageB : campaign.message), r)).segments }));
  if (campaign.trackClicks) await prepareSmsLinks(campaign, ab?.messageB ? [ab.messageB] : []);
  const credits = rows.reduce((n, r) => n + r.segments, 0);
  const ok = await smsCampaignsRepository.transition(id, ["draft", "scheduled"], "sending", {
    totalRecipients: rows.length,
    estimatedCredits: credits,
    gateway: provider.kind,
    fromNumber: gateway?.fromNumber ?? null,
    senderId: gateway?.senderId ?? campaign.senderId,
    errorMessage: null,
  });
  if (!ok) throw conflict("Campaign was started by someone else");
  const sendAfter = await scheduleRecipients(campaign.userId, "sms", campaign.delivery, rows.map((r) => ({ contactId: r.contactId, phone: r.phone })));
  await smsCampaignsRepository.insertRecipients(
    rows.map((r, i) => ({ campaignId: id, contactId: r.contactId, phone: r.phone, name: r.name, segments: r.segments, status: variants[i] === "held" ? "held" : "pending", variant: variants[i] === "held" ? null : variants[i], sendAfter: sendAfter[i] })),
  );
  if (ab) await saveAbState("sms", id, abStartState(ab, variants));
  log.info({ campaignId: id, recipients: rows.length, credits, provider: provider.kind }, "SMS campaign started");
  wakeWork("marketing");
  return (await smsCampaignsRepository.find(id))!;
}

export async function changeSmsCampaignStatus(c: SmsCampaign, to: "paused" | "sending" | "cancelled"): Promise<SmsCampaign> {
  let ok = false;
  if (to === "paused") ok = await smsCampaignsRepository.transition(c.id, ["sending"], "paused");
  else if (to === "sending") ok = await smsCampaignsRepository.transition(c.id, ["paused", "failed"], "sending", { errorMessage: null });
  else {
    ok = await smsCampaignsRepository.transition(c.id, ["draft", "scheduled", "sending", "paused", "failed"], "cancelled");
    if (ok) await smsCampaignsRepository.setPendingStatus(c.id, "cancelled");
  }
  if (!ok) throw conflict(`Cannot change a ${c.status} campaign to ${to}`);
  return (await smsCampaignsRepository.find(c.id))!;
}

export async function completeSmsCampaignIfDone(id: string): Promise<void> {
  if ((await smsCampaignsRepository.pendingCount(id)) > 0) return;
  if ((await smsCampaignsRepository.find(id))?.automationId) return;
  if (await smsCampaignsRepository.transition(id, ["sending"], "sent", { sentAt: new Date() })) {
    log.info({ campaignId: id }, "SMS campaign sent");
    const c = await smsCampaignsRepository.find(id);
    if (c) emit(c.userId, "campaign.completed", { channel: "sms", campaignId: id, name: c.name, ...campaignCounts(c), completedAt: new Date().toISOString() });
  }
}

/** Delivery receipt from a provider (or the simulator). Idempotent. */
export async function handleSmsStatus(messageId: string, status: "delivered" | "failed", error?: string): Promise<void> {
  const r = await smsCampaignsRepository.findRecipientByMessageId(messageId);
  if (!r || r.status === status || r.status === "delivered") return;
  if (status === "delivered") {
    await smsCampaignsRepository.updateRecipient(r.id, { status: "delivered", deliveredAt: new Date() });
    await smsCampaignsRepository.increment(r.campaignId, "deliveredCount");
    emitForCampaign("sms", r.campaignId, "sms.delivered", { campaignId: r.campaignId, phone: r.phone, contactId: r.contactId, at: new Date().toISOString() });
  } else {
    await smsCampaignsRepository.updateRecipient(r.id, { status: "failed", errorMessage: error ?? "Delivery failed" });
    await smsCampaignsRepository.increment(r.campaignId, "failedCount");
  }
}

setSmsStatusSink(handleSmsStatus);

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export async function startDueMarketingCampaigns(now = new Date()): Promise<void> {
  for (const c of await emailCampaignsRepository.dueScheduled(now)) {
    await startEmailCampaign(c.id).catch(async (err) => {
      log.error({ campaignId: c.id, err: (err as Error).message }, "Scheduled email campaign failed to start");
      await emailCampaignsRepository.transition(c.id, ["scheduled"], "failed", { errorMessage: (err as Error).message });
    });
  }
  for (const c of await smsCampaignsRepository.dueScheduled(now)) {
    await startSmsCampaign(c.id).catch(async (err) => {
      log.error({ campaignId: c.id, err: (err as Error).message }, "Scheduled SMS campaign failed to start");
      await smsCampaignsRepository.transition(c.id, ["scheduled"], "failed", { errorMessage: (err as Error).message });
    });
  }
}

// ---------------------------------------------------------------------------
// A/B test helpers (shared by the three channels)
// ---------------------------------------------------------------------------

export type Assignment = "A" | "B" | "held" | null;

/** Variant per audience position: null without a test, otherwise A / B / held. */
export function abAssignments(count: number, ab: { testPercent: number } | null): Assignment[] {
  if (!ab) return Array(count).fill(null);
  const { A, B, held } = splitAudience(Array.from({ length: count }, (_, i) => i), ab.testPercent);
  const out: Assignment[] = Array(count).fill("A");
  for (const i of A) out[i] = "A";
  for (const i of B) out[i] = "B";
  for (const i of held) out[i] = "held";
  return out;
}

/** Stored test state after splitting: testing, or skipped when the audience was too small. */
export function abStartState(ab: AbTestState, variants: Assignment[]): AbTestState {
  if (!variants.includes("B")) return { ...ab, phase: "skipped" };
  return testingState(ab, variants.filter((v) => v === "held").length);
}
