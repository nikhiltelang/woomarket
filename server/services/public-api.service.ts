import { and, eq, inArray, ne } from "drizzle-orm";
import type { ApiSendInput } from "@shared/public-api";
import { calculateSegments } from "@shared/sms";
import { contacts, emailCampaignRecipients, emailCampaigns, type ApiKey, type Channel, type User } from "@shared/schema";
import { config } from "../config";
import { db } from "../db";
import { AppError, badRequest, forbidden, unprocessable } from "../lib/errors";
import { assertWithinPlan } from "../middlewares/subscription";
import { campaignsRepository } from "../repositories/campaigns.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { emailCampaignsRepository } from "../repositories/email.repository";
import { smsCampaignsRepository, smsGatewayRepository } from "../repositories/sms.repository";
import { templatesRepository } from "../repositories/templates.repository";
import { resolveSmtp } from "./email/mailer";
import { textToHtml } from "./email/system-mail";
import { assertMessageQuota, tenantLevel } from "./levels.service";
import { startCampaign } from "./campaign.service";
import { startEmailCampaign, startSmsCampaign } from "./marketing.service";
import { systemConfig } from "./system-config.service";

export interface Rejected {
  recipient: string;
  reason: string;
}
export interface SendResult {
  id: string;
  channel: ApiSendInput["channel"];
  name: string;
  status: string;
  scheduledAt: string | null;
  /** True when no real provider is configured, so nothing actually leaves the platform. */
  testMode: boolean;
  recipients: { requested: number; accepted: number; rejected: Rejected[] };
}

/** API access is a level feature; keys also carry their own channel allow-list. */
export async function assertApiAllowed(key: ApiKey, channel: ApiSendInput["channel"]) {
  const level = await tenantLevel(key.userId);
  if (level && !level.apiAccess) throw forbidden(`API access isn't included in your account level (${level.name}).`, "API_NOT_INCLUDED");
  if (!key.channels.includes(channel)) throw forbidden(`This access key isn't allowed to send ${channel}.`, "CHANNEL_NOT_ALLOWED");
}

const defaultName = (channel: string) => `API · ${channel} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Splits off duplicates (kept once) so each address is sent to once per request. */
function dedupe<T>(list: T[], keyOf: (r: T) => string, rejected: Rejected[]): T[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = keyOf(r);
    if (seen.has(k)) {
      rejected.push({ recipient: k, reason: "duplicate" });
      return false;
    }
    seen.add(k);
    return true;
  });
}

async function tenantChannelIds(tenantId: string) {
  return (await channelsRepository.listByTenant(tenantId)).map((c) => c.id);
}

/** Addresses that opted out: unsubscribed contacts, or recipients who clicked unsubscribe. */
async function suppressedEmails(tenantId: string, emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const channelIds = await tenantChannelIds(tenantId);
  const [fromContacts, fromLinks] = await Promise.all([
    channelIds.length
      ? db.select({ v: contacts.email }).from(contacts).where(and(inArray(contacts.channelId, channelIds), inArray(contacts.email, emails), ne(contacts.status, "active")))
      : [],
    db
      .select({ v: emailCampaignRecipients.email })
      .from(emailCampaignRecipients)
      .innerJoin(emailCampaigns, eq(emailCampaigns.id, emailCampaignRecipients.campaignId))
      .where(and(eq(emailCampaigns.userId, tenantId), inArray(emailCampaignRecipients.email, emails), eq(emailCampaignRecipients.errorMessage, "unsubscribed"))),
  ]);
  return new Set([...fromContacts, ...fromLinks].map((r) => (r.v ?? "").toLowerCase()));
}

async function suppressedPhones(tenantId: string, phones: string[]): Promise<Set<string>> {
  const channelIds = await tenantChannelIds(tenantId);
  if (!phones.length || !channelIds.length) return new Set();
  const variants = phones.flatMap((p) => [p, p.replace(/^\+/, "")]);
  const rows = await db
    .select({ v: contacts.phone })
    .from(contacts)
    .where(and(inArray(contacts.channelId, channelIds), inArray(contacts.phone, variants), ne(contacts.status, "active")));
  return new Set(rows.map((r) => (r.v.startsWith("+") ? r.v : `+${r.v}`)));
}

function result(id: string, input: ApiSendInput, name: string, status: string, testMode: boolean, requested: number, accepted: number, rejected: Rejected[]): SendResult {
  return { id, channel: input.channel, name, status, scheduledAt: input.scheduleAt?.toISOString() ?? null, testMode, recipients: { requested, accepted, rejected } };
}

function noneLeft(rejected: Rejected[]): never {
  throw new AppError(422, "None of the recipients can be sent to.", "NO_VALID_RECIPIENTS", { rejected });
}

// ---------------------------------------------------------------------------

async function sendEmail(key: ApiKey, input: Extract<ApiSendInput, { channel: "email" }>): Promise<SendResult> {
  const tenantId = key.userId;
  const rejected: Rejected[] = [];
  let list = dedupe(input.recipients, (r) => r.email, rejected);
  const blocked = await suppressedEmails(tenantId, list.map((r) => r.email));
  list = list.filter((r) => (blocked.has(r.email) ? (rejected.push({ recipient: r.email, reason: "unsubscribed" }), false) : true));
  if (!list.length) noneLeft(rejected);

  await assertWithinPlan(tenantId, "email");
  await assertMessageQuota(tenantId, list.length);
  const smtp = await resolveSmtp(tenantId); // 422 SMTP_NOT_CONFIGURED when nothing is set up
  const name = input.name ?? defaultName("email");
  const senderName = input.senderName ?? smtp.fromName ?? (await systemConfig.get()).siteTitle ?? "WooMarket360";
  const campaign = await emailCampaignsRepository.create({
    userId: tenantId,
    channelId: null,
    name,
    subject: input.subject,
    previewText: input.previewText ?? null,
    senderName,
    senderEmail: smtp.fromEmail ?? null,
    replyTo: input.replyTo ?? null,
    contentHtml: input.html ?? textToHtml(input.text!),
    contentText: input.text ?? null,
    templateId: null,
    targetAudience: "csv",
    targetGroupId: null,
    targetGroupName: null,
    csvData: list.map((r) => ({ email: r.email, ...(r.name ? { name: r.name } : {}) })),
    scheduledAt: input.scheduleAt ?? null,
    status: input.scheduleAt ? "scheduled" : "draft",
  });
  const started = input.scheduleAt ? campaign : await startEmailCampaign(campaign.id);
  return result(campaign.id, input, name, started.status ?? "sending", smtp.source === "simulator", input.recipients.length, list.length, rejected);
}

async function sendSms(key: ApiKey, input: Extract<ApiSendInput, { channel: "sms" }>): Promise<SendResult> {
  const tenantId = key.userId;
  const rejected: Rejected[] = [];
  let list = dedupe(input.recipients, (r) => r.phone, rejected);
  const blocked = await suppressedPhones(tenantId, list.map((r) => r.phone));
  list = list.filter((r) => (blocked.has(r.phone) ? (rejected.push({ recipient: r.phone, reason: "unsubscribed" }), false) : true));
  if (!list.length) noneLeft(rejected);

  await assertWithinPlan(tenantId, "sms");
  await assertMessageQuota(tenantId, list.length);
  const gateway = await smsGatewayRepository.get(tenantId);
  const name = input.name ?? defaultName("sms");
  const campaign = await smsCampaignsRepository.create({
    userId: tenantId,
    channelId: null,
    name,
    message: input.message,
    targetAudience: "csv",
    targetGroupId: null,
    targetGroupName: null,
    csvData: list.map((r) => ({ phone: r.phone, ...(r.name ? { name: r.name } : {}) })),
    scheduledAt: input.scheduleAt ?? null,
    status: input.scheduleAt ? "scheduled" : "draft",
    smsSegmentsPerRecipient: calculateSegments(input.message).segments,
    gateway: gateway?.provider ?? "simulator",
    senderId: gateway?.senderId ?? "CORTESYS",
    fromNumber: gateway?.fromNumber ?? null,
  });
  const started = input.scheduleAt ? campaign : await startSmsCampaign(campaign.id);
  const testMode = !gateway || !gateway.isActive || gateway.provider === "simulator";
  return result(campaign.id, input, name, started.status ?? "sending", testMode, input.recipients.length, list.length, rejected);
}

/** The sending number: explicit `from` (id or phone), the key's default, or the account's only number. */
async function pickChannel(key: ApiKey, from: string | undefined): Promise<Channel> {
  const list = (await channelsRepository.listByTenant(key.userId)).filter((c) => c.isActive !== false);
  if (from) {
    const digits = from.replace(/\D/g, "");
    const match = list.find((c) => c.id === from || (digits.length > 5 && (c.phoneNumber ?? "").replace(/\D/g, "") === digits));
    if (!match) throw unprocessable(`No connected WhatsApp number matches "from": ${from}.`, "UNKNOWN_SENDER");
    return match;
  }
  const preferred = key.defaultChannelId ? list.find((c) => c.id === key.defaultChannelId) : undefined;
  if (preferred) return preferred;
  if (list.length === 1) return list[0];
  if (!list.length) throw unprocessable("Connect a WhatsApp number before sending WhatsApp messages.", "NO_WHATSAPP_NUMBER");
  throw badRequest('This account has several WhatsApp numbers. Say which one with "from" (number id or phone number).');
}

async function sendWhatsapp(key: ApiKey, input: Extract<ApiSendInput, { channel: "whatsapp" }>, tenant: User): Promise<SendResult> {
  const tenantId = key.userId;
  const channel = await pickChannel(key, input.from);
  const templates = (await templatesRepository.listByChannel(channel.id)).filter((t) => t.name === input.template.name);
  const template =
    templates.find((t) => t.status === "approved" && (!input.template.language || t.language === input.template.language)) ??
    (input.template.language ? undefined : templates.find((t) => t.status === "approved"));
  if (!template) {
    const why = templates.length ? "isn't approved" + (input.template.language ? ` in ${input.template.language}` : "") : "doesn't exist on this number";
    throw unprocessable(`Template "${input.template.name}" ${why}.`, "TEMPLATE_NOT_AVAILABLE");
  }
  const vars = template.bodyVariables ?? 0;

  const rejected: Rejected[] = [];
  let list = dedupe(input.recipients, (r) => r.phone, rejected);
  list = list.filter((r) => {
    if ((r.variables?.length ?? 0) >= vars) return true;
    rejected.push({ recipient: r.phone, reason: `template needs ${vars} variable${vars === 1 ? "" : "s"}` });
    return false;
  });
  const blocked = await suppressedPhones(tenantId, list.map((r) => r.phone));
  list = list.filter((r) => (blocked.has(r.phone) ? (rejected.push({ recipient: r.phone, reason: "unsubscribed" }), false) : true));
  if (!list.length) noneLeft(rejected);

  await assertWithinPlan(tenantId, "campaign");
  // Recipients become contacts on the sending number (WhatsApp campaigns send to contacts).
  const phones = list.map((r) => r.phone);
  const existing = await db.select({ id: contacts.id, phone: contacts.phone }).from(contacts).where(and(eq(contacts.channelId, channel.id), inArray(contacts.phone, phones)));
  const known = new Set(existing.map((c) => c.phone));
  const fresh = list.filter((r) => !known.has(r.phone));
  if (fresh.length) {
    await assertWithinPlan(tenantId, "contacts", fresh.length);
    await contactsRepository.insertManyIgnoreDuplicates(
      fresh.map((r) => ({ channelId: channel.id, createdBy: tenant.id, name: r.name ?? r.phone, phone: r.phone, status: "active", source: "api", groups: [] })),
    );
  }
  const all = await db.select({ id: contacts.id, phone: contacts.phone }).from(contacts).where(and(eq(contacts.channelId, channel.id), inArray(contacts.phone, phones)));
  const idByPhone = new Map(all.map((c) => [c.phone, c.id]));

  const name = input.name ?? defaultName("whatsapp");
  const campaign = await campaignsRepository.create({
    channelId: channel.id,
    createdBy: key.createdBy ?? tenantId,
    name,
    description: `Sent through the API with key ${key.name}`,
    campaignType: "whatsapp",
    type: "template",
    apiType: "cloud_api",
    templateId: template.id,
    templateName: template.name,
    templateLanguage: template.language ?? "en_US",
    variableMapping: Object.fromEntries(Array.from({ length: vars }, (_, i) => [String(i + 1), "field:name"])),
    contactGroups: [],
    audienceType: "contacts",
    csvData: list.map((r) => ({ contactId: idByPhone.get(r.phone)!, ...Object.fromEntries((r.variables ?? []).slice(0, vars).map((v, i) => [String(i + 1), v])) })),
    status: input.scheduleAt ? "scheduled" : "draft",
    scheduledAt: input.scheduleAt ?? null,
  });
  const started = input.scheduleAt ? campaign : await startCampaign(campaign.id);
  return result(campaign.id, input, name, started.status ?? "running", channel.connectionMethod === "simulator" || config.WHATSAPP_SIMULATE, input.recipients.length, list.length, rejected);
}

export async function sendViaApi(key: ApiKey, tenant: User, input: ApiSendInput): Promise<SendResult> {
  await assertApiAllowed(key, input.channel);
  if (input.channel === "email") return sendEmail(key, input);
  if (input.channel === "sms") return sendSms(key, input);
  return sendWhatsapp(key, input, tenant);
}
