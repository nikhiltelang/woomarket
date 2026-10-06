import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { adminCreateUserSchema, adminUpdateUserSchema, bulkStatusSchema, paginationQuery } from "@shared/validation";
import { ALL_PERMISSIONS } from "@shared/roles";
import { paginated, parseBody, parseQuery } from "../lib/http";
import { badRequest, conflict, notFound } from "../lib/errors";
import { usersRepository, toPublicUser } from "../repositories/users.repository";
import { billingRepository } from "../repositories/billing.repository";
import { activityRepository } from "../repositories/activity.repository";
import { BCRYPT_ROUNDS } from "./auth.controller";

const listQuery = paginationQuery.extend({
  role: z.enum(["superadmin", "admin", "team"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export async function listUsers(req: Request, res: Response) {
  const q = parseQuery(listQuery, req);
  const { rows, total } = await usersRepository.list(q);
  res.json(paginated(rows.map(toPublicUser), total, q.page, q.limit));
}

export async function getUser(req: Request, res: Response) {
  const user = await usersRepository.findById(req.params.id);
  if (!user) throw notFound("User");
  const subscriptions = await billingRepository.listSubscriptions(user.id);
  res.json({ data: toPublicUser(user), subscriptions });
}

export async function createUser(req: Request, res: Response) {
  const input = parseBody(adminCreateUserSchema, req);
  const taken = await usersRepository.existsUsernameOrEmail(input.username, input.email);
  if (taken.username || taken.email) throw conflict(taken.username ? "Username already taken" : "Email already registered");
  const user = await usersRepository.create({
    username: input.username,
    email: input.email,
    password: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    role: input.role,
    status: "active",
    permissions: [...ALL_PERMISSIONS],
    isEmailVerified: true,
  });
  if (input.role === "admin") {
    const free = await billingRepository.findPlanByName("Free");
    if (free) await billingRepository.assign(user.id, free, "annual");
  }
  await activityRepository.record(req, req.user!.id, "user_created", { type: "user", id: user.id }, { role: input.role });
  res.status(201).json({ data: toPublicUser(user) });
}

export async function adminUpdateUser(req: Request, res: Response) {
  const input = parseBody(adminUpdateUserSchema, req);
  const user = await usersRepository.findById(req.params.id);
  if (!user) throw notFound("User");
  if (user.id === req.user!.id && (input.status === "inactive" || (input.role && input.role !== "superadmin"))) {
    throw badRequest("You cannot deactivate or demote your own account");
  }
  if (input.email) {
    const taken = await usersRepository.existsUsernameOrEmail("\u0000", input.email, user.id);
    if (taken.email) throw conflict("Email already registered");
  }
  const updated = await usersRepository.update(user.id, input);
  await activityRepository.record(req, req.user!.id, "user_updated", { type: "user", id: user.id }, { fields: Object.keys(input) });
  res.json({ data: toPublicUser(updated!) });
}

export async function bulkStatus(req: Request, res: Response) {
  const { ids, status } = parseBody(bulkStatusSchema, req);
  const target = ids.filter((id) => id !== req.user!.id);
  const updated = await usersRepository.setStatusBulk(target, status);
  await activityRepository.record(req, req.user!.id, "users_bulk_status", { type: "user" }, { count: updated, status });
  res.json({ success: true, updated });
}

export async function deleteUser(req: Request, res: Response) {
  if (req.params.id === req.user!.id) throw badRequest("You cannot delete your own account");
  const user = await usersRepository.findById(req.params.id);
  if (!user) throw notFound("User");
  await usersRepository.delete(user.id);
  await activityRepository.record(req, req.user!.id, "user_deleted", { type: "user", id: user.id }, { username: user.username });
  res.json({ success: true });
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formula injection and quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export async function exportUsers(req: Request, res: Response) {
  const { rows } = await usersRepository.list({ page: 1, limit: 100_000 });
  const header = ["id", "username", "email", "first_name", "last_name", "role", "status", "last_login", "created_at"];
  const lines = rows.map((u) =>
    [u.id, u.username, u.email, u.firstName, u.lastName, u.role, u.status, u.lastLogin?.toISOString(), u.createdAt?.toISOString()]
      .map(csvCell)
      .join(","),
  );
  await activityRepository.record(req, req.user!.id, "users_exported", { type: "user" }, { count: rows.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([header.join(","), ...lines].join("\n"));
}

export { csvCell };
