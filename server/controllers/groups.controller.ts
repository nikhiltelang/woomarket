import type { Request, Response } from "express";
import { groupContactsSchema, groupSchema, moveContactsSchema } from "@shared/validation";
import type { Contact, Group } from "@shared/schema";
import { contactData, emitForChannel, MAX_BULK_EVENTS } from "../services/webhook-events";
import { parseBody } from "../lib/http";
import { notFound } from "../lib/errors";
import { groupsRepository } from "../repositories/groups.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { activityRepository } from "../repositories/activity.repository";
import { assertChannelAccess, requireTenantId } from "../middlewares/tenant";

async function loadGroup(req: Request, id: string): Promise<Group> {
  const tenantId = requireTenantId(req.user);
  const group = await groupsRepository.findById(id);
  if (!group || group.createdBy !== tenantId) throw notFound("Group");
  return group;
}

export async function listGroups(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
  if (channelId) await assertChannelAccess(req.user!, channelId);
  const rows = await groupsRepository.listByTenant(tenantId, channelId);
  const counts = await contactsRepository.countByGroup(rows.map((g) => g.id));
  res.json({ data: rows.map((g) => ({ ...g, contactCount: counts[g.id] ?? 0 })) });
}

export async function contactCounts(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const rows = await groupsRepository.listByTenant(tenantId);
  res.json({ data: await contactsRepository.countByGroup(rows.map((g) => g.id)) });
}

export async function getGroup(req: Request, res: Response) {
  res.json({ data: await loadGroup(req, req.params.id) });
}

export async function createGroup(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(groupSchema, req);
  const channelId = typeof req.body.channelId === "string" ? req.body.channelId : null;
  if (channelId) await assertChannelAccess(req.user!, channelId);
  const group = await groupsRepository.create({ ...input, channelId, createdBy: tenantId });
  await activityRepository.record(req, req.user!.id, "group_created", { type: "group", id: group.id });
  res.status(201).json({ data: group });
}

export async function updateGroup(req: Request, res: Response) {
  const group = await loadGroup(req, req.params.id);
  const input = parseBody(groupSchema.partial(), req);
  res.json({ data: await groupsRepository.update(group.id, input) });
}

export async function deleteGroup(req: Request, res: Response) {
  const group = await loadGroup(req, req.params.id);
  await contactsRepository.removeGroupEverywhere(group.id);
  await groupsRepository.delete(group.id);
  await activityRepository.record(req, req.user!.id, "group_deleted", { type: "group", id: group.id });
  res.json({ success: true });
}

/** Loads contacts and verifies every one belongs to the caller's tenant. */
async function loadContacts(req: Request, ids: string[]) {
  const found = await Promise.all(ids.map((id) => contactsRepository.findById(id)));
  const contacts = found.filter((c): c is NonNullable<typeof c> => Boolean(c));
  const channelIds = [...new Set(contacts.map((c) => c.channelId))];
  for (const channelId of channelIds) await assertChannelAccess(req.user!, channelId);
  return contacts;
}

/** contact.updated for contacts that just joined a group (webhooks and automations). */
function emitJoined(joined: Contact[], groupId: string) {
  for (const c of joined.slice(0, MAX_BULK_EVENTS)) {
    const after = { ...c, groups: [...(c.groups ?? []), groupId] };
    emitForChannel(c.channelId, "contact.updated", { contact: contactData(after), changed: ["groups"], tagsAdded: [], groupsAdded: [groupId] });
  }
}

export async function addContacts(req: Request, res: Response) {
  const { groupId, contactIds } = parseBody(groupContactsSchema, req);
  await loadGroup(req, groupId);
  const contacts = await loadContacts(req, contactIds);
  const joining = contacts.filter((c) => !(c.groups ?? []).includes(groupId));
  await contactsRepository.setGroups(joining.map((c) => ({ id: c.id, groups: [...(c.groups ?? []), groupId] })));
  emitJoined(joining, groupId);
  res.json({ success: true, updated: contacts.length });
}

export async function removeContacts(req: Request, res: Response) {
  const { groupId, contactIds } = parseBody(groupContactsSchema, req);
  await loadGroup(req, groupId);
  const contacts = await loadContacts(req, contactIds);
  await contactsRepository.setGroups(contacts.map((c) => ({ id: c.id, groups: (c.groups ?? []).filter((g) => g !== groupId) })));
  res.json({ success: true, updated: contacts.length });
}

export async function moveContacts(req: Request, res: Response) {
  const { fromGroupId, toGroupId, contactIds } = parseBody(moveContactsSchema, req);
  await loadGroup(req, fromGroupId);
  await loadGroup(req, toGroupId);
  const contacts = await loadContacts(req, contactIds);
  await contactsRepository.setGroups(
    contacts.map((c) => {
      const next = (c.groups ?? []).filter((g) => g !== fromGroupId);
      if (!next.includes(toGroupId)) next.push(toGroupId);
      return { id: c.id, groups: next };
    }),
  );
  emitJoined(contacts.filter((c) => !(c.groups ?? []).includes(toGroupId)), toGroupId);
  res.json({ success: true, updated: contacts.length });
}
