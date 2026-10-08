/**
 * Automation flows: a trigger enrols a contact, then the steps run in order: messages on
 * WhatsApp / email / SMS, waits, yes/no conditions (each branch is its own list of steps, after
 * which the flow continues below the condition), tags, groups, fields, team notifications and
 * webhooks. The tree helpers here are shared by the builder and the engine.
 */
import { z } from "zod";
import { segmentRulesSchema } from "./segments";
import { nextLocalTime, zonedParts } from "./sending";

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const CONTACT_SOURCES = ["manual", "import", "api", "whatsapp", "widget"] as const;
export const SOURCE_LABELS: Record<(typeof CONTACT_SOURCES)[number], string> = { manual: "Added by hand", import: "CSV import", api: "API", whatsapp: "Incoming WhatsApp message", widget: "Website chat" };

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, "Use a custom field key like birthday");

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contact_created"), sources: z.array(z.enum(CONTACT_SOURCES)).min(1, "Pick at least one source").default(["manual", "api", "whatsapp", "widget"]) }),
  z.object({ type: z.literal("tag_added"), tag: z.string().trim().min(1, "Enter the tag").max(50) }),
  z.object({ type: z.literal("group_joined"), groupId: z.string().uuid("Pick a group") }),
  z.object({ type: z.literal("message_received"), keywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]) }),
  z.object({
    type: z.literal("date"),
    /** "created_at" or a custom field holding a date (YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY). */
    field: z.union([z.literal("created_at"), fieldKey]),
    /** Days before (negative) or after the date. */
    offsetDays: z.coerce.number().int().min(-60).max(60).default(0),
    /** Every year on the anniversary (birthdays), or only on the exact date. */
    yearly: z.boolean().default(true),
    /** Local time (tenant time zone) to enrol at. */
    time: hm.default("09:00"),
  }),
  z.object({ type: z.literal("manual") }),
]);
export type AutomationTrigger = z.infer<typeof triggerSchema>;
export type TriggerType = AutomationTrigger["type"];

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  contact_created: "A contact is added",
  tag_added: "A tag is added to a contact",
  group_joined: "A contact joins a group",
  message_received: "A contact sends a WhatsApp message",
  date: "A date (birthday, anniversary…)",
  manual: "Only when contacts are added by hand",
};

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const stepId = z.string().regex(/^[a-z0-9_-]{4,40}$/i);
const mergeText = (max: number) => z.string().trim().min(1, "Required").max(max);

export const CONDITION_EVENTS = ["delivered", "read", "opened", "clicked", "replied", "failed"] as const;
export type ConditionEvent = (typeof CONDITION_EVENTS)[number];
/** Which engagement each send step can be checked for. */
export const EVENTS_BY_STEP: Record<"send_whatsapp" | "send_email" | "send_sms", ConditionEvent[]> = {
  send_whatsapp: ["delivered", "read", "replied", "failed"],
  send_email: ["opened", "clicked", "failed"],
  send_sms: ["delivered", "clicked", "failed"],
};
export const EVENT_LABELS: Record<ConditionEvent, string> = { delivered: "was delivered", read: "was read", opened: "was opened", clicked: "had a link clicked", replied: "got a reply", failed: "failed" };

export const checkSchema = z.discriminatedUnion("kind", [
  /** The contact matches segment-style rules (tags, groups, fields, engagement…). */
  z.object({ kind: z.literal("contact"), rules: segmentRulesSchema }),
  /** Engagement with a message an earlier step of this flow sent. */
  z.object({ kind: z.literal("step"), stepId, event: z.enum(CONDITION_EVENTS) }),
]);
export type Check = z.infer<typeof checkSchema>;

interface Base {
  id: string;
}
export type Step = Base &
  (
    | { type: "send_whatsapp"; channelId: string; mode: "template"; templateId: string; variables: string[] }
    | { type: "send_whatsapp"; channelId: string; mode: "text"; text: string }
    | { type: "send_email"; subject: string; previewText?: string | null; contentHtml: string; design?: unknown; senderName?: string | null }
    | { type: "send_sms"; message: string }
    | { type: "wait"; amount: number; unit: "minutes" | "hours" | "days"; until?: string | null; weekdaysOnly?: boolean }
    | { type: "condition"; check: Check; yes: Step[]; no: Step[] }
    | { type: "add_tags" | "remove_tags"; tags: string[] }
    | { type: "add_to_group" | "remove_from_group"; groupId: string }
    | { type: "update_field"; key: string; value: string }
    | { type: "notify"; message: string; userIds: string[] }
    | { type: "webhook"; url: string }
    | { type: "exit" }
  );
export type StepType = Step["type"];

const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    z.object({ id: stepId, type: z.literal("send_whatsapp"), channelId: z.string().uuid("Pick a WhatsApp number"), mode: z.literal("template"), templateId: z.string().uuid("Pick a template"), variables: z.array(z.string().trim().max(500)).max(20).default([]) }),
    z.object({ id: stepId, type: z.literal("send_whatsapp"), channelId: z.string().uuid("Pick a WhatsApp number"), mode: z.literal("text"), text: mergeText(4096) }),
    z.object({ id: stepId, type: z.literal("send_email"), subject: mergeText(200), previewText: z.string().trim().max(200).nullish(), contentHtml: z.string().min(1, "Write the email").max(500_000), design: z.unknown().optional(), senderName: z.string().trim().max(100).nullish() }),
    z.object({ id: stepId, type: z.literal("send_sms"), message: mergeText(1600) }),
    z.object({ id: stepId, type: z.literal("wait"), amount: z.coerce.number().int().min(1).max(365), unit: z.enum(["minutes", "hours", "days"]), until: hm.nullish(), weekdaysOnly: z.boolean().optional() }),
    z.object({ id: stepId, type: z.literal("condition"), check: checkSchema, yes: z.array(stepSchema).max(100), no: z.array(stepSchema).max(100) }),
    z.object({ id: stepId, type: z.enum(["add_tags", "remove_tags"]), tags: z.array(z.string().trim().min(1).max(50)).min(1, "Add a tag").max(10) }),
    z.object({ id: stepId, type: z.enum(["add_to_group", "remove_from_group"]), groupId: z.string().uuid("Pick a group") }),
    z.object({ id: stepId, type: z.literal("update_field"), key: fieldKey, value: z.string().trim().max(500) }),
    z.object({ id: stepId, type: z.literal("notify"), message: mergeText(500), userIds: z.array(z.string().uuid()).max(20).default([]) }),
    z.object({ id: stepId, type: z.literal("webhook"), url: z.string().trim().url("Enter a full URL").max(2000) }),
    z.object({ id: stepId, type: z.literal("exit") }),
  ]),
) as z.ZodType<Step>;

export const STEP_LABELS: Record<StepType, string> = {
  send_whatsapp: "Send WhatsApp message",
  send_email: "Send email",
  send_sms: "Send SMS",
  wait: "Wait",
  condition: "If / else",
  add_tags: "Add tags",
  remove_tags: "Remove tags",
  add_to_group: "Add to group",
  remove_from_group: "Remove from group",
  update_field: "Update a field",
  notify: "Notify the team",
  webhook: "Send to a webhook",
  exit: "End the flow",
};

export const MAX_STEPS = 200;

export const automationSchema = z
  .object({
    name: z.string().trim().min(1, "Name the flow").max(100),
    description: z.string().trim().max(500).nullish(),
    trigger: triggerSchema,
    steps: z.array(stepSchema).max(100),
    /** Whether a contact can go through the flow again once their previous run has ended. */
    reentry: z.enum(["never", "after_exit"]).default("never"),
  })
  .superRefine((a, ctx) => {
    const all = flatten(a.steps);
    if (all.length > MAX_STEPS) ctx.addIssue({ code: "custom", path: ["steps"], message: `A flow can have up to ${MAX_STEPS} steps` });
    const ids = new Set<string>();
    for (const s of all) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["steps"], message: "Step ids must be unique" });
      ids.add(s.id);
    }
    // A "did they open / reply…" check must point at a send step that runs before it.
    for (const s of all) {
      if (s.type !== "condition" || s.check.kind !== "step") continue;
      const target = all.find((x) => x.id === (s.check as { stepId: string }).stepId);
      const before = stepsBefore(a.steps, s.id);
      if (!target || !before.some((b) => b.id === target.id) || !(target.type in EVENTS_BY_STEP)) {
        ctx.addIssue({ code: "custom", path: ["steps"], message: "A condition checks a message step that doesn't come before it" });
      } else if (!EVENTS_BY_STEP[target.type as keyof typeof EVENTS_BY_STEP].includes(s.check.event)) {
        ctx.addIssue({ code: "custom", path: ["steps"], message: `“${EVENT_LABELS[s.check.event]}” can't be checked for a ${STEP_LABELS[target.type].toLowerCase()} step` });
      }
    }
  });
export type AutomationInput = z.infer<typeof automationSchema>;

export const AUTOMATION_STATUSES = ["draft", "active", "paused"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];
export const RUN_STATUSES = ["active", "waiting", "completed", "exited", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/** Every step, depth-first in display order. */
export function flatten(steps: Step[]): Step[] {
  return steps.flatMap((s) => (s.type === "condition" ? [s, ...flatten(s.yes), ...flatten(s.no)] : [s]));
}

export function findStep(steps: Step[], id: string): Step | undefined {
  return flatten(steps).find((s) => s.id === id);
}

/** The ids of the containing lists from the root down to `id` (null when not found). */
function pathTo(steps: Step[], id: string): { list: Step[]; index: number }[] | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.id === id) return [{ list: steps, index: i }];
    if (s.type === "condition") {
      for (const branch of [s.yes, s.no]) {
        const p = pathTo(branch, id);
        if (p) return [{ list: steps, index: i }, ...p];
      }
    }
  }
  return null;
}

/**
 * The step that runs after `id`: the next one in its list, or (at the end of a branch) the one
 * after the enclosing condition, and so on up. Null when the flow ends.
 */
export function nextAfter(steps: Step[], id: string): Step | null {
  const path = pathTo(steps, id);
  if (!path) return null;
  for (let level = path.length - 1; level >= 0; level--) {
    const { list, index } = path[level];
    if (index + 1 < list.length) return list[index + 1];
  }
  return null;
}

/** The first step of a branch, or what follows the condition when the branch is empty. */
export function enterBranch(steps: Step[], condition: Extract<Step, { type: "condition" }>, yes: boolean): Step | null {
  const branch = yes ? condition.yes : condition.no;
  return branch[0] ?? nextAfter(steps, condition.id);
}

/** Steps that always or possibly run before `id` (ancestors' earlier siblings and their branches). */
export function stepsBefore(steps: Step[], id: string): Step[] {
  const path = pathTo(steps, id);
  if (!path) return [];
  return path.flatMap(({ list, index }) => flatten(list.slice(0, index)));
}

export const newStepId = () => `s_${Math.random().toString(36).slice(2, 10)}`;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Month and day of a stored date ("1990-05-17", "17/05/1990", "17-05-1990"), or null. */
export function parseDateField(raw: string | null | undefined): { year: number | null; month: number; day: number } | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let r: { year: number | null; month: number; day: number } | null = null;
  if (m) r = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/))) r = { year: m[3] ? Number(m[3]) : null, month: Number(m[2]), day: Number(m[1]) };
  if (!r || r.month < 1 || r.month > 12 || r.day < 1 || r.day > 31) return null;
  return r;
}

/** Whether a contact's date (shifted by offsetDays) falls on `today` (YYYY-MM-DD in the tenant zone). */
export function dateMatches(raw: string | null | undefined, today: string, offsetDays: number, yearly: boolean): boolean {
  const d = parseDateField(raw);
  if (!d) return false;
  // The contact's date plus the offset lands on today ⇔ today minus the offset is the contact's date.
  const [y, mo, da] = today.split("-").map(Number);
  const target = new Date(Date.UTC(y, mo - 1, da - offsetDays));
  const tm = target.getUTCMonth() + 1;
  const td = target.getUTCDate();
  if (yearly) {
    // 29 February birthdays are celebrated on 28 February in other years.
    const leapFallback = d.month === 2 && d.day === 29 && tm === 2 && td === 28 && !isLeap(target.getUTCFullYear());
    return (d.month === tm && d.day === td) || leapFallback;
  }
  return d.year === target.getUTCFullYear() && d.month === tm && d.day === td;
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Human summary of a wait step. */
export function describeWait(s: Extract<Step, { type: "wait" }>): string {
  const unit = s.amount === 1 ? s.unit.slice(0, -1) : s.unit;
  return `Wait ${s.amount} ${unit}${s.until ? `, then until ${s.until}` : ""}${s.weekdaysOnly ? " on a weekday" : ""}`;
}

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/** When a wait step ends: after the delay, then (optionally) at the next HH:MM, skipping weekends if asked. */
export function waitUntil(s: Extract<Step, { type: "wait" }>, now: Date, tz: string): Date {
  let at = new Date(now.getTime() + s.amount * UNIT_MS[s.unit]);
  if (s.until) at = nextLocalTime(at, tz, s.until);
  if (s.weekdaysOnly) {
    for (let i = 0; i < 3; i++) {
      const p = zonedParts(at, tz);
      const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
      if (dow !== 0 && dow !== 6) break;
      at = new Date(at.getTime() + 86_400_000);
    }
  }
  return at;
}
