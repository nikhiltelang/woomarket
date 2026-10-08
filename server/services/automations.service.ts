/**
 * Automation flows (see shared/automations.ts). Triggers enrol contacts into runs; a worker moves
 * each run through the steps. Messages go out through a hidden campaign per send step, so the
 * normal workers deliver them with rate limits, retries, tracking and unsubscribe handling.
 */
import crypto from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  automationSchema,
  dateMatches,
  enterBranch,
  findStep,
  flatten,
  nextAfter,
  waitUntil,
  type AutomationInput,
  type AutomationTrigger,
  type Check,
  type Step,
} from "@shared/automations";
import { keywordMatches } from "@shared/chatbot";
import { renderMergeTags } from "@shared/sms";
import { zonedParts } from "@shared/sending";
import { ymd } from "@shared/reports";
import type { WebhookEvent } from "@shared/webhooks";
import {
  automationRuns,
  automations,
  automationStepLogs,
  campaignRecipients,
  campaigns,
  contacts,
  conversations,
  emailCampaignRecipients,
  emailCampaigns,
  messages,
  smsCampaignRecipients,
  smsCampaigns,
  type Automation,
  type AutomationRun,
  type Contact,
} from "@shared/schema";
import { db } from "../db";
import { childLogger } from "../lib/logger";
import { unprocessable } from "../lib/errors";
import { channelsRepository } from "../repositories/channels.repository";
import { campaignsRepository } from "../repositories/campaigns.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { emailCampaignsRepository, suppressionsRepository } from "../repositories/email.repository";
import { groupsRepository } from "../repositories/groups.repository";
import { smsCampaignsRepository, smsGatewayRepository } from "../repositories/sms.repository";
import { renderTemplateBody, templatesRepository } from "../repositories/templates.repository";
import { usersRepository } from "../repositories/users.repository";
import { tenantSettingsRepository } from "./delivery.service";
import { resolveSmtp } from "./email/mailer";
import { assertMessageQuota } from "./levels.service";
import { findOrCreateConversation } from "./messaging.service";
import { queueRepository } from "./message-queue";
import { sendNotification } from "./notification.service";
import { realtime } from "./realtime";
import { compileRules } from "./segments.service";
import { systemConfig } from "./system-config.service";
import { prepareEmailLinks, prepareSmsLinks } from "./tracking.service";
import { contactData, emitForChannel } from "./webhook-events";
import { assertSafeUrl, onEvent } from "./webhooks.service";
import { whatsappFactory } from "./whatsapp";
import { wakeWork } from "./queue/wake";

const log = childLogger("automations");

/** Steps one run may take in a single pass (the rest continue on the next tick). */
const MAX_STEPS_PER_PASS = 50;
const LOCK_MS = 2 * 60_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
/** A manual enrolment or a date trigger enrols at most this many contacts at once. */
export const MAX_BULK_ENROL = 10_000;

export type StepOutcome = "done" | "skipped" | "failed" | "yes" | "no";
type SendKind = "whatsapp" | "email" | "sms";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const automationsRepository = {
  list(tenantId: string) {
    return db.select().from(automations).where(eq(automations.userId, tenantId)).orderBy(desc(automations.updatedAt));
  },
  async find(id: string): Promise<Automation | undefined> {
    const [row] = await db.select().from(automations).where(eq(automations.id, id)).limit(1);
    return row;
  },
  async create(values: Omit<typeof automations.$inferInsert, "id">): Promise<Automation> {
    const id = crypto.randomUUID();
    await db.insert(automations).values({ ...values, id });
    return (await this.find(id))!;
  },
  async update(id: string, patch: Partial<typeof automations.$inferInsert>): Promise<Automation | undefined> {
    await db.update(automations).set(patch).where(eq(automations.id, id));
    return this.find(id);
  },
  async delete(id: string) {
    await db.delete(automations).where(eq(automations.id, id));
  },
  activeForTenant(tenantId: string) {
    return db.select().from(automations).where(and(eq(automations.userId, tenantId), eq(automations.status, "active")));
  },
  activeDateFlows() {
    return db.select().from(automations).where(and(eq(automations.status, "active"), sql`JSON_UNQUOTE(JSON_EXTRACT(${automations.trigger}, '$.type')) = 'date'`));
  },
  /** Marks today's date-trigger run as taken (false when another server already did). */
  async claimDateRun(id: string, today: string): Promise<boolean> {
    const [res] = await db.update(automations).set({ lastDateRun: today }).where(and(eq(automations.id, id), or(isNull(automations.lastDateRun), ne(automations.lastDateRun, today))));
    return res.affectedRows === 1;
  },
  async bump(id: string, field: "enrolledCount" | "completedCount", by = 1) {
    await db.update(automations).set({ [field]: sql`${automations[field]} + ${by}` }).where(eq(automations.id, id));
  },
  /** Runs per status, per flow. */
  async runCounts(ids: string[]): Promise<Map<string, Record<string, number>>> {
    const out = new Map<string, Record<string, number>>();
    if (!ids.length) return out;
    const rows = await db.select({ id: automationRuns.automationId, status: automationRuns.status, n: count() }).from(automationRuns).where(inArray(automationRuns.automationId, ids)).groupBy(automationRuns.automationId, automationRuns.status);
    for (const r of rows) out.set(r.id, { ...(out.get(r.id) ?? {}), [r.status]: r.n });
    return out;
  },
};

export const runsRepository = {
  async find(id: string): Promise<AutomationRun | undefined> {
    const [row] = await db.select().from(automationRuns).where(eq(automationRuns.id, id)).limit(1);
    return row;
  },
  /** The contact's runs of a flow, newest first. */
  forContact(automationId: string, contactId: string) {
    return db.select().from(automationRuns).where(and(eq(automationRuns.automationId, automationId), eq(automationRuns.contactId, contactId))).orderBy(desc(automationRuns.startedAt));
  },
  async create(values: Omit<typeof automationRuns.$inferInsert, "id">): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(automationRuns).values({ ...values, id });
    return id;
  },
  async update(id: string, patch: Partial<typeof automationRuns.$inferInsert>) {
    await db.update(automationRuns).set(patch).where(eq(automationRuns.id, id));
  },
  /** Claims due runs of active flows (each claim is atomic, so servers never share a run). */
  async claimDue(limit: number, now = new Date()): Promise<AutomationRun[]> {
    const due = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(and(inArray(automationRuns.status, ["active", "waiting"]), lte(automationRuns.nextRunAt, now), or(isNull(automationRuns.lockedUntil), lt(automationRuns.lockedUntil, now)), eq(automations.status, "active")))
      .orderBy(asc(automationRuns.nextRunAt))
      .limit(limit);
    const claimed: AutomationRun[] = [];
    for (const { id } of due) {
      const [res] = await db
        .update(automationRuns)
        .set({ lockedUntil: new Date(now.getTime() + LOCK_MS) })
        .where(and(eq(automationRuns.id, id), inArray(automationRuns.status, ["active", "waiting"]), or(isNull(automationRuns.lockedUntil), lt(automationRuns.lockedUntil, now))));
      if (res.affectedRows === 1) claimed.push((await this.find(id))!);
    }
    return claimed;
  },
  async log(v: Omit<typeof automationStepLogs.$inferInsert, "id">) {
    await db.insert(automationStepLogs).values({ ...v, id: crypto.randomUUID(), detail: v.detail?.slice(0, 300) ?? null });
  },
  /** The message a send step queued for this run (its recipient row id). */
  async sentRef(runId: string, stepId: string): Promise<{ refId: string; at: Date } | null> {
    const [row] = await db
      .select({ refId: automationStepLogs.refId, at: automationStepLogs.createdAt })
      .from(automationStepLogs)
      .where(and(eq(automationStepLogs.runId, runId), eq(automationStepLogs.stepId, stepId), eq(automationStepLogs.outcome, "done")))
      .orderBy(desc(automationStepLogs.createdAt))
      .limit(1);
    return row?.refId ? { refId: row.refId, at: row.at ?? new Date() } : null;
  },
  /** Per-step outcome counts, and how many runs wait at each step. */
  async stepStats(automationId: string) {
    const [outcomes, waiting] = await Promise.all([
      db.select({ stepId: automationStepLogs.stepId, outcome: automationStepLogs.outcome, n: count() }).from(automationStepLogs).where(eq(automationStepLogs.automationId, automationId)).groupBy(automationStepLogs.stepId, automationStepLogs.outcome),
      db.select({ stepId: automationRuns.currentStepId, n: count() }).from(automationRuns).where(and(eq(automationRuns.automationId, automationId), eq(automationRuns.status, "waiting"))).groupBy(automationRuns.currentStepId),
    ]);
    const stats: Record<string, Record<string, number>> = {};
    for (const r of outcomes) stats[r.stepId] = { ...(stats[r.stepId] ?? {}), [r.outcome]: r.n };
    // A waiting run sits *after* its wait step: count it there for display.
    return { outcomes: stats, waitingAt: Object.fromEntries(waiting.filter((w) => w.stepId).map((w) => [w.stepId!, w.n])) };
  },
  recent(automationId: string, opts: { status?: string; limit?: number } = {}) {
    return db
      .select({
        id: automationRuns.id,
        contactId: automationRuns.contactId,
        contactName: contacts.name,
        contactPhone: contacts.phone,
        status: automationRuns.status,
        currentStepId: automationRuns.currentStepId,
        nextRunAt: automationRuns.nextRunAt,
        lastError: automationRuns.lastError,
        startedAt: automationRuns.startedAt,
        finishedAt: automationRuns.finishedAt,
      })
      .from(automationRuns)
      .innerJoin(contacts, eq(contacts.id, automationRuns.contactId))
      .where(and(eq(automationRuns.automationId, automationId), opts.status ? eq(automationRuns.status, opts.status) : undefined))
      .orderBy(desc(automationRuns.startedAt))
      .limit(opts.limit ?? 50);
  },
  runLog(runId: string) {
    return db.select().from(automationStepLogs).where(eq(automationStepLogs.runId, runId)).orderBy(asc(automationStepLogs.createdAt));
  },
};

/** The stored flow, validated (null when it no longer parses). */
export function parseFlow(a: Automation): AutomationInput | null {
  const parsed = automationSchema.safeParse({ name: a.name, description: a.description, trigger: a.trigger, steps: a.steps, reentry: a.reentry });
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// References: everything a flow points at must belong to the tenant
// ---------------------------------------------------------------------------

/** Throws a readable message when a step points at someone else's (or a missing) number, template, group or user. */
export async function assertOwnedRefs(tenantId: string, flow: AutomationInput): Promise<void> {
  const channelIds = new Set((await channelsRepository.listByTenant(tenantId)).map((c) => c.id));
  const groups = new Set((await groupsRepository.listByTenant(tenantId)).map((g) => g.id));
  const bad = (msg: string) => unprocessable(msg, "BAD_STEP");
  if (flow.trigger.type === "group_joined" && !groups.has(flow.trigger.groupId)) throw bad("The trigger's group doesn't exist.");
  for (const s of flatten(flow.steps)) {
    if (s.type === "send_whatsapp") {
      if (!channelIds.has(s.channelId)) throw bad("A WhatsApp step uses a number that isn't yours.");
      if (s.mode === "template") {
        const t = await templatesRepository.findById(s.templateId);
        if (!t || t.channelId !== s.channelId) throw bad("A WhatsApp step uses a template from another number.");
      }
    }
    if ((s.type === "add_to_group" || s.type === "remove_from_group") && !groups.has(s.groupId)) throw bad("A step uses a group that doesn't exist.");
    if (s.type === "condition" && s.check.kind === "contact") {
      for (const c of s.check.rules.conditions) if (c.field === "group" && !groups.has(c.value)) throw bad("A condition uses a group that doesn't exist.");
    }
    if (s.type === "notify") {
      for (const id of s.userIds) if (!(await isMember(tenantId, id))) throw bad("Notify only people on your team.");
    }
  }
}

async function isMember(tenantId: string, userId: string) {
  if (userId === tenantId) return true;
  const u = await usersRepository.findById(userId);
  return Boolean(u && u.role === "team" && u.createdBy === tenantId);
}

/** Problems that stop a flow from being switched on (shown to the user). */
export async function activationProblems(a: Automation, flow: AutomationInput): Promise<string[]> {
  const problems: string[] = [];
  if (!flow.steps.length) problems.push("Add at least one step.");
  for (const s of flatten(flow.steps)) {
    if (s.type === "send_whatsapp" && s.mode === "template") {
      const t = await templatesRepository.findById(s.templateId);
      if (!t || t.status !== "approved") problems.push(`The template${t ? ` “${t.name}”` : ""} isn't approved yet.`);
      else if ((t.bodyVariables ?? 0) > s.variables.filter((v) => v.trim()).length) problems.push(`Fill in all ${t.bodyVariables} variables of “${t.name}”.`);
    }
  }
  if (flatten(flow.steps).some((s) => s.type === "send_email")) {
    try {
      await resolveSmtp(a.userId);
    } catch {
      problems.push("Set up email sending (Email marketing → Settings) before using email steps.");
    }
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------
// Hidden campaigns for send steps
// ---------------------------------------------------------------------------

const campaignName = (a: Automation, s: Step) => `Flow: ${a.name} (${s.id})`.slice(0, 250);

/** Creates or refreshes the campaign each send step delivers through. Returns the new step → campaign map. */
export async function syncStepCampaigns(a: Automation, flow: AutomationInput): Promise<Automation["stepCampaigns"]> {
  const map = { ...(a.stepCampaigns ?? {}) };
  for (const s of flatten(flow.steps)) {
    try {
      if (s.type === "send_whatsapp" && s.mode === "template") {
        const t = await templatesRepository.findById(s.templateId);
        if (!t) continue;
        const existing = map[s.id]?.kind === "whatsapp" ? await campaignsRepository.findById(map[s.id].id) : undefined;
        const values = { name: campaignName(a, s), channelId: s.channelId, templateId: t.id, templateName: t.name, templateLanguage: t.language ?? "en_US" };
        if (existing && existing.channelId === s.channelId) await campaignsRepository.update(existing.id, { ...values, status: "running" });
        else {
          const c = await campaignsRepository.create({ ...values, createdBy: a.userId, description: "Sent by an automation flow", campaignType: "whatsapp", type: "template", apiType: "cloud_api", audienceType: "contacts", status: "running", automationId: a.id });
          map[s.id] = { kind: "whatsapp", id: c.id };
        }
      } else if (s.type === "send_email") {
        const smtp = await resolveSmtp(a.userId).catch(() => null);
        const senderName = s.senderName || smtp?.fromName || (await systemConfig.get()).siteTitle || "WooMarket360";
        const values = { name: campaignName(a, s), subject: s.subject, previewText: s.previewText ?? null, contentHtml: s.contentHtml, contentText: null, design: (s.design ?? null) as never, senderName, senderEmail: smtp?.fromEmail ?? null };
        const existing = map[s.id]?.kind === "email" ? await emailCampaignsRepository.find(map[s.id].id) : undefined;
        let id = existing?.id;
        if (existing) await emailCampaignsRepository.update(existing.id, { ...values, status: "sending" });
        else {
          id = (await emailCampaignsRepository.create({ ...values, userId: a.userId, channelId: null, targetAudience: "csv", status: "sending", trackClicks: true, delivery: { mode: "immediate", ignoreQuietHours: true }, automationId: a.id })).id;
          map[s.id] = { kind: "email", id };
        }
        const c = await emailCampaignsRepository.find(id!);
        if (c?.trackClicks) await prepareEmailLinks(c);
      } else if (s.type === "send_sms") {
        const gateway = await smsGatewayRepository.get(a.userId);
        const values = { name: campaignName(a, s), message: s.message, gateway: gateway?.provider ?? "simulator", senderId: gateway?.senderId ?? "CORTESYS", fromNumber: gateway?.fromNumber ?? null };
        const existing = map[s.id]?.kind === "sms" ? await smsCampaignsRepository.find(map[s.id].id) : undefined;
        let id = existing?.id;
        if (existing) await smsCampaignsRepository.update(existing.id, { ...values, status: "sending" });
        else {
          id = (await smsCampaignsRepository.create({ ...values, userId: a.userId, channelId: null, targetAudience: "csv", status: "sending", trackClicks: true, delivery: { mode: "immediate", ignoreQuietHours: true }, automationId: a.id })).id;
          map[s.id] = { kind: "sms", id };
        }
        const c = await smsCampaignsRepository.find(id!);
        if (c?.trackClicks) await prepareSmsLinks(c);
      }
    } catch (err) {
      log.warn({ automationId: a.id, stepId: s.id, err: (err as Error).message }, "Couldn't prepare a step's campaign");
    }
  }
  return map;
}

/** Stops the hidden campaigns (flow deleted): queued messages are cancelled. */
export async function retireStepCampaigns(a: Automation) {
  for (const ref of Object.values(a.stepCampaigns ?? {})) {
    if (ref.kind === "whatsapp") {
      await campaignsRepository.update(ref.id, { status: "completed", completedAt: new Date() });
      await queueRepository.setStatusForCampaign(ref.id, ["queued", "paused"], "cancelled");
    } else if (ref.kind === "email") {
      await emailCampaignsRepository.update(ref.id, { status: "sent", sentAt: new Date() });
      await emailCampaignsRepository.setPendingStatus(ref.id, "cancelled");
    } else {
      await smsCampaignsRepository.update(ref.id, { status: "sent", sentAt: new Date() });
      await smsCampaignsRepository.setPendingStatus(ref.id, "cancelled");
    }
  }
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/** Contact's tenant (its channel's owner). */
async function tenantOfContact(c: Contact): Promise<string | null> {
  if (c.tenantId) return c.tenantId;
  return c.channelId ? ((await channelsRepository.findById(c.channelId))?.createdBy ?? null) : null;
}

export type EnrolResult = "enrolled" | "already_in" | "not_again" | "no_contact";

/** Starts a run for the contact unless re-entry rules say no. */
export async function enrol(a: Automation, contactId: string, context: Record<string, unknown> = {}): Promise<EnrolResult> {
  const contact = await contactsRepository.findById(contactId);
  if (!contact || (await tenantOfContact(contact)) !== a.userId) return "no_contact";
  const flow = parseFlow(a);
  if (!flow) return "no_contact";
  const previous = await runsRepository.forContact(a.id, contactId);
  if (previous.some((r) => r.status === "active" || r.status === "waiting")) return "already_in";
  if (previous.length && a.reentry === "never") return "not_again";
  const first = flow.steps[0] ?? null;
  const now = new Date();
  await runsRepository.create({ automationId: a.id, userId: a.userId, contactId, status: first ? "active" : "completed", currentStepId: first?.id ?? null, nextRunAt: now, context, finishedAt: first ? null : now });
  await automationsRepository.bump(a.id, "enrolledCount");
  if (!first) await automationsRepository.bump(a.id, "completedCount");
  wakeWork("automations");
  return "enrolled";
}

/** Enrols many contacts (manual enrolment, date triggers); returns how many started. */
export async function enrolMany(a: Automation, contactIds: string[], context: Record<string, unknown>): Promise<{ enrolled: number; skipped: number }> {
  let enrolled = 0;
  for (const id of contactIds.slice(0, MAX_BULK_ENROL)) if ((await enrol(a, id, context)) === "enrolled") enrolled++;
  return { enrolled, skipped: Math.min(contactIds.length, MAX_BULK_ENROL) - enrolled };
}

// Active flows per tenant, cached briefly (events are frequent; flows rarely change).
const flowCache = new Map<string, { at: number; flows: Automation[] }>();
const CACHE_MS = 30_000;
export function invalidateFlowCache(tenantId: string) {
  flowCache.delete(tenantId);
}
async function activeFlows(tenantId: string): Promise<Automation[]> {
  const hit = flowCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.flows;
  const flows = await automationsRepository.activeForTenant(tenantId);
  flowCache.set(tenantId, { at: Date.now(), flows });
  return flows;
}

const EVENT_TRIGGERS: Partial<Record<WebhookEvent, AutomationTrigger["type"][]>> = {
  "contact.created": ["contact_created", "tag_added", "group_joined"],
  "contact.updated": ["tag_added", "group_joined"],
  "message.received": ["message_received"],
};

interface EventContact {
  id?: string | null;
  source?: string | null;
  tags?: string[];
  groups?: string[];
}

/** Which flows an event starts (pure, for tests). */
export function flowsForEvent(flows: { id: string; trigger: unknown }[], event: WebhookEvent, data: Record<string, unknown>): string[] {
  const contact = (data.contact ?? {}) as EventContact;
  const created = event === "contact.created";
  const tagsAdded = created ? (contact.tags ?? []) : ((data.tagsAdded as string[] | undefined) ?? []);
  const groupsAdded = created ? (contact.groups ?? []) : ((data.groupsAdded as string[] | undefined) ?? []);
  return flows
    .filter((f) => {
      const t = f.trigger as AutomationTrigger;
      switch (t.type) {
        case "contact_created":
          return created && (t.sources as string[]).includes(contact.source ?? "manual");
        case "tag_added":
          return tagsAdded.some((x) => x.toLowerCase() === t.tag.toLowerCase());
        case "group_joined":
          return groupsAdded.includes(t.groupId);
        case "message_received":
          return event === "message.received" && (!t.keywords.length || keywordMatches({ type: "keyword", keywords: t.keywords, match: "contains" }, String(data.text ?? "")));
        default:
          return false;
      }
    })
    .map((f) => f.id);
}

async function handleEvent(tenantId: string, event: WebhookEvent, data: Record<string, unknown>) {
  if (!EVENT_TRIGGERS[event]) return;
  const contactId = ((data.contact ?? {}) as EventContact).id;
  if (!contactId) return;
  const flows = await activeFlows(tenantId);
  if (!flows.length) return;
  for (const id of flowsForEvent(flows, event, data)) {
    const a = flows.find((f) => f.id === id)!;
    const r = await enrol(a, contactId, { event, ...(event === "message.received" ? { text: String(data.text ?? "").slice(0, 500) } : {}) });
    if (r === "enrolled") log.info({ automationId: a.id, contactId, event }, "Contact enrolled");
  }
}

onEvent({
  on: (tenantId, event, data) => void handleEvent(tenantId, event, data).catch((err) => log.warn({ event, err: (err as Error).message }, "Automation trigger failed")),
  listens: async (tenantId, event) => {
    const types = EVENT_TRIGGERS[event];
    if (!types) return false;
    return (await activeFlows(tenantId)).some((f) => types.includes((f.trigger as AutomationTrigger).type));
  },
});

// ---------------------------------------------------------------------------
// Date triggers (cron)
// ---------------------------------------------------------------------------

async function tenantZone(tenantId: string) {
  return (await tenantSettingsRepository.getSending(tenantId)).timezone || "UTC";
}

/** Enrols the contacts whose date is today, once per day per flow, at the flow's local time. */
export async function runDateTriggers(now = new Date()): Promise<number> {
  let total = 0;
  for (const a of await automationsRepository.activeDateFlows()) {
    const t = a.trigger as Extract<AutomationTrigger, { type: "date" }>;
    const p = zonedParts(now, await tenantZone(a.userId));
    const today = ymd(p);
    const local = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    if (a.lastDateRun === today || local < t.time) continue;
    if (!(await automationsRepository.claimDateRun(a.id, today))) continue;
    const channelIds = (await channelsRepository.listByTenant(a.userId)).map((c) => c.id);
    if (!channelIds.length) continue;
    const rows = await db
      .select({ id: contacts.id, createdAt: contacts.createdAt, metadata: contacts.metadata })
      .from(contacts)
      .where(and(inArray(contacts.channelId, channelIds), eq(contacts.status, "active"), t.field === "created_at" ? undefined : sql`JSON_EXTRACT(${contacts.metadata}, ${`$.${t.field}`}) IS NOT NULL`))
      .limit(200_000);
    const due = rows.filter((r) => dateMatches(t.field === "created_at" ? r.createdAt?.toISOString().slice(0, 10) : r.metadata?.[t.field], today, t.offsetDays, t.yearly)).map((r) => r.id);
    const { enrolled } = await enrolMany(a, due, { event: "date", date: today });
    total += enrolled;
    log.info({ automationId: a.id, today, matched: due.length, enrolled }, "Date trigger ran");
  }
  return total;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

interface StepResult {
  outcome: StepOutcome;
  detail?: string;
  refId?: string | null;
  /** Wait steps: when to continue. */
  until?: Date;
  /** End the run here. */
  end?: boolean;
}

const mergeValues = (c: Contact) => ({ name: c.name, phone: c.phone, email: c.email ?? "", fields: (c.metadata ?? {}) as Record<string, string> });

/** Processes due runs; returns how many were handled. */
export async function processDueRuns(limit = 25, concurrency = 5): Promise<number> {
  const runs = await runsRepository.claimDue(limit);
  for (let i = 0; i < runs.length; i += concurrency) {
    await Promise.all(runs.slice(i, i + concurrency).map((r) => advanceRun(r).catch((err) => log.error({ runId: r.id, err: (err as Error).message }, "Run crashed"))));
  }
  return runs.length;
}

async function finish(run: AutomationRun, status: "completed" | "exited" | "failed", error?: string) {
  await runsRepository.update(run.id, { status, currentStepId: null, nextRunAt: null, lockedUntil: null, finishedAt: new Date(), lastError: error?.slice(0, 500) ?? null });
  if (status === "completed") await automationsRepository.bump(run.automationId, "completedCount");
}

/** Moves one run forward until it waits, ends, or has taken MAX_STEPS_PER_PASS steps. */
export async function advanceRun(run: AutomationRun, now = new Date()): Promise<void> {
  const a = await automationsRepository.find(run.automationId);
  const flow = a ? parseFlow(a) : null;
  if (!a || !flow) return finish(run, "failed", "The flow is no longer valid");
  let contact = await contactsRepository.findById(run.contactId);
  if (!contact) return finish(run, "exited", "The contact was deleted");
  let stepId = run.currentStepId;
  for (let n = 0; n < MAX_STEPS_PER_PASS; n++) {
    if (!stepId) return finish(run, "completed");
    const step = findStep(flow.steps, stepId);
    if (!step) return finish(run, "exited", "The step was removed from the flow");
    let r: StepResult;
    try {
      r = await executeStep(a, run, contact, step, now);
    } catch (err) {
      r = { outcome: "failed", detail: (err as Error).message };
    }
    await runsRepository.log({ runId: run.id, automationId: a.id, stepId: step.id, outcome: r.outcome, detail: r.detail ?? null, refId: r.refId ?? null });
    if (r.end) return finish(run, "completed");
    const next = step.type === "condition" ? enterBranch(flow.steps, step, r.outcome === "yes") : nextAfter(flow.steps, step.id);
    if (r.until) {
      await runsRepository.update(run.id, { status: "waiting", currentStepId: next?.id ?? null, nextRunAt: r.until, lockedUntil: null });
      return;
    }
    stepId = next?.id ?? null;
    // Later steps see the contact's updated tags, groups and fields.
    if (["add_tags", "remove_tags", "add_to_group", "remove_from_group", "update_field"].includes(step.type)) contact = (await contactsRepository.findById(contact.id)) ?? contact;
  }
  await runsRepository.update(run.id, { status: "active", currentStepId: stepId, nextRunAt: new Date(), lockedUntil: null });
}

async function executeStep(a: Automation, run: AutomationRun, c: Contact, s: Step, now: Date): Promise<StepResult> {
  switch (s.type) {
    case "wait":
      return { outcome: "done", until: waitUntil(s, now, await tenantZone(a.userId)) };
    case "condition":
      return { outcome: (await evaluate(run, c, s.check)) ? "yes" : "no" };
    case "exit":
      return { outcome: "done", end: true };
    case "send_whatsapp":
      return s.mode === "template" ? queueWhatsapp(a, c, s) : sendWhatsappText(a, c, s);
    case "send_email":
      return queueEmail(a, c, s);
    case "send_sms":
      return queueSms(a, c, s);
    case "add_tags":
    case "remove_tags": {
      const before = c.tags ?? [];
      const lower = (t: string) => t.toLowerCase();
      const tags = s.type === "add_tags" ? [...before, ...s.tags.filter((t) => !before.map(lower).includes(lower(t)))] : before.filter((t) => !s.tags.map(lower).includes(lower(t)));
      if (tags.length === before.length && tags.every((t, i) => t === before[i])) return { outcome: "skipped", detail: "Nothing to change" };
      const updated = await contactsRepository.update(c.id, { tags });
      const added = tags.filter((t) => !before.includes(t));
      if (updated) emitForChannel(updated.channelId, "contact.updated", { contact: contactData(updated), changed: ["tags"], tagsAdded: added, groupsAdded: [] });
      return { outcome: "done", detail: s.tags.join(", ") };
    }
    case "add_to_group":
    case "remove_from_group": {
      const before = c.groups ?? [];
      const has = before.includes(s.groupId);
      if ((s.type === "add_to_group") === has) return { outcome: "skipped", detail: has ? "Already in the group" : "Not in the group" };
      const groups = s.type === "add_to_group" ? [...before, s.groupId] : before.filter((g) => g !== s.groupId);
      const updated = await contactsRepository.update(c.id, { groups });
      if (updated) emitForChannel(updated.channelId, "contact.updated", { contact: contactData(updated), changed: ["groups"], tagsAdded: [], groupsAdded: s.type === "add_to_group" ? [s.groupId] : [] });
      return { outcome: "done" };
    }
    case "update_field": {
      const value = renderMergeTags(s.value, mergeValues(c)).slice(0, 500);
      const metadata = { ...((c.metadata ?? {}) as Record<string, string>) };
      if (value) metadata[s.key] = value;
      else delete metadata[s.key];
      const updated = await contactsRepository.update(c.id, { metadata });
      if (updated) emitForChannel(updated.channelId, "contact.updated", { contact: contactData(updated), changed: ["fields"], tagsAdded: [], groupsAdded: [] });
      return { outcome: "done", detail: `${s.key} = ${value || "(cleared)"}` };
    }
    case "notify": {
      const message = renderMergeTags(s.message, mergeValues(c));
      const targets = s.userIds.length ? s.userIds : [a.userId];
      await sendNotification({ title: `${a.name}: ${c.name}`.slice(0, 200), message, type: "general", targetType: "users", targetIds: targets, viaInApp: true, viaEmail: false }, a.userId);
      return { outcome: "done", detail: `${targets.length} teammate${targets.length === 1 ? "" : "s"}` };
    }
    case "webhook":
      return callWebhook(a, run, c, s.url);
  }
}

// --- Conditions -------------------------------------------------------------

export async function evaluate(run: AutomationRun, c: Contact, check: Check): Promise<boolean> {
  if (check.kind === "contact") {
    const [row] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, c.id), compileRules(check.rules))).limit(1);
    return Boolean(row);
  }
  const a = await automationsRepository.find(run.automationId);
  const kind = a?.stepCampaigns?.[check.stepId]?.kind;
  const sent = await runsRepository.sentRef(run.id, check.stepId);
  if (!sent || !kind) return false;
  if (kind === "whatsapp") {
    const [r] = await db.select().from(campaignRecipients).where(eq(campaignRecipients.id, sent.refId)).limit(1);
    if (!r) return false;
    const st = r.status ?? "";
    if (check.event === "failed") return st === "failed";
    if (check.event === "delivered") return Boolean(r.deliveredAt) || ["delivered", "read", "replied"].includes(st);
    if (check.event === "read") return Boolean(r.readAt) || ["read", "replied"].includes(st);
    if (check.event === "replied") {
      // Any message from the contact after the send counts as a reply.
      const [m] = await db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(eq(conversations.contactId, c.id), eq(messages.direction, "inbound"), gt(messages.createdAt, sent.at)))
        .limit(1);
      return Boolean(m) || st === "replied";
    }
    return false;
  }
  if (kind === "email") {
    const [r] = await db.select().from(emailCampaignRecipients).where(eq(emailCampaignRecipients.id, sent.refId)).limit(1);
    if (!r) return false;
    if (check.event === "opened") return Boolean(r.openedAt || r.clickedAt);
    if (check.event === "clicked") return Boolean(r.clickedAt);
    if (check.event === "failed") return ["failed", "bounced", "complained"].includes(r.status ?? "");
    return false;
  }
  const [r] = await db.select().from(smsCampaignRecipients).where(eq(smsCampaignRecipients.id, sent.refId)).limit(1);
  if (!r) return false;
  if (check.event === "delivered") return Boolean(r.deliveredAt) || r.status === "delivered";
  if (check.event === "clicked") return Boolean(r.clickedAt);
  if (check.event === "failed") return r.status === "failed";
  return false;
}

// --- Sends ------------------------------------------------------------------

function stepCampaign(a: Automation, s: Step, kind: SendKind): string | null {
  const ref = a.stepCampaigns?.[s.id];
  return ref?.kind === kind ? ref.id : null;
}

async function queueWhatsapp(a: Automation, c: Contact, s: Extract<Step, { type: "send_whatsapp"; mode: "template" }>): Promise<StepResult> {
  if (c.status !== "active") return { outcome: "skipped", detail: `Contact is ${c.status}` };
  if (c.channelId !== s.channelId) return { outcome: "skipped", detail: "The contact belongs to another WhatsApp number" };
  const campaignId = stepCampaign(a, s, "whatsapp");
  const template = await templatesRepository.findById(s.templateId);
  if (!campaignId || !template) return { outcome: "failed", detail: "The step's template is missing" };
  if (template.status !== "approved") return { outcome: "failed", detail: `Template “${template.name}” isn't approved` };
  await assertMessageQuota(a.userId, 1);
  const params = s.variables.slice(0, template.bodyVariables ?? 0).map((v) => renderMergeTags(v, mergeValues(c)).trim() || "-");
  // One recipient row per contact per step: a contact going through the flow again reuses it.
  await db
    .insert(campaignRecipients)
    .values({ id: crypto.randomUUID(), campaignId, contactId: c.id, phone: c.phone, name: c.name, status: "pending", templateParams: Object.fromEntries(params.map((p, i) => [String(i + 1), p])) })
    .onDuplicateKeyUpdate({ set: { status: "pending", contactId: c.id, sentAt: null, deliveredAt: null, readAt: null, errorCode: null, errorMessage: null, whatsappMessageId: null, templateParams: Object.fromEntries(params.map((p, i) => [String(i + 1), p])) } });
  const [rec] = await db.select({ id: campaignRecipients.id }).from(campaignRecipients).where(and(eq(campaignRecipients.campaignId, campaignId), eq(campaignRecipients.phone, c.phone))).limit(1);
  await db.update(campaigns).set({ recipientCount: sql`${campaigns.recipientCount} + 1` }).where(eq(campaigns.id, campaignId));
  await queueRepository.enqueue([{ campaignId, channelId: s.channelId, recipientPhone: c.phone, templateName: template.name, templateLanguage: template.language ?? "en_US", templateParams: params, messageType: "template", status: "queued", scheduledFor: null }]);
  await templatesRepository.incrementUsage(template.id);
  wakeWork("whatsapp");
  return { outcome: "done", detail: `Template ${template.name}`, refId: rec?.id ?? null };
}

/** Free-form WhatsApp text: only inside the 24-hour window after the contact's last message. */
async function sendWhatsappText(a: Automation, c: Contact, s: Extract<Step, { type: "send_whatsapp"; mode: "text" }>): Promise<StepResult> {
  if (c.status !== "active") return { outcome: "skipped", detail: `Contact is ${c.status}` };
  if (c.channelId !== s.channelId) return { outcome: "skipped", detail: "The contact belongs to another WhatsApp number" };
  const channel = await channelsRepository.findById(s.channelId);
  if (!channel) return { outcome: "failed", detail: "WhatsApp number not found" };
  const conv = await conversationsRepository.findByChannelAndPhone(channel.id, c.phone);
  const last = conv?.lastIncomingMessageAt?.getTime();
  if (!conv || !last || Date.now() - last > 24 * 3_600_000) return { outcome: "skipped", detail: "Outside the 24-hour window (use a template instead)" };
  await assertMessageQuota(a.userId, 1);
  const text = renderMergeTags(s.text, mergeValues(c));
  const { messageId } = await whatsappFactory.create(channel).sendText(c.phone, text);
  const now = new Date();
  const { conversation } = await findOrCreateConversation(channel, c);
  const message = await messagesRepository.create({ conversationId: conversation.id, whatsappMessageId: messageId, fromUser: false, direction: "outbound", content: text, type: "text", fromType: "automation", messageType: "text", status: "sent", timestamp: now, metadata: { automationId: a.id, automationName: a.name } });
  await conversationsRepository.recordMessage(conversation.id, { text, at: now, inbound: false });
  realtime.toChannel(channel.id, "new_message", { conversationId: conversation.id, message });
  return { outcome: "done", detail: "Text message" };
}

async function queueEmail(a: Automation, c: Contact, s: Extract<Step, { type: "send_email" }>): Promise<StepResult> {
  const email = c.email?.trim().toLowerCase();
  if (!email) return { outcome: "skipped", detail: "No email address" };
  if (c.status !== "active") return { outcome: "skipped", detail: `Contact is ${c.status}` };
  if ((await suppressionsRepository.filter(a.userId, [email])).size) return { outcome: "skipped", detail: "Email is on the suppression list" };
  const campaignId = stepCampaign(a, s, "email");
  if (!campaignId) return { outcome: "failed", detail: "The step isn't ready (email sending may not be set up)" };
  await assertMessageQuota(a.userId, 1);
  const id = crypto.randomUUID();
  await db.insert(emailCampaignRecipients).values({ id, campaignId, contactId: c.id, email, name: c.name, status: "pending" });
  await db.update(emailCampaigns).set({ totalRecipients: sql`${emailCampaigns.totalRecipients} + 1`, status: "sending" }).where(eq(emailCampaigns.id, campaignId));
  wakeWork("marketing");
  return { outcome: "done", detail: email, refId: id };
}

async function queueSms(a: Automation, c: Contact, s: Extract<Step, { type: "send_sms" }>): Promise<StepResult> {
  if (c.status !== "active") return { outcome: "skipped", detail: `Contact is ${c.status}` };
  const campaignId = stepCampaign(a, s, "sms");
  if (!campaignId) return { outcome: "failed", detail: "The step isn't ready" };
  await assertMessageQuota(a.userId, 1);
  const id = crypto.randomUUID();
  const phone = c.phone.startsWith("+") ? c.phone : `+${c.phone}`;
  await db.insert(smsCampaignRecipients).values({ id, campaignId, contactId: c.id, phone, name: c.name, status: "pending" });
  await db.update(smsCampaigns).set({ totalRecipients: sql`${smsCampaigns.totalRecipients} + 1`, status: "sending" }).where(eq(smsCampaigns.id, campaignId));
  wakeWork("marketing");
  return { outcome: "done", detail: phone, refId: id };
}

async function callWebhook(a: Automation, run: AutomationRun, c: Contact, url: string): Promise<StepResult> {
  const target = await assertSafeUrl(url);
  const body = JSON.stringify({ event: "automation.step", automation: { id: a.id, name: a.name }, run: { id: run.id, startedAt: run.startedAt }, contact: contactData(c), sentAt: new Date().toISOString() });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "WooMarket360-Automations/1.0" }, body, signal: ctl.signal, redirect: "manual" });
    return res.ok ? { outcome: "done", detail: `HTTP ${res.status}` } : { outcome: "failed", detail: `HTTP ${res.status}` };
  } catch (err) {
    return { outcome: "failed", detail: (err as Error).name === "AbortError" ? "Timed out" : (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class AutomationWorker {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;

  start(intervalMs = 3000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), intervalMs);
    log.info({ intervalMs }, "Automation worker started");
  }

  wake() {
    if (!this.timer || this.current) return;
    this.current = this.tick()
      .catch((err) => log.error({ err: (err as Error).message }, "Automation tick failed"))
      .finally(() => (this.current = null));
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.current;
  }

  /** Works through due runs until none are left (or a time budget runs out). */
  async tick(): Promise<number> {
    let total = 0;
    const started = Date.now();
    for (;;) {
      const n = await processDueRuns();
      total += n;
      if (n === 0 || Date.now() - started > 20_000) return total;
    }
  }
}

export const automationWorker = new AutomationWorker();
