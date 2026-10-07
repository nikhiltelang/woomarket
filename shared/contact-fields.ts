/**
 * Custom contact fields (age, address, …), stored in contacts.metadata. Keys are
 * snake_case so each one doubles as a {{key}} merge tag in messages.
 */
import { z } from "zod";
import type { ContactFields } from "./schema";

export const MAX_CONTACT_FIELDS = 50;
export const MAX_FIELD_VALUE = 1000;

/** Built-in contact properties and import columns; not allowed as custom field names. */
export const RESERVED_FIELD_KEYS = new Set([
  "id", "name", "full_name", "first_name", "phone", "mobile", "whatsapp", "email", "tags", "groups",
  "status", "source", "created_at", "updated_at", "unsubscribe_url",
]);

/** "Home Address" → "home_address", "2nd Phone" → "f_2nd_phone"; "" when nothing usable is left. */
export function normalizeFieldKey(raw: string): string {
  const k = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return /^\d/.test(k) ? `f_${k}`.slice(0, 50) : k;
}

/**
 * Accepts { "Age": 34, "Home address": "…" } and returns { age: "34", home_address: "…" }.
 * Empty values are dropped (that's how a field is removed).
 */
export const contactFieldsSchema = z
  .record(z.string().max(100), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .superRefine((obj, ctx) => {
    const seen = new Map<string, string>();
    for (const raw of Object.keys(obj)) {
      const key = normalizeFieldKey(raw);
      if (!key) ctx.addIssue({ code: "custom", path: [raw], message: `"${raw}" isn't a usable field name` });
      else if (RESERVED_FIELD_KEYS.has(key)) ctx.addIssue({ code: "custom", path: [raw], message: `"${raw}" is a built-in contact field` });
      else if (seen.has(key)) ctx.addIssue({ code: "custom", path: [raw], message: `"${raw}" and "${seen.get(key)}" are the same field` });
      seen.set(key, raw);
      const v = obj[raw];
      if (typeof v === "string" && v.length > MAX_FIELD_VALUE) ctx.addIssue({ code: "custom", path: [raw], message: `At most ${MAX_FIELD_VALUE} characters` });
    }
    if (seen.size > MAX_CONTACT_FIELDS) ctx.addIssue({ code: "custom", message: `At most ${MAX_CONTACT_FIELDS} custom fields per contact` });
  })
  .transform((obj): ContactFields => {
    const out: ContactFields = {};
    for (const [raw, v] of Object.entries(obj)) {
      const value = v === null ? "" : String(v).trim();
      if (value) out[normalizeFieldKey(raw)] = value;
    }
    return out;
  });

/** Human label for a stored key: "home_address" → "Home address". */
export const fieldLabel = (key: string) => (key.charAt(0).toUpperCase() + key.slice(1)).replace(/_/g, " ");
