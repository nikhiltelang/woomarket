/**
 * Builds webhook payloads from domain objects and emits them. Kept apart from the call sites
 * so every event has the same shape wherever it comes from.
 */
import { and, eq, inArray } from "drizzle-orm";
import { contacts, type Contact } from "@shared/schema";
import type { WebhookEvent } from "@shared/webhooks";
import { db } from "../db";
import { childLogger } from "../lib/logger";
import { channelsRepository } from "../repositories/channels.repository";
import { emailCampaignsRepository } from "../repositories/email.repository";
import { smsCampaignsRepository } from "../repositories/sms.repository";
import { emit, webhooksRepository } from "./webhooks.service";

const log = childLogger("webhook-events");
/** An import or API batch emits at most this many contact.created events. */
export const MAX_BULK_EVENTS = 1000;

export function contactData(c: Contact) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    tags: c.tags ?? [],
    groups: c.groups ?? [],
    fields: c.metadata ?? {},
    status: c.status,
    source: c.source,
    channelId: c.channelId,
    createdAt: c.createdAt,
  };
}

const tenantCache = new Map<string, { tenant: string | null; at: number }>();
/** Tenant that owns a channel (cached for a minute; channels rarely change owner). */
export async function tenantOfChannel(channelId: string | null | undefined): Promise<string | null> {
  if (!channelId) return null;
  const hit = tenantCache.get(channelId);
  if (hit && Date.now() - hit.at < 60_000) return hit.tenant;
  const tenant = (await channelsRepository.findById(channelId))?.createdBy ?? null;
  tenantCache.set(channelId, { tenant, at: Date.now() });
  return tenant;
}

/** Emits an event for the tenant owning `channelId`. Fire-and-forget. */
export function emitForChannel(channelId: string | null | undefined, event: WebhookEvent, data: Record<string, unknown>) {
  void tenantOfChannel(channelId)
    .then((tenant) => emit(tenant, event, data))
    .catch((err) => log.warn({ event, err: (err as Error).message }, "Could not resolve tenant for webhook"));
}

/** Whether anything listens, so callers can skip work for tenants without webhooks. */
export async function hasSubscribers(tenantId: string | null | undefined, event: WebhookEvent): Promise<boolean> {
  if (!tenantId) return false;
  try {
    return (await webhooksRepository.subscribed(tenantId, event)).length > 0;
  } catch {
    return false;
  }
}

/** contact.created for contacts just inserted in bulk (identified by phone). */
export async function emitContactsCreated(tenantId: string | null | undefined, channelId: string, phones: string[]) {
  if (!tenantId || !phones.length || !(await hasSubscribers(tenantId, "contact.created"))) return;
  if (phones.length > MAX_BULK_EVENTS) log.info({ tenantId, count: phones.length }, `Only the first ${MAX_BULK_EVENTS} contact.created events are sent for a bulk import`);
  const list = phones.slice(0, MAX_BULK_EVENTS);
  for (let i = 0; i < list.length; i += 500) {
    const rows = await db.select().from(contacts).where(and(eq(contacts.channelId, channelId), inArray(contacts.phone, list.slice(i, i + 500))));
    for (const c of rows) emit(tenantId, "contact.created", { contact: contactData(c) });
  }
}

/** Which of the tracked contact properties changed. */
export function changedFields(before: Contact, after: Contact): string[] {
  const keys = ["name", "phone", "email", "status", "tags", "groups", "metadata"] as const;
  return keys.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).map((k) => (k === "metadata" ? "fields" : k));
}

/** Counters of a finished campaign (every numeric *Count column). */
export function campaignCounts(row: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([k, v]) => k.endsWith("Count") && typeof v === "number")
      .map(([k, v]) => [k.replace(/Count$/, ""), v as number]),
  );
}

/** Emits for the tenant owning an email or SMS campaign. Fire-and-forget. */
export function emitForCampaign(kind: "email" | "sms", campaignId: string, event: WebhookEvent, data: Record<string, unknown>) {
  void (async () => {
    const c = kind === "email" ? await emailCampaignsRepository.find(campaignId) : await smsCampaignsRepository.find(campaignId);
    if (c) emit(c.userId, event, data);
  })().catch((err) => log.warn({ event, err: (err as Error).message }, "Could not emit campaign webhook"));
}
