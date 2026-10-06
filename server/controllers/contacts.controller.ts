import type { Request, Response } from "express";
import { parse as parseCsv } from "csv-parse/sync";
import { bulkIdsSchema, contactListQuery, contactSchema, updateContactSchema } from "@shared/validation";
import type { Contact } from "@shared/schema";
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
    status: input.status ?? "active",
    source: "manual",
    createdBy: req.user!.id,
  });
  await activityRepository.record(req, req.user!.id, "contact_created", { type: "contact", id: contact.id });
  res.status(201).json({ data: contact });
}

export async function updateContact(req: Request, res: Response) {
  const contact = await loadContact(req);
  const input = parseBody(updateContactSchema, req);
  if (input.phone && input.phone !== contact.phone && (await contactsRepository.findByPhone(contact.channelId, input.phone))) {
    throw conflict("A contact with this phone number already exists on this channel", "DUPLICATE_PHONE");
  }
  const updated = await contactsRepository.update(contact.id, { ...input, email: input.email === "" ? null : input.email });
  await activityRepository.record(req, req.user!.id, "contact_updated", { type: "contact", id: contact.id });
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

/** CSV import: columns name, phone, email (optional), tags (optional, ; separated). */
export async function importContacts(req: Request, res: Response) {
  const channel = req.channel!;
  if (!req.file) throw badRequest("Attach a CSV file in the `file` field");
  let records: Record<string, string>[];
  try {
    records = parseCsv(req.file.buffer, { columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    throw badRequest(`Could not read CSV: ${(err as Error).message}`);
  }
  if (records.length > IMPORT_MAX_ROWS) throw badRequest(`A single import is limited to ${IMPORT_MAX_ROWS} rows`);
  const groupId = typeof req.body.groupId === "string" && req.body.groupId ? req.body.groupId : null;

  const errors: { row: number; message: string }[] = [];
  const valid: { name: string; phone: string; email: string | null; tags: string[] }[] = [];
  const seen = new Set<string>();
  let inFileDuplicates = 0;
  records.forEach((r, i) => {
    try {
      const c = parse(contactSchema, {
        name: r.name || r.full_name || r.phone,
        phone: r.phone || r.mobile || r.whatsapp || "",
        email: r.email || null,
        tags: r.tags ? r.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
      });
      if (seen.has(c.phone)) {
        inFileDuplicates++;
        return;
      }
      seen.add(c.phone);
      valid.push({ name: c.name, phone: c.phone, email: c.email || null, tags: c.tags ?? [] });
    } catch (err) {
      if (errors.length < 100) errors.push({ row: i + 2, message: (err as Error).message.replace(/^Validation failed — /, "") });
    }
  });

  if (req.user!.tenantId && valid.length) await assertWithinPlan(req.user!.tenantId, "contacts", valid.length);
  const imported = await contactsRepository.insertManyIgnoreDuplicates(
    valid.map((c) => ({
      channelId: channel.id,
      tenantId: channel.createdBy,
      name: c.name,
      phone: c.phone,
      email: c.email,
      tags: c.tags,
      groups: groupId ? [groupId] : [],
      source: "import",
      createdBy: req.user!.id,
    })),
  );
  await activityRepository.record(req, req.user!.id, "contacts_imported", { type: "contact" }, { imported, rows: records.length });
  res.json({
    success: true,
    total: records.length,
    imported,
    duplicates: valid.length - imported + inFileDuplicates,
    invalid: records.length - valid.length - inFileDuplicates,
    errors,
  });
}

export async function exportContacts(req: Request, res: Response) {
  const { rows } = await contactsRepository.list(req.channel!.id, { page: 1, limit: 100_000 });
  const header = ["name", "phone", "email", "status", "tags", "source", "created_at"];
  const lines = rows.map((c) =>
    [c.name, c.phone, c.email, c.status, (c.tags ?? []).join(";"), c.source, c.createdAt?.toISOString()].map(csvCell).join(","),
  );
  await activityRepository.record(req, req.user!.id, "contacts_exported", { type: "contact" }, { count: rows.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([header.join(","), ...lines].join("\n"));
}
