import type { Request, Response } from "express";
import { emit } from "../services/webhooks.service";
import { changedFields, contactData, emitContactsCreated, emitForChannel, hasSubscribers } from "../services/webhook-events";
import { parse as parseCsv } from "csv-parse/sync";
import { bulkIdsSchema, contactListQuery, contactSchema, updateContactSchema } from "@shared/validation";
import type { Contact, ContactFields } from "@shared/schema";
import { contactFieldsSchema, normalizeFieldKey, RESERVED_FIELD_KEYS } from "@shared/contact-fields";
import { paginated, parse, parseBody, parseQuery } from "../lib/http";
import { badRequest, conflict, notFound } from "../lib/errors";
import { contactsRepository } from "../repositories/contacts.repository";
import { activityRepository } from "../repositories/activity.repository";
import { assertChannelAccess } from "../middlewares/tenant";
import { assertWithinPlan } from "../middlewares/subscription";
import { csvCell } from "./users.controller";

async function loadContact(req: Request): Promise<Contact> {
  const contact = await contactsRepository.findById(req.params.id);
  if (!contact) throw notFound("Contact");
  await assertChannelAccess(req.user!, contact.channelId).catch(() => {
    throw notFound("Contact");
  });
  return contact;
}

export async function listContacts(req: Request, res: Response) {
  const q = parseQuery(contactListQuery, req);
  const { rows, total } = await contactsRepository.list(req.channel!.id, q);
  res.json(paginated(rows, total, q.page, q.limit));
}

export async function getContact(req: Request, res: Response) {
  res.json({ data: await loadContact(req) });
}

export async function createContact(req: Request, res: Response) {
  const channel = req.channel!;
  const input = parseBody(contactSchema, req);
  if (req.user!.tenantId) await assertWithinPlan(req.user!.tenantId, "contacts");
  if (await contactsRepository.findByPhone(channel.id, input.phone)) {
    throw conflict("A contact with this phone number already exists on this channel", "DUPLICATE_PHONE");
  }
  const contact = await contactsRepository.create({
    channelId: channel.id,
    tenantId: channel.createdBy,
    name: input.name,
    phone: input.phone,
    email: input.email || null,
    groups: input.groups ?? [],
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
    status: input.status ?? "active",
    source: "manual",
    createdBy: req.user!.id,
  });
  await activityRepository.record(req, req.user!.id, "contact_created", { type: "contact", id: contact.id });
  emit(channel.createdBy, "contact.created", { contact: contactData(contact) });
  res.status(201).json({ data: contact });
}

/** Tags and groups the update added (automations start on these). */
function addedTo(before: { tags: string[] | null; groups: string[] | null }, after: { tags: string[] | null; groups: string[] | null }) {
  const lower = new Set((before.tags ?? []).map((t) => t.toLowerCase()));
  return { tagsAdded: (after.tags ?? []).filter((t) => !lower.has(t.toLowerCase())), groupsAdded: (after.groups ?? []).filter((g) => !(before.groups ?? []).includes(g)) };
}

export async function updateContact(req: Request, res: Response) {
  const contact = await loadContact(req);
  const input = parseBody(updateContactSchema, req);
  if (input.phone && input.phone !== contact.phone && (await contactsRepository.findByPhone(contact.channelId, input.phone))) {
    throw conflict("A contact with this phone number already exists on this channel", "DUPLICATE_PHONE");
  }
  const updated = await contactsRepository.update(contact.id, { ...input, email: input.email === "" ? null : input.email });
  await activityRepository.record(req, req.user!.id, "contact_updated", { type: "contact", id: contact.id });
  const changed = updated ? changedFields(contact, updated) : [];
  if (updated && changed.length) emitForChannel(updated.channelId, "contact.updated", { contact: contactData(updated), changed, ...addedTo(contact, updated) });
  res.json({ data: updated });
}

export async function deleteContact(req: Request, res: Response) {
  const contact = await loadContact(req);
  await contactsRepository.delete(contact.id);
  await activityRepository.record(req, req.user!.id, "contact_deleted", { type: "contact", id: contact.id });
  res.json({ success: true });
}

export async function bulkDeleteContacts(req: Request, res: Response) {
  const { ids } = parseBody(bulkIdsSchema, req);
  const deleted = await contactsRepository.deleteMany(req.channel!.id, ids);
  await activityRepository.record(req, req.user!.id, "contacts_bulk_deleted", { type: "contact" }, { count: deleted });
  res.json({ success: true, deleted });
}

const IMPORT_MAX_ROWS = 50_000;
/** Columns the importer understands; any other column becomes a custom field. */
const STANDARD_COLUMNS = new Set(["name", "full_name", "phone", "mobile", "whatsapp", "email", "tags", "status", "source", "created_at", "updated_at", "groups", "id"]);

/**
 * CSV import: name, phone, email (optional), tags (optional, ; separated). Every other column
 * (age, address, …) is stored as a custom field. With updateExisting=true, contacts already on
 * the number get the file's custom fields merged in instead of being skipped.
 */
export async function importContacts(req: Request, res: Response) {
  const channel = req.channel!;
  if (!req.file) throw badRequest("Attach a CSV file in the `file` field");
  let records: Record<string, string>[];
  let headers: string[] = [];
  try {
    records = parseCsv(req.file.buffer, {
      columns: (h: string[]) => (headers = h.map((c) => c.trim())).map((c) => c.toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (err) {
    throw badRequest(`Could not read CSV: ${(err as Error).message}`);
  }
  if (records.length > IMPORT_MAX_ROWS) throw badRequest(`A single import is limited to ${IMPORT_MAX_ROWS} rows`);
  const groupId = typeof req.body.groupId === "string" && req.body.groupId ? req.body.groupId : null;
  const updateExisting = req.body.updateExisting === "true";
  // Custom field columns, keyed by their lower-cased header; the original header names the field.
  const fieldColumns = headers.filter((h) => !STANDARD_COLUMNS.has(h.toLowerCase()) && normalizeFieldKey(h) && !RESERVED_FIELD_KEYS.has(normalizeFieldKey(h)));

  const errors: { row: number; message: string }[] = [];
  const valid: { name: string; phone: string; email: string | null; tags: string[]; metadata: ContactFields }[] = [];
  const seen = new Set<string>();
  let inFileDuplicates = 0;
  records.forEach((raw, i) => {
    // Files exported by older versions (or spreadsheets) may carry a leading apostrophe.
    const r = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v.replace(/^'(?=[+\d])/, "") : v])) as Record<string, string>;
    try {
      const c = parse(contactSchema, {
        name: r.name || r.full_name || r.phone,
        phone: r.phone || r.mobile || r.whatsapp || "",
        email: r.email || null,
        tags: r.tags ? r.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
        metadata: Object.fromEntries(fieldColumns.map((h) => [h, r[h.toLowerCase()] ?? ""])),
      });
      if (seen.has(c.phone)) {
        inFileDuplicates++;
        return;
      }
      seen.add(c.phone);
      valid.push({ name: c.name, phone: c.phone, email: c.email || null, tags: c.tags ?? [], metadata: c.metadata ?? {} });
    } catch (err) {
      if (errors.length < 100) errors.push({ row: i + 2, message: (err as Error).message.replace(/^Validation failed — /, "") });
    }
  });

  if (req.user!.tenantId && valid.length) await assertWithinPlan(req.user!.tenantId, "contacts", valid.length);
  // Contacts already on the number (found before inserting) are the ones whose fields may be merged.
  const withFields = valid.filter((c) => Object.keys(c.metadata).length);
  const existing = updateExisting && withFields.length ? await contactsRepository.existingPhones(channel.id, withFields.map((c) => c.phone)) : new Set<string>();
  // Phones already on the number before the import, so only new contacts send contact.created.
  const notify = await hasSubscribers(channel.createdBy, "contact.created");
  const before = notify ? await contactsRepository.existingPhones(channel.id, valid.map((c) => c.phone)) : new Set<string>();
  const imported = await contactsRepository.insertManyIgnoreDuplicates(
    valid.map((c) => ({
      channelId: channel.id,
      tenantId: channel.createdBy,
      name: c.name,
      phone: c.phone,
      email: c.email,
      tags: c.tags,
      metadata: c.metadata,
      groups: groupId ? [groupId] : [],
      source: "import",
      createdBy: req.user!.id,
    })),
  );
  if (notify) void emitContactsCreated(channel.createdBy, channel.id, valid.map((c) => c.phone).filter((p) => !before.has(p)));
  const toMerge = withFields.filter((c) => existing.has(c.phone));
  if (toMerge.length) await contactsRepository.mergeFields(channel.id, toMerge.map((c) => ({ phone: c.phone, metadata: c.metadata })));
  const updated = toMerge.length;
  await activityRepository.record(req, req.user!.id, "contacts_imported", { type: "contact" }, { imported, updated, rows: records.length, fields: fieldColumns.length });
  res.json({
    success: true,
    total: records.length,
    imported,
    updated,
    duplicates: valid.length - imported + inFileDuplicates - updated,
    invalid: records.length - valid.length - inFileDuplicates,
    fields: fieldColumns.map(normalizeFieldKey),
    errors,
  });
}

/** GET /api/contacts/fields — custom field names in use, with how many contacts have each. */
export async function listFields(req: Request, res: Response) {
  const channelId = typeof req.query.channelId === "string" && req.query.channelId ? req.query.channelId : null;
  if (channelId) await assertChannelAccess(req.user!, channelId);
  const tenantId = req.user!.tenantId;
  if (!tenantId) throw badRequest("Custom fields belong to a tenant account");
  res.json({ data: await contactsRepository.fieldKeys(tenantId, channelId) });
}

export async function exportContacts(req: Request, res: Response) {
  const { rows } = await contactsRepository.list(req.channel!.id, { page: 1, limit: 100_000 });
  // Custom fields become extra columns, so an export can be edited and imported back.
  const fieldKeys = [...new Set(rows.flatMap((c) => Object.keys(c.metadata ?? {})))].sort();
  const header = ["name", "phone", "email", "status", "tags", "source", "created_at", ...fieldKeys];
  const lines = rows.map((c) =>
    [c.name, c.phone, c.email, c.status, (c.tags ?? []).join(";"), c.source, c.createdAt?.toISOString(), ...fieldKeys.map((k) => c.metadata?.[k] ?? "")].map(csvCell).join(","),
  );
  await activityRepository.record(req, req.user!.id, "contacts_exported", { type: "contact" }, { count: rows.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([header.join(","), ...lines].join("\n"));
}
