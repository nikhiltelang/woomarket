import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { MAX_API_AUDIENCE, type ApiSendInput } from "@shared/public-api";
import { calculateSegments, renderMergeTags } from "@shared/sms";
import { contacts, emailCampaignRecipients, emailCampaigns, type ApiKey, type Channel, type Group, type User } from "@shared/schema";
import { config } from "../config";
import { db } from "../db";
import { AppError, badRequest, forbidden, unprocessable } from "../lib/errors";
import { assertWithinPlan } from "../middlewares/subscription";
import { campaignsRepository } from "../repositories/campaigns.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { groupsRepository } from "../repositories/groups.repository";
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
  /** Groups the request named, with how many of their members this send reached. */
  groups: { id: string; name: string; members: number }[];
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

function result(id: string, input: ApiSendInput, name: string, status: string, testMode: boolean, requested: number, accepted: number, rejected: Rejected[], groups: GroupSummary[]): SendResult {
  return { id, channel: input.channel, name, status, scheduledAt: input.scheduleAt?.toISOString() ?? null, testMode, recipients: { requested, accepted, rejected }, groups };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

type GroupSummary = { id: string; name: string; members: number };
interface Member {
  contactId: string;
  channelId: string;
  name: string;
  phone: string;
  email: string | null;
}

/** Matches each reference to one of the tenant's groups by id, or by name (case-insensitive). */
export async function resolveGroups(tenantId: string, refs: string[]): Promise<Group[]> {
  if (!refs.length) return [];
  const all = await groupsRepository.listByTenant(tenantId);
  const found = new Map<string, Group>();
  const missing: string[] = [];
  for (const ref of refs) {
    const byId = all.find((g) => g.id === ref);
    const byName = byId ? [] : all.filter((g) => g.name.trim().toLowerCase() === ref.trim().toLowerCase());
    if (byName.length > 1) throw new AppError(422, `Several groups are named "${ref}". Use the group id instead.`, "AMBIGUOUS_GROUP", { matches: byName.map((g) => ({ id: g.id, name: g.name })) });
    const g = byId ?? byName[0];
    if (g) found.set(g.id, g);
    else missing.push(ref);
  }
  if (missing.length) throw new AppError(422, `Unknown group${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`, "GROUP_NOT_FOUND", { missing });
  return [...found.values()];
}

/** Active contacts in any of the groups, on the given numbers. */
async function groupMembers(channelIds: string[], groupIds: string[]): Promise<(Member & { groups: string[]; metadata: Record<string, string> })[]> {
  if (!groupIds.length || !channelIds.length) return [];
  const rows = await db
    .select({ contactId: contacts.id, channelId: contacts.channelId, name: contacts.name, phone: contacts.phone, email: contacts.email, groups: contacts.groups, metadata: contacts.metadata })
    .from(contacts)
    .where(and(inArray(contacts.channelId, channelIds), eq(contacts.status, "active"), or(...groupIds.map((g) => sql`JSON_CONTAINS(${contacts.groups}, JSON_QUOTE(${g}))`))))
    .limit(MAX_API_AUDIENCE + 1);
  if (rows.length > MAX_API_AUDIENCE) throw unprocessable(`These groups have more than ${MAX_API_AUDIENCE.toLocaleString("en")} members; split the send into smaller groups.`, "AUDIENCE_TOO_LARGE");
  return rows.map((r) => ({ ...r, channelId: r.channelId!, groups: r.groups ?? [], metadata: r.metadata ?? {} }));
}

const toE164 = (phone: string) => (phone.startsWith("+") ? phone : `+${phone}`);

/** How many of each group's members ended up in the audience. */
function summarise(groups: Group[], members: { groups: string[] }[]): GroupSummary[] {
  return groups.map((g) => ({ id: g.id, name: g.name, members: members.filter((m) => m.groups.includes(g.id)).length }));
}

function assertAudienceSize(n: number) {
  if (n > MAX_API_AUDIENCE) throw unprocessable(`At most ${MAX_API_AUDIENCE.toLocaleString("en")} recipients per request.`, "AUDIENCE_TOO_LARGE");
}

function noneLeft(rejected: Rejected[]): never {
  throw new AppError(422, "None of the recipients can be sent to.", "NO_VALID_RECIPIENTS", { rejected });
}

// ---------------------------------------------------------------------------

/** Nothing left to send: explain whether it was the recipients or empty groups. */
function nothingToSend(rejected: Rejected[], groups: Group[], what: string): never {
  if (!rejected.length && groups.length) throw unprocessable(`The selected group${groups.length === 1 ? " has" : "s have"} no active members with ${what}.`, "EMPTY_AUDIENCE");
  noneLeft(rejected);
}

async function sendEmail(key: ApiKey, input: Extract<ApiSendInput, { channel: "email" }>): Promise<SendResult> {
  const tenantId = key.userId;
  const rejected: Rejected[] = [];
  const groups = await resolveGroups(tenantId, input.groups);
  const members = (await groupMembers(await tenantChannelIds(tenantId), groups.map((g) => g.id)))
    .filter((m) => m.email?.trim())
    .map((m) => ({ email: m.email!.trim().toLowerCase(), name: m.name, contactId: m.contactId, groups: m.groups }));

  // Listed recipients first (duplicates reported), then group members not already included.
  let list: { email: string; name?: string; contactId?: string }[] = dedupe(input.recipients, (r) => r.email, rejected);
  const seen = new Set(list.map((r) => r.email));
  for (const m of members) if (!seen.has(m.email)) (seen.add(m.email), list.push(m));
  assertAudienceSize(list.length);
  const blocked = await suppressedEmails(tenantId, list.map((r) => r.email));
  list = list.filter((r) => (blocked.has(r.email) ? (rejected.push({ recipient: r.email, reason: "unsubscribed" }), false) : true));
  if (!list.length) nothingToSend(rejected, groups, "an email address");

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
    targetGroupId: groups.length === 1 && !input.recipients.length ? groups[0].id : null,
    targetGroupName: groups.length ? groups.map((g) => g.name).join(", ").slice(0, 255) : null,
    csvData: list.map((r) => ({ email: r.email, ...(r.name ? { name: r.name } : {}), ...(r.contactId ? { contactId: r.contactId } : {}) })),
    scheduledAt: input.scheduleAt ?? null,
    status: input.scheduleAt ? "scheduled" : "draft",
  });
  const started = input.scheduleAt ? campaign : await startEmailCampaign(campaign.id);
  return result(campaign.id, input, name, started.status ?? "sending", smtp.source === "simulator", input.recipients.length + members.length, list.length, rejected, summarise(groups, members));
}

async function sendSms(key: ApiKey, input: Extract<ApiSendInput, { channel: "sms" }>): Promise<SendResult> {
  const tenantId = key.userId;
  const rejected: Rejected[] = [];
  const groups = await resolveGroups(tenantId, input.groups);
  const members = (await groupMembers(await tenantChannelIds(tenantId), groups.map((g) => g.id))).map((m) => ({ phone: toE164(m.phone), name: m.name, contactId: m.contactId, groups: m.groups }));

  let list: { phone: string; name?: string; contactId?: string }[] = dedupe(input.recipients, (r) => r.phone, rejected);
  const seen = new Set(list.map((r) => r.phone));
  for (const m of members) if (!seen.has(m.phone)) (seen.add(m.phone), list.push(m));
  assertAudienceSize(list.length);
  const blocked = await suppressedPhones(tenantId, list.map((r) => r.phone));
  list = list.filter((r) => (blocked.has(r.phone) ? (rejected.push({ recipient: r.phone, reason: "unsubscribed" }), false) : true));
  if (!list.length) nothingToSend(rejected, groups, "a phone number");

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
    targetGroupId: groups.length === 1 && !input.recipients.length ? groups[0].id : null,
    targetGroupName: groups.length ? groups.map((g) => g.name).join(", ").slice(0, 255) : null,
    csvData: list.map((r) => ({ phone: r.phone, ...(r.name ? { name: r.name } : {}), ...(r.contactId ? { contactId: r.contactId } : {}) })),
    scheduledAt: input.scheduleAt ?? null,
    status: input.scheduleAt ? "scheduled" : "draft",
    smsSegmentsPerRecipient: calculateSegments(input.message).segments,
    gateway: gateway?.provider ?? "simulator",
    senderId: gateway?.senderId ?? "CORTESYS",
    fromNumber: gateway?.fromNumber ?? null,
  });
  const started = input.scheduleAt ? campaign : await startSmsCampaign(campaign.id);
  const testMode = !gateway || !gateway.isActive || gateway.provider === "simulator";
  return result(campaign.id, input, name, started.status ?? "sending", testMode, input.recipients.length + members.length, list.length, rejected, summarise(groups, members));
}

/**
 * The sending number: explicit `from` (id or phone), the key's default, the number the
 * requested groups belong to, or the account's only number.
 */
async function pickChannel(key: ApiKey, from: string | undefined, groups: Group[]): Promise<Channel> {
  const list = (await channelsRepository.listByTenant(key.userId)).filter((c) => c.isActive !== false);
  if (from) {
    const digits = from.replace(/\D/g, "");
    const match = list.find((c) => c.id === from || (digits.length > 5 && (c.phoneNumber ?? "").replace(/\D/g, "") === digits));
    if (!match) throw unprocessable(`No connected WhatsApp number matches "from": ${from}.`, "UNKNOWN_SENDER");
    return match;
  }
  const preferred = key.defaultChannelId ? list.find((c) => c.id === key.defaultChannelId) : undefined;
  if (preferred) return preferred;
  const groupChannels = [...new Set(groups.map((g) => g.channelId).filter(Boolean))];
  const ofGroups = groupChannels.length === 1 ? list.find((c) => c.id === groupChannels[0]) : undefined;
  if (ofGroups) return ofGroups;
  if (list.length === 1) return list[0];
  if (!list.length) throw unprocessable("Connect a WhatsApp number before sending WhatsApp messages.", "NO_WHATSAPP_NUMBER");
  throw badRequest('This account has several WhatsApp numbers. Say which one with "from" (number id or phone number).');
}

async function sendWhatsapp(key: ApiKey, input: Extract<ApiSendInput, { channel: "whatsapp" }>, tenant: User): Promise<SendResult> {
  const tenantId = key.userId;
  const groups = await resolveGroups(tenantId, input.groups);
  const channel = await pickChannel(key, input.from, groups);
  const templates = (await templatesRepository.listByChannel(channel.id)).filter((t) => t.name === input.template.name);
  const template =
    templates.find((t) => t.status === "approved" && (!input.template.language || t.language === input.template.language)) ??
    (input.template.language ? undefined : templates.find((t) => t.status === "approved"));
  if (!template) {
    const why = templates.length ? "isn't approved" + (input.template.language ? ` in ${input.template.language}` : "") : "doesn't exist on this number";
    throw unprocessable(`Template "${input.template.name}" ${why}.`, "TEMPLATE_NOT_AVAILABLE");
  }
  const vars = template.bodyVariables ?? 0;
  const defaults = input.template.variables ?? [];
  if (groups.length && defaults.length < vars) {
    throw badRequest(`Template "${template.name}" has ${vars} variable${vars === 1 ? "" : "s"}. Group members need template.variables (merge tags like {{name}} are allowed).`);
  }
  // WhatsApp campaigns send to contacts of one number, so group members come from the sending number only.
  const members = (await groupMembers([channel.id], groups.map((g) => g.id))).map((m) => ({ phone: m.phone, name: m.name, email: m.email, contactId: m.contactId, groups: m.groups, fields: m.metadata, variables: undefined as string[] | undefined }));

  const rejected: Rejected[] = [];
  let list: { phone: string; name?: string; email?: string | null; contactId?: string; fields?: Record<string, string>; variables?: string[] }[] = dedupe(input.recipients, (r) => r.phone, rejected);
  const seen = new Set(list.map((r) => r.phone.replace(/^\+/, "")));
  for (const m of members) {
    const k = m.phone.replace(/^\+/, "");
    if (!seen.has(k)) (seen.add(k), list.push(m));
  }
  assertAudienceSize(list.length);
  list = list.filter((r) => {
    if ((r.variables?.length ?? defaults.length) >= vars) return true;
    rejected.push({ recipient: r.phone, reason: `template needs ${vars} variable${vars === 1 ? "" : "s"}` });
    return false;
  });
  const blocked = await suppressedPhones(tenantId, list.map((r) => toE164(r.phone)));
  list = list.filter((r) => (blocked.has(toE164(r.phone)) ? (rejected.push({ recipient: r.phone, reason: "unsubscribed" }), false) : true));
  if (!list.length) nothingToSend(rejected, groups, `a contact on ${channel.name}`);

  await assertWithinPlan(tenantId, "campaign");
  // Listed recipients become contacts on the sending number (WhatsApp campaigns send to contacts).
  const listed = list.filter((r) => !r.contactId);
  const phones = listed.map((r) => r.phone);
  const existing = phones.length ? await db.select({ id: contacts.id, phone: contacts.phone }).from(contacts).where(and(eq(contacts.channelId, channel.id), inArray(contacts.phone, phones))) : [];
  const known = new Set(existing.map((c) => c.phone));
  const fresh = listed.filter((r) => !known.has(r.phone));
  if (fresh.length) {
    await assertWithinPlan(tenantId, "contacts", fresh.length);
    await contactsRepository.insertManyIgnoreDuplicates(
      fresh.map((r) => ({ channelId: channel.id, createdBy: tenant.id, name: r.name ?? r.phone, phone: r.phone, status: "active", source: "api", groups: [] })),
    );
  }
  const idByPhone = new Map(
    (phones.length ? await db.select({ id: contacts.id, phone: contacts.phone }).from(contacts).where(and(eq(contacts.channelId, channel.id), inArray(contacts.phone, phones))) : []).map((c) => [c.phone, c.id]),
  );

  // Each recipient's {{1}}, {{2}}…: its own variables, else template.variables with merge tags filled in.
  const valuesFor = (r: (typeof list)[number]) =>
    (r.variables ?? defaults.map((v) => renderMergeTags(v, { name: r.name ?? "", phone: r.phone, email: r.email ?? "", fields: r.fields ?? {} }))).slice(0, vars);

  const name = input.name ?? defaultName("whatsapp");
  const campaign = await campaignsRepository.create({
    channelId: channel.id,
    createdBy: key.createdBy ?? tenantId,
    name,
    description: `Sent through the API with key ${key.name}${groups.length ? ` to ${groups.map((g) => g.name).join(", ")}` : ""}`.slice(0, 1000),
    campaignType: "whatsapp",
    type: "template",
    apiType: "cloud_api",
    templateId: template.id,
    templateName: template.name,
    templateLanguage: template.language ?? "en_US",
    variableMapping: Object.fromEntries(Array.from({ length: vars }, (_, i) => [String(i + 1), "field:name"])),
    contactGroups: groups.map((g) => g.id),
    audienceType: "contacts",
    csvData: list.map((r) => ({ contactId: r.contactId ?? idByPhone.get(r.phone)!, ...Object.fromEntries(valuesFor(r).map((v, i) => [String(i + 1), v])) })),
    status: input.scheduleAt ? "scheduled" : "draft",
    scheduledAt: input.scheduleAt ?? null,
  });
  const started = input.scheduleAt ? campaign : await startCampaign(campaign.id);
  return result(campaign.id, input, name, started.status ?? "running", channel.connectionMethod === "simulator" || config.WHATSAPP_SIMULATE, input.recipients.length + members.length, list.length, rejected, summarise(groups, members));
}

export async function sendViaApi(key: ApiKey, tenant: User, input: ApiSendInput): Promise<SendResult> {
  await assertApiAllowed(key, input.channel);
  if (input.channel === "email") return sendEmail(key, input);
  if (input.channel === "sms") return sendSms(key, input);
  return sendWhatsapp(key, input, tenant);
}
