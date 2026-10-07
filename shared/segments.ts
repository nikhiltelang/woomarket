/**
 * Dynamic segments: saved contact filters, evaluated each time they're used.
 * The rule model is shared by the rule builder and the server's SQL compiler.
 */
import { z } from "zod";

export const TEXT_OPS = ["eq", "neq", "contains", "not_contains", "starts_with", "is_set", "is_not_set"] as const;
export const NUMBER_OPS = ["eq", "neq", "gt", "lt", "is_set", "is_not_set"] as const;
export const DATE_OPS = ["within_days", "older_than_days", "before", "after"] as const;
export const ENGAGEMENT_OPS = ["email_opened", "email_not_opened", "email_clicked", "sms_clicked", "whatsapp_replied", "whatsapp_not_replied"] as const;

const days = z.coerce.number().int().min(1).max(3650);
const text = z.string().trim().max(255);
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, "Custom field name");

export const conditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.enum(["name", "email", "phone", "source"]), op: z.enum(TEXT_OPS), value: text.default("") }),
  z.object({ field: z.literal("status"), op: z.enum(["eq", "neq"]), value: z.enum(["active", "inactive", "unsubscribed", "blocked"]) }),
  z.object({ field: z.literal("tag"), op: z.enum(["has", "not_has"]), value: text.min(1) }),
  z.object({ field: z.literal("group"), op: z.enum(["in", "not_in"]), value: z.string().uuid() }),
  z.object({ field: z.enum(["created_at", "last_contact"]), op: z.enum(DATE_OPS), value: z.union([days, z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]) }),
  z.object({ field: z.literal("custom"), key: fieldKey, op: z.union([z.enum(TEXT_OPS), z.enum(["gt", "lt"])]), value: text.default("") }),
  z.object({ field: z.literal("engagement"), op: z.enum(ENGAGEMENT_OPS), value: days }),
]);
export type SegmentCondition = z.infer<typeof conditionSchema>;

export const segmentRulesSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(conditionSchema).min(1, "Add at least one condition").max(20),
});
export type SegmentRules = z.infer<typeof segmentRulesSchema>;

export const segmentSchema = z.object({
  name: z.string().trim().min(1, "Give the segment a name").max(100),
  description: z.string().trim().max(500).nullish(),
  rules: segmentRulesSchema,
});

/** Labels for the rule builder. */
export const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  source: "Source",
  status: "Status",
  tag: "Tag",
  group: "Group",
  created_at: "Added",
  last_contact: "Last contacted",
  custom: "Custom field",
  engagement: "Engagement",
};

export const OP_LABELS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  starts_with: "starts with",
  is_set: "is set",
  is_not_set: "is empty",
  gt: "is greater than",
  lt: "is less than",
  has: "has tag",
  not_has: "doesn't have tag",
  in: "is in group",
  not_in: "isn't in group",
  within_days: "in the last … days",
  older_than_days: "more than … days ago",
  before: "before",
  after: "after",
  email_opened: "opened an email in the last … days",
  email_not_opened: "hasn't opened an email in the last … days",
  email_clicked: "clicked an email link in the last … days",
  sms_clicked: "clicked an SMS link in the last … days",
  whatsapp_replied: "replied on WhatsApp in the last … days",
  whatsapp_not_replied: "hasn't replied on WhatsApp in the last … days",
};

/** Ops that don't take a value. */
export const NO_VALUE_OPS = new Set(["is_set", "is_not_set"]);

/** One-line description of a rule set, e.g. "City is Pune and opened an email in the last 30 days". */
export function describeRules(r: SegmentRules, groupName: (id: string) => string = (id) => id): string {
  const parts = r.conditions.map((c) => {
    const field = c.field === "custom" ? c.key.replace(/_/g, " ") : FIELD_LABELS[c.field].toLowerCase();
    const op = OP_LABELS[c.op] ?? c.op;
    if (c.field === "engagement") return op.replace("…", String(c.value));
    if (NO_VALUE_OPS.has(c.op)) return `${field} ${op}`;
    if (c.field === "group") return `${op} “${groupName(String(c.value))}”`;
    if (c.field === "tag") return `${op} “${c.value}”`;
    if (typeof c.value === "number" || /…/.test(op)) return `${field} ${op.replace("…", String(c.value))}`;
    return `${field} ${op} “${c.value}”`;
  });
  return parts.join(r.match === "all" ? " and " : " or ");
}
