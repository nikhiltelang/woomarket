/**
 * Dynamic segments: compiles saved rules into one SQL condition on `contacts`, so a
 * segment is re-evaluated (and stays current) every time a campaign or preview uses it.
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { segmentRulesSchema, type SegmentCondition, type SegmentRules } from "@shared/segments";
import { contacts, conversations, emailCampaignRecipients, messages, segments, smsCampaignRecipients, type Segment } from "@shared/schema";
import { db } from "../db";
import { notFound, unprocessable } from "../lib/errors";
import { groupsRepository } from "../repositories/groups.repository";

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const startOfDay = (d: string) => new Date(`${d}T00:00:00.000Z`);
const nextDay = (d: string) => new Date(startOfDay(d).getTime() + 86_400_000);
const isNumeric = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim());

/** Conditions on a text expression (a column, or a custom field read out of `metadata`). */
function textCondition(col: SQL, op: string, value: string): SQL {
  switch (op) {
    case "eq":
      return sql`${col} = ${value}`;
    case "neq":
      return sql`(${col} IS NULL OR ${col} <> ${value})`;
    case "contains":
      return sql`${col} LIKE ${`%${escapeLike(value)}%`}`;
    case "not_contains":
      return sql`(${col} IS NULL OR ${col} NOT LIKE ${`%${escapeLike(value)}%`})`;
    case "starts_with":
      return sql`${col} LIKE ${`${escapeLike(value)}%`}`;
    case "is_set":
      return sql`(${col} IS NOT NULL AND ${col} <> '')`;
    case "is_not_set":
      return sql`(${col} IS NULL OR ${col} = '')`;
    case "gt":
    case "lt": {
      const cmp = sql.raw(op === "gt" ? ">" : "<");
      // Numbers compare numerically; anything else (e.g. ISO dates) as text.
      return isNumeric(value) ? sql`(${col} REGEXP '^-?[0-9]+(\\.[0-9]+)?$' AND CAST(${col} AS DECIMAL(20,6)) ${cmp} ${Number(value)})` : sql`${col} ${cmp} ${value}`;
    }
  }
  throw unprocessable(`Unsupported operator “${op}”`);
}

function dateCondition(col: SQL, op: string, value: number | string): SQL {
  if (op === "within_days") return sql`${col} >= ${daysAgo(Number(value))}`;
  if (op === "older_than_days") return sql`${col} < ${daysAgo(Number(value))}`;
  const day = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw unprocessable("Use a date like 2026-01-31");
  return op === "before" ? sql`${col} < ${startOfDay(day)}` : sql`${col} >= ${nextDay(day)}`;
}

function engagementCondition(op: string, days: number): SQL {
  const since = daysAgo(days);
  const e = emailCampaignRecipients;
  const s = smsCampaignRecipients;
  const opened = sql`EXISTS (SELECT 1 FROM ${e} WHERE ${e.contactId} = ${contacts.id} AND ${e.openedAt} >= ${since})`;
  const replied = sql`EXISTS (SELECT 1 FROM ${messages} JOIN ${conversations} ON ${conversations.id} = ${messages.conversationId}
    WHERE ${messages.direction} = 'inbound' AND ${messages.createdAt} >= ${since}
      AND (${conversations.contactId} = ${contacts.id} OR (${conversations.channelId} = ${contacts.channelId} AND ${conversations.contactPhone} = ${contacts.phone})))`;
  switch (op) {
    case "email_opened":
      return opened;
    case "email_not_opened":
      return sql`NOT ${opened}`;
    case "email_clicked":
      return sql`EXISTS (SELECT 1 FROM ${e} WHERE ${e.contactId} = ${contacts.id} AND ${e.clickedAt} >= ${since})`;
    case "sms_clicked":
      return sql`EXISTS (SELECT 1 FROM ${s} WHERE ${s.contactId} = ${contacts.id} AND ${s.clickedAt} >= ${since})`;
    case "whatsapp_replied":
      return replied;
    case "whatsapp_not_replied":
      return sql`NOT ${replied}`;
  }
  throw unprocessable(`Unsupported engagement “${op}”`);
}

export function compileCondition(c: SegmentCondition): SQL {
  switch (c.field) {
    case "name":
      return textCondition(sql`${contacts.name}`, c.op, c.value);
    case "email":
      return textCondition(sql`${contacts.email}`, c.op, c.value);
    case "phone":
      return textCondition(sql`${contacts.phone}`, c.op, c.value);
    case "source":
      return textCondition(sql`${contacts.source}`, c.op, c.value);
    case "status":
      return c.op === "eq" ? sql`${contacts.status} = ${c.value}` : sql`(${contacts.status} IS NULL OR ${contacts.status} <> ${c.value})`;
    case "tag": {
      const has = sql`JSON_CONTAINS(COALESCE(${contacts.tags}, JSON_ARRAY()), JSON_QUOTE(${c.value}))`;
      return c.op === "has" ? has : sql`NOT ${has}`;
    }
    case "group": {
      const inGroup = sql`JSON_CONTAINS(COALESCE(${contacts.groups}, JSON_ARRAY()), JSON_QUOTE(${c.value}))`;
      return c.op === "in" ? inGroup : sql`NOT ${inGroup}`;
    }
    case "created_at":
      return dateCondition(sql`${contacts.createdAt}`, c.op, c.value);
    case "last_contact": {
      // "More than N days ago" includes contacts never contacted.
      const cond = dateCondition(sql`${contacts.lastContact}`, c.op, c.value);
      return c.op === "older_than_days" || c.op === "before" ? sql`(${contacts.lastContact} IS NULL OR ${cond})` : cond;
    }
    case "custom": {
      // The key is validated against ^[a-z][a-z0-9_]{0,49}$, so it is safe inside the JSON path.
      if (!/^[a-z][a-z0-9_]{0,49}$/.test(c.key)) throw unprocessable("Invalid custom field name");
      const raw = sql`JSON_UNQUOTE(JSON_EXTRACT(${contacts.metadata}, ${`$."${c.key}"`}))`;
      // JSON values compare case-sensitively (utf8mb4_bin); lower both sides so "pune" matches "Pune" like the regular columns do.
      if (c.op === "gt" || c.op === "lt") return textCondition(raw, c.op, c.value);
      return textCondition(sql`LOWER(${raw})`, c.op, c.value.toLowerCase());
    }
    case "engagement":
      return engagementCondition(c.op, c.value);
  }
}

/** One SQL condition for the whole rule set. */
export function compileRules(rules: SegmentRules): SQL {
  const parts = rules.conditions.map((c) => sql`(${compileCondition(c)})`);
  return sql`(${sql.join(parts, sql.raw(rules.match === "any" ? " OR " : " AND "))})`;
}

/** Parses stored or submitted rules, and checks every group belongs to the tenant. */
export async function validateRules(tenantId: string, raw: unknown): Promise<SegmentRules> {
  const parsed = segmentRulesSchema.safeParse(raw);
  if (!parsed.success) throw unprocessable(parsed.error.issues[0]?.message ?? "Invalid segment rules");
  const groupIds = [...new Set(parsed.data.conditions.filter((c) => c.field === "group").map((c) => String(c.value)))];
  if (groupIds.length) {
    const own = new Set((await groupsRepository.listByTenant(tenantId)).map((g) => g.id));
    if (groupIds.some((g) => !own.has(g))) throw unprocessable("A condition uses a group that doesn't exist");
  }
  return parsed.data;
}

export async function loadSegment(tenantId: string, id: string): Promise<Segment> {
  const [row] = await db.select().from(segments).where(and(eq(segments.id, id), eq(segments.userId, tenantId))).limit(1);
  if (!row) throw notFound("Segment");
  return row;
}

/** The SQL condition for a stored segment, re-validated (groups may have been deleted since). */
export async function segmentCondition(tenantId: string, segmentId: string): Promise<SQL> {
  const s = await loadSegment(tenantId, segmentId);
  return compileRules(await validateRules(tenantId, s.rules));
}

export interface SegmentPreview {
  count: number;
  active: number;
  sample: { id: string; name: string; phone: string; email: string | null; status: string | null; createdAt: Date | null }[];
}

/** How many contacts of a channel match, and the most recent few. */
export async function previewRules(channelId: string, rules: SegmentRules, sampleSize = 10): Promise<SegmentPreview> {
  const where = and(eq(contacts.channelId, channelId), compileRules(rules));
  const [[totals], sample] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)`, active: sql<number>`COALESCE(SUM(${contacts.status} = 'active'), 0)` }).from(contacts).where(where),
    db
      .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, email: contacts.email, status: contacts.status, createdAt: contacts.createdAt })
      .from(contacts)
      .where(where)
      .orderBy(desc(contacts.createdAt))
      .limit(sampleSize),
  ]);
  return { count: Number(totals?.count ?? 0), active: Number(totals?.active ?? 0), sample };
}

export const segmentsRepository = {
  list(tenantId: string) {
    return db.select().from(segments).where(eq(segments.userId, tenantId)).orderBy(desc(segments.updatedAt));
  },
  async create(values: typeof segments.$inferInsert) {
    const id = crypto.randomUUID();
    await db.insert(segments).values({ ...values, id });
    return (await db.select().from(segments).where(eq(segments.id, id)))[0];
  },
  async update(id: string, patch: Partial<typeof segments.$inferInsert>) {
    await db.update(segments).set(patch).where(eq(segments.id, id));
    return (await db.select().from(segments).where(eq(segments.id, id)))[0];
  },
  async delete(id: string) {
    await db.delete(segments).where(eq(segments.id, id));
  },
  async saveCount(id: string, count: number) {
    await db.update(segments).set({ lastCount: count, lastCountedAt: new Date() }).where(eq(segments.id, id));
  },
};
