import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import {
  createTeamMemberSchema,
  paginationQuery,
  setPasswordSchema,
  updatePermissionsSchema,
  updateStatusSchema,
  updateTeamMemberSchema,
} from "@shared/validation";
import { ADMIN_ONLY_PERMISSIONS, DEFAULT_TEAM_PERMISSIONS } from "@shared/roles";
import type { User } from "@shared/schema";
import { paginated, parseBody, parseQuery } from "../lib/http";
import { conflict, notFound } from "../lib/errors";
import { usersRepository, toPublicUser } from "../repositories/users.repository";
import { activityRepository } from "../repositories/activity.repository";
import { requireTenantId } from "../middlewares/tenant";
import { assertWithinPlan } from "../middlewares/subscription";
import { BCRYPT_ROUNDS } from "./auth.controller";

const sanitizePermissions = (perms: string[]) => perms.filter((p) => !ADMIN_ONLY_PERMISSIONS.includes(p as never));

/** Loads a team member that belongs to the caller's tenant (404 otherwise). */
async function loadMember(req: Request): Promise<User> {
  const tenantId = requireTenantId(req.user);
  const member = await usersRepository.findById(req.params.id);
  if (!member || member.role !== "team" || member.createdBy !== tenantId) throw notFound("Team member");
  return member;
}

export async function listMembers(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const q = parseQuery(paginationQuery, req);
  const { rows, total } = await usersRepository.list({ ...q, createdBy: tenantId, role: "team" });
  res.json(paginated(rows.map(toPublicUser), total, q.page, q.limit));
}

/** Everyone a conversation can be assigned to: the tenant admin and active team members. */
export async function listAssignees(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const [admin, team] = await Promise.all([
    usersRepository.findById(tenantId),
    usersRepository.list({ page: 1, limit: 500, createdBy: tenantId, role: "team", status: "active" }),
  ]);
  const people = [admin, ...team.rows].filter(Boolean).map((u) => ({ id: u!.id, username: u!.username, firstName: u!.firstName, lastName: u!.lastName, role: u!.role }));
  res.json({ data: people });
}

export async function getMember(req: Request, res: Response) {
  res.json({ data: toPublicUser(await loadMember(req)) });
}

export async function createMember(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(createTeamMemberSchema, req);
  await assertWithinPlan(tenantId, "team");
  const taken = await usersRepository.existsUsernameOrEmail(input.username, input.email);
  if (taken.username) throw conflict("That username is already taken", "USERNAME_TAKEN");
  if (taken.email) throw conflict("An account with that email already exists", "EMAIL_TAKEN");
  const member = await usersRepository.create({
    username: input.username,
    email: input.email,
    password: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    role: "team",
    status: "active",
    permissions: sanitizePermissions(input.permissions ?? DEFAULT_TEAM_PERMISSIONS),
    createdBy: tenantId,
    isEmailVerified: true,
  });
  await activityRepository.record(req, req.user!.id, "team_member_created", { type: "user", id: member.id }, { username: member.username });
  res.status(201).json({ data: toPublicUser(member) });
}

export async function updateMember(req: Request, res: Response) {
  const member = await loadMember(req);
  const input = parseBody(updateTeamMemberSchema, req);
  if (input.email) {
    const taken = await usersRepository.existsUsernameOrEmail("\u0000", input.email, member.id);
    if (taken.email) throw conflict("An account with that email already exists", "EMAIL_TAKEN");
  }
  const updated = await usersRepository.update(member.id, input);
  await activityRepository.record(req, req.user!.id, "team_member_updated", { type: "user", id: member.id });
  res.json({ data: toPublicUser(updated!) });
}

export async function updateMemberStatus(req: Request, res: Response) {
  const member = await loadMember(req);
  const { status } = parseBody(updateStatusSchema, req);
  const updated = await usersRepository.update(member.id, { status });
  await activityRepository.record(req, req.user!.id, "team_member_status", { type: "user", id: member.id }, { status });
  res.json({ data: toPublicUser(updated!) });
}

export async function setMemberPassword(req: Request, res: Response) {
  const member = await loadMember(req);
  const { password } = parseBody(setPasswordSchema, req);
  await usersRepository.update(member.id, { password: await bcrypt.hash(password, BCRYPT_ROUNDS) });
  await activityRepository.record(req, req.user!.id, "team_member_password_reset", { type: "user", id: member.id });
  res.json({ success: true });
}

export async function updateMemberPermissions(req: Request, res: Response) {
  const member = await loadMember(req);
  const { permissions } = parseBody(updatePermissionsSchema, req);
  const clean = sanitizePermissions(permissions);
  const updated = await usersRepository.update(member.id, { permissions: clean });
  await activityRepository.record(req, req.user!.id, "team_member_permissions", { type: "user", id: member.id }, { permissions: clean });
  res.json({ data: toPublicUser(updated!) });
}

export async function deleteMember(req: Request, res: Response) {
  const member = await loadMember(req);
  await usersRepository.delete(member.id);
  await activityRepository.record(req, req.user!.id, "team_member_deleted", { type: "user", id: member.id }, { username: member.username });
  res.json({ success: true });
}

export async function activityLogs(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const q = parseQuery(paginationQuery, req);
  const { rows, total } = await activityRepository.listForTenant(tenantId, q.page, q.limit);
  res.json(paginated(rows, total, q.page, q.limit));
}
