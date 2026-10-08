/**
 * Unified contact timeline (see shared/timeline.ts): conversations, email and SMS sends, flows,
 * notes and changes for one contact, merged newest first with cursor paging.
 */
import crypto from "node:crypto";
import { and, count, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { ContactSummary, TimelineItem, TimelineKind, TimelinePage } from "@shared/timeline";
import { renderMergeTags } from "@shared/sms";
import {
  automationRuns,
  automations,
  contactNotes,
  conversations,
  emailCampaignRecipients,
  emailCampaigns,
  messages,
  smsCampaignRecipients,
  smsCampaigns,
  userActivityLogs,
  users,
  type Contact,
} from "@shared/schema";
import { db } from "../db";

const FAR_FUTURE = new Date("9999-01-01T00:00:00Z");
const clip = (s: string | null | undefined, n = 400) => (s && s.length > n ? `${s.slice(0, n)}…` : (s ?? null));
const iso = (d: Date | null | undefined) => (d ?? new Date(0)).toISOString();
/** Hidden flow campaigns are named "Flow: <name> (<step>)". */
const campaignLabel = (name: string | null | undefined, automationId: string | null | undefined) => (automationId ? `Flow: ${(name ?? "").replace(/^Flow: /, "").replace(/ \([^)]*\)$/, "")}` : `Campaign: ${name ?? ""}`);
const personName = (u: { username: string | null; firstName: string | null; lastName: string | null } | null) => (u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "A teammate" : "A teammate");

async function conversationIds(contactId: string): Promise<{ id: string; type: string | null }[]> {
  return db.select({ id: conversations.id, type: conversations.type }).from(conversations).where(eq(conversations.contactId, contactId));
}

// --- Sources (each returns up to `limit` items older than `before`) ------------------------------

async function messageItems(contactId: string, before: Date, limit: number): Promise<TimelineItem[]> {
  const convs = await conversationIds(contactId);
  if (!convs.length) return [];
  const typeOf = new Map(convs.map((c) => [c.id, c.type ?? "whatsapp"]));
  const at = sql<Date>`COALESCE(${messages.timestamp}, ${messages.createdAt})`;
  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId, content: messages.content, direction: messages.direction, fromType: messages.fromType, type: messages.type, status: messages.status, metadata: messages.metadata, at: messages.timestamp, createdAt: messages.createdAt })
    .from(messages)
    .where(and(inArray(messages.conversationId, convs.map((c) => c.id)), lt(at, before)))
    .orderBy(desc(at))
    .limit(limit);
  return rows.map((m) => {
    const meta = (m.metadata ?? {}) as { sentByName?: string; campaignName?: string; bot?: boolean; automationName?: string; source?: string };
    const inbound = m.direction === "inbound";
    const actor = inbound
      ? null
      : meta.bot
        ? "Chatbot"
        : meta.automationName
          ? `Flow: ${meta.automationName}`
          : meta.campaignName
            ? (meta.campaignName.startsWith("Flow: ") ? campaignLabel(meta.campaignName, "flow") : `Campaign: ${meta.campaignName}`)
            : meta.source === "business_app"
              ? "WhatsApp Business app"
              : (meta.sentByName ?? null);
    const channel = typeOf.get(m.conversationId!) ?? "whatsapp";
    return {
      id: `message:${m.id}`,
      kind: "message" as const,
      at: iso(m.at ?? m.createdAt),
      title: inbound ? "Message received" : m.type === "template" ? "Template sent" : "Message sent",
      body: clip(m.content),
      channel,
      direction: inbound ? ("inbound" as const) : ("outbound" as const),
      status: m.status,
      actor,
      tags: meta.source === "history" ? ["imported"] : [],
      link: channel === "whatsapp" || channel === "web" || channel === "messenger" || channel === "instagram" ? `/inbox?c=${m.conversationId}` : null,
    };
  });
}

/** What the contact actually received: campaign texts with their merge tags filled in. */
const personalise = (c: Contact, text: string) => renderMergeTags(text, { name: c.name, phone: c.phone, email: c.email ?? "", fields: (c.metadata ?? {}) as Record<string, string> });

async function emailItems(contactId: string, before: Date, limit: number, c: Contact): Promise<TimelineItem[]> {
  const at = sql<Date>`COALESCE(${emailCampaignRecipients.sentAt}, ${emailCampaignRecipients.createdAt})`;
  const rows = await db
    .select({ id: emailCampaignRecipients.id, email: emailCampaignRecipients.email, status: emailCampaignRecipients.status, sentAt: emailCampaignRecipients.sentAt, createdAt: emailCampaignRecipients.createdAt, openedAt: emailCampaignRecipients.openedAt, clickedAt: emailCampaignRecipients.clickedAt, error: emailCampaignRecipients.errorMessage, campaignId: emailCampaigns.id, name: emailCampaigns.name, subject: emailCampaigns.subject, automationId: emailCampaigns.automationId })
    .from(emailCampaignRecipients)
    .innerJoin(emailCampaigns, eq(emailCampaigns.id, emailCampaignRecipients.campaignId))
    .where(and(eq(emailCampaignRecipients.contactId, contactId), lt(at, before)))
    .orderBy(desc(at))
    .limit(limit);
  return rows.map((r) => ({
    id: `email:${r.id}`,
    kind: "email" as const,
    at: iso(r.sentAt ?? r.createdAt),
    title: r.sentAt ? `Email sent: ${personalise(c, r.subject)}` : `Email ${r.status ?? "queued"}: ${personalise(c, r.subject)}`,
    body: r.error && ["failed", "bounced", "complained"].includes(r.status ?? "") ? r.error : r.email,
    status: r.status,
    actor: campaignLabel(r.name, r.automationId),
    tags: [r.openedAt ? "opened" : null, r.clickedAt ? "clicked" : null].filter((x): x is string => Boolean(x)),
    link: r.automationId ? `/automations/${r.automationId}` : `/email-marketing/campaigns?id=${r.campaignId}`,
  }));
}

async function smsItems(contactId: string, before: Date, limit: number, c: Contact): Promise<TimelineItem[]> {
  const at = sql<Date>`COALESCE(${smsCampaignRecipients.sentAt}, ${smsCampaignRecipients.createdAt})`;
  const rows = await db
    .select({ id: smsCampaignRecipients.id, phone: smsCampaignRecipients.phone, status: smsCampaignRecipients.status, sentAt: smsCampaignRecipients.sentAt, createdAt: smsCampaignRecipients.createdAt, deliveredAt: smsCampaignRecipients.deliveredAt, clickedAt: smsCampaignRecipients.clickedAt, name: smsCampaigns.name, message: smsCampaigns.message, automationId: smsCampaigns.automationId, campaignId: smsCampaigns.id })
    .from(smsCampaignRecipients)
    .innerJoin(smsCampaigns, eq(smsCampaigns.id, smsCampaignRecipients.campaignId))
    .where(and(eq(smsCampaignRecipients.contactId, contactId), lt(at, before)))
    .orderBy(desc(at))
    .limit(limit);
  return rows.map((r) => ({
    id: `sms:${r.id}`,
    kind: "sms" as const,
    at: iso(r.sentAt ?? r.createdAt),
    title: r.sentAt ? "SMS sent" : `SMS ${r.status ?? "queued"}`,
    body: clip(personalise(c, r.message), 300),
    status: r.status,
    actor: campaignLabel(r.name, r.automationId),
    tags: [r.deliveredAt || r.status === "delivered" ? "delivered" : null, r.clickedAt ? "clicked" : null].filter((x): x is string => Boolean(x)),
    link: r.automationId ? `/automations/${r.automationId}` : `/sms-marketing/campaigns?id=${r.campaignId}`,
  }));
}

async function automationItems(contactId: string, before: Date, limit: number): Promise<TimelineItem[]> {
  const rows = await db
    .select({ id: automationRuns.id, status: automationRuns.status, startedAt: automationRuns.startedAt, finishedAt: automationRuns.finishedAt, lastError: automationRuns.lastError, automationId: automations.id, name: automations.name })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(eq(automationRuns.contactId, contactId), or(lt(automationRuns.startedAt, before), and(isNotNull(automationRuns.finishedAt), lt(automationRuns.finishedAt, before)))))
    .orderBy(desc(automationRuns.startedAt))
    .limit(limit);
  const items: TimelineItem[] = [];
  for (const r of rows) {
    const link = `/automations/${r.automationId}`;
    if (r.startedAt && r.startedAt < before) items.push({ id: `automation:${r.id}:start`, kind: "automation", at: iso(r.startedAt), title: `Entered the flow “${r.name}”`, status: r.status === "active" || r.status === "waiting" ? "in progress" : null, link });
    if (r.finishedAt && r.finishedAt < before) {
      const title = r.status === "completed" ? `Finished the flow “${r.name}”` : r.status === "failed" ? `The flow “${r.name}” stopped with an error` : `Left the flow “${r.name}”`;
      items.push({ id: `automation:${r.id}:end`, kind: "automation", at: iso(r.finishedAt), title, body: r.status === "completed" ? null : r.lastError, status: r.status, link });
    }
  }
  return items;
}

async function noteItems(contactId: string, before: Date, limit: number): Promise<TimelineItem[]> {
  const rows = await db
    .select({ id: contactNotes.id, body: contactNotes.body, createdAt: contactNotes.createdAt, userId: contactNotes.userId, username: users.username, firstName: users.firstName, lastName: users.lastName })
    .from(contactNotes)
    .leftJoin(users, eq(users.id, contactNotes.userId))
    .where(and(eq(contactNotes.contactId, contactId), lt(contactNotes.createdAt, before)))
    .orderBy(desc(contactNotes.createdAt))
    .limit(limit);
  return rows.map((n) => ({ id: `note:${n.id}`, kind: "note" as const, at: iso(n.createdAt), title: "Note", body: n.body, actor: n.userId ? personName(n) : "A former teammate", authorId: n.userId }));
}

const ACTIVITY_TITLES: Record<string, string> = { contact_created: "Contact added", contact_updated: "Details edited", contact_note_deleted: "Note deleted" };

async function activityItems(contactId: string, before: Date, limit: number): Promise<TimelineItem[]> {
  const rows = await db
    .select({ id: userActivityLogs.id, action: userActivityLogs.action, details: userActivityLogs.details, createdAt: userActivityLogs.createdAt, username: users.username, firstName: users.firstName, lastName: users.lastName })
    .from(userActivityLogs)
    .leftJoin(users, eq(users.id, userActivityLogs.userId))
    .where(and(eq(userActivityLogs.entityId, contactId), sql`${userActivityLogs.entityType} = 'contact'`, lt(userActivityLogs.createdAt, before)))
    .orderBy(desc(userActivityLogs.createdAt))
    .limit(limit);
  return rows.map((a) => {
    const fields = (a.details as { fields?: string[] } | null)?.fields;
    return { id: `activity:${a.id}`, kind: "activity" as const, at: iso(a.createdAt), title: ACTIVITY_TITLES[a.action] ?? a.action.replace(/_/g, " "), body: fields?.length ? `Changed: ${fields.join(", ")}` : null, actor: personName(a) };
  });
}

const SOURCES: Record<TimelineKind, (contactId: string, before: Date, limit: number, contact: Contact) => Promise<TimelineItem[]>> = {
  message: messageItems,
  email: emailItems,
  sms: smsItems,
  automation: automationItems,
  note: noteItems,
  activity: activityItems,
};

/** One page of the timeline: each source gives its newest items before the cursor, then they're merged. */
export async function contactTimeline(contact: Contact, opts: { before?: Date; kinds: TimelineKind[]; limit: number }): Promise<TimelinePage> {
  const before = opts.before ?? FAR_FUTURE;
  const lists = await Promise.all(opts.kinds.map((k) => SOURCES[k](contact.id, before, opts.limit + 1, contact)));
  return mergePage(lists, opts.limit);
}

/** Newest first across sources; items sharing the page's last timestamp stay together (the cursor is a strict "<"). */
export function mergePage(lists: TimelineItem[][], limit: number): TimelinePage {
  const merged = lists.flat().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  const page = merged.slice(0, limit);
  const last = page.at(-1);
  if (last) for (const extra of merged.slice(limit)) if (extra.at === last.at) page.push(extra);
  return { items: page, nextBefore: merged.length > page.length && last ? last.at : null };
}

export async function contactSummary(contact: Contact): Promise<ContactSummary> {
  const convs = await db.select({ id: conversations.id, status: conversations.status, lastMessageAt: conversations.lastMessageAt }).from(conversations).where(eq(conversations.contactId, contact.id));
  const ids = convs.map((c) => c.id);
  const [msg] = ids.length
    ? await db
        .select({ inbound: sql<number>`SUM(${messages.direction} = 'inbound')`, outbound: sql<number>`SUM(${messages.direction} <> 'inbound')`, lastInbound: sql<string | null>`DATE_FORMAT(MAX(CASE WHEN ${messages.direction} = 'inbound' THEN COALESCE(${messages.timestamp}, ${messages.createdAt}) END), '%Y-%m-%dT%H:%i:%s.%fZ')` })
        .from(messages)
        .where(inArray(messages.conversationId, ids))
    : [{ inbound: 0, outbound: 0, lastInbound: null }];
  const [email] = await db
    .select({ sent: sql<number>`SUM(${emailCampaignRecipients.sentAt} IS NOT NULL)`, opened: sql<number>`SUM(${emailCampaignRecipients.openedAt} IS NOT NULL)`, clicked: sql<number>`SUM(${emailCampaignRecipients.clickedAt} IS NOT NULL)` })
    .from(emailCampaignRecipients)
    .where(eq(emailCampaignRecipients.contactId, contact.id));
  const [sms] = await db.select({ sent: sql<number>`SUM(${smsCampaignRecipients.sentAt} IS NOT NULL)`, clicked: sql<number>`SUM(${smsCampaignRecipients.clickedAt} IS NOT NULL)` }).from(smsCampaignRecipients).where(eq(smsCampaignRecipients.contactId, contact.id));
  const [flows] = await db.select({ total: count(), active: sql<number>`SUM(${automationRuns.status} IN ('active','waiting'))` }).from(automationRuns).where(eq(automationRuns.contactId, contact.id));
  const [notes] = await db.select({ n: count() }).from(contactNotes).where(eq(contactNotes.contactId, contact.id));
  const latest = [...convs].sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))[0];
  // Stored in UTC; formatted as ISO in SQL so the driver's time zone can't shift it.
  const lastInbound = msg?.lastInbound ? new Date(String(msg.lastInbound).replace(/(\.\d{3})\d*Z$/, "$1Z")) : null;
  return {
    messages: { inbound: Number(msg?.inbound ?? 0), outbound: Number(msg?.outbound ?? 0), lastInboundAt: lastInbound && !Number.isNaN(lastInbound.getTime()) ? lastInbound.toISOString() : null },
    conversations: { open: convs.filter((c) => c.status !== "resolved" && c.status !== "closed").length, total: convs.length, latestId: latest?.id ?? null },
    email: { sent: Number(email?.sent ?? 0), opened: Number(email?.opened ?? 0), clicked: Number(email?.clicked ?? 0) },
    sms: { sent: Number(sms?.sent ?? 0), clicked: Number(sms?.clicked ?? 0) },
    flows: { active: Number(flows?.active ?? 0), total: Number(flows?.total ?? 0) },
    notes: Number(notes?.n ?? 0),
  };
}

export const notesRepository = {
  async create(contactId: string, userId: string, body: string) {
    const id = crypto.randomUUID();
    await db.insert(contactNotes).values({ id, contactId, userId, body });
    const [row] = await db.select().from(contactNotes).where(eq(contactNotes.id, id));
    return row;
  },
  async find(id: string) {
    const [row] = await db.select().from(contactNotes).where(eq(contactNotes.id, id)).limit(1);
    return row;
  },
  async delete(id: string) {
    await db.delete(contactNotes).where(eq(contactNotes.id, id));
  },
};
