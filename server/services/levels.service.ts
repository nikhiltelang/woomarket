import { and, count, eq, gte, inArray, isNull } from "drizzle-orm";
import { campaigns, channels, conversations, messages, type AccessLevel } from "@shared/schema";
import { db } from "../db";
import { forbidden } from "../lib/errors";
import { levelsRepository } from "../repositories/platform.repository";
import { usersRepository } from "../repositories/users.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { contactsRepository } from "../repositories/contacts.repository";

export type LevelFeature = "channel" | "contacts" | "team" | "campaign" | "email" | "sms";

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

async function tenantChannelIds(tenantId: string) {
  return (await db.select({ id: channels.id }).from(channels).where(eq(channels.createdBy, tenantId))).map((c) => c.id);
}

export async function campaignsThisMonth(tenantId: string): Promise<number> {
  const ids = await tenantChannelIds(tenantId);
  if (!ids.length) return 0;
  const [{ n }] = await db.select({ n: count() }).from(campaigns).where(and(inArray(campaigns.channelId, ids), isNull(campaigns.automationId), gte(campaigns.createdAt, monthStart())));
  return n;
}

export async function outboundMessagesThisMonth(tenantId: string): Promise<number> {
  const ids = await tenantChannelIds(tenantId);
  if (!ids.length) return 0;
  const [{ n }] = await db
    .select({ n: count() })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(inArray(conversations.channelId, ids), eq(messages.direction, "outbound"), gte(messages.createdAt, monthStart())));
  return n;
}

/** Usage counters, dispatched through an object so tests can replace them. */
export const levelUsage = { campaignsThisMonth, outboundMessagesThisMonth };

/** The access level assigned to a tenant, if any. */
export async function tenantLevel(tenantId: string): Promise<AccessLevel | undefined> {
  const user = await usersRepository.findById(tenantId);
  if (user?.accessLevel == null) return undefined;
  return levelsRepository.findByNumber(user.accessLevel);
}

const exceeded = (level: AccessLevel, what: string, max: number) =>
  forbidden(`Your access level (${level.name}) allows ${max} ${what}. Contact the platform administrator to raise it.`, "LEVEL_LIMIT");

/** Level limits apply on top of plan limits. -1 means unlimited. */
export async function assertWithinLevel(tenantId: string, feature: LevelFeature, adding = 1): Promise<void> {
  const level = await tenantLevel(tenantId);
  if (!level) return;
  const check = async (max: number | null, used: () => Promise<number>, what: string) => {
    if (max === null || max === -1) return;
    if ((await used()) + adding > max) throw exceeded(level, what, max);
  };
  switch (feature) {
    case "channel":
      return check(level.maxChannels, () => channelsRepository.countByTenant(tenantId), "WhatsApp numbers");
    case "contacts":
      return check(level.maxContacts, () => contactsRepository.countByTenant(tenantId), "contacts");
    case "campaign":
      return check(level.maxCampaigns, () => levelUsage.campaignsThisMonth(tenantId), "campaigns per month");
    case "email":
      if (!level.emailEnabled) throw forbidden(`Email marketing isn't included in your access level (${level.name}).`, "LEVEL_FEATURE");
      return;
    case "sms":
      if (!level.smsEnabled) throw forbidden(`SMS marketing isn't included in your access level (${level.name}).`, "LEVEL_FEATURE");
      return;
    default:
      return;
  }
}

/** Monthly outbound WhatsApp message quota for the tenant's level. */
export async function assertMessageQuota(tenantId: string, adding: number): Promise<void> {
  const level = await tenantLevel(tenantId);
  if (!level || level.maxMessagesMonthly === null || level.maxMessagesMonthly === -1) return;
  const used = await levelUsage.outboundMessagesThisMonth(tenantId);
  if (used + adding > level.maxMessagesMonthly) {
    throw forbidden(
      `This would exceed your monthly message allowance (${used.toLocaleString()} of ${level.maxMessagesMonthly.toLocaleString()} used, ${adding.toLocaleString()} more requested).`,
      "LEVEL_LIMIT",
    );
  }
}
