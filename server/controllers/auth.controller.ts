import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { changePasswordSchema, loginSchema, signupSchema, updateProfileSchema } from "@shared/validation";
import { ALL_PERMISSIONS } from "@shared/roles";
import { parseBody } from "../lib/http";
import { conflict, forbidden, unauthorized } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { usersRepository, toPublicUser } from "../repositories/users.repository";
import { billingRepository } from "../repositories/billing.repository";
import { activityRepository } from "../repositories/activity.repository";
import { signAccessToken } from "../middlewares/auth";
import { issueCsrfToken } from "../middlewares/csrf";
import type { User } from "@shared/schema";

const log = childLogger("auth");
export const BCRYPT_ROUNDS = 12;
// Compared against when the username doesn't exist, so response timing doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

async function startSession(req: Request, res: Response, user: User) {
  await regenerate(req); // prevents session fixation
  req.session.userId = user.id;
  const csrfToken = issueCsrfToken(req, res, true);
  await usersRepository.touchLastLogin(user.id);
  const fresh = (await usersRepository.findById(user.id))!;
  return {
    user: toPublicUser(fresh),
    token: signAccessToken(user.id),
    csrfToken,
    redirect: user.role === "superadmin" ? "/admin" : "/dashboard",
  };
}

export async function login(req: Request, res: Response) {
  const { username, password } = parseBody(loginSchema, req);
  const user = await usersRepository.findByLogin(username);
  const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  if (!user || !ok) {
    log.info({ username, ip: req.ip }, "Failed login");
    throw unauthorized("Invalid username or password");
  }
  if (user.status !== "active") throw forbidden("Your account is inactive. Contact your administrator.", "ACCOUNT_INACTIVE");
  const result = await startSession(req, res, user);
  await activityRepository.record(req, user.id, "login");
  res.json(result);
}

export async function signup(req: Request, res: Response) {
  const input = parseBody(signupSchema, req);
  const taken = await usersRepository.existsUsernameOrEmail(input.username, input.email);
  if (taken.username) throw conflict("That username is already taken", "USERNAME_TAKEN");
  if (taken.email) throw conflict("An account with that email already exists", "EMAIL_TAKEN");

  const user = await usersRepository.create({
    username: input.username,
    email: input.email,
    password: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    role: "admin",
    status: "active",
    permissions: [...ALL_PERMISSIONS],
    isEmailVerified: false,
  });

  const free = await billingRepository.findPlanByName("Free");
  if (free) await billingRepository.assign(user.id, free, "annual");
  else log.warn("No 'Free' plan found; new tenant has no subscription until one is assigned");

  await activityRepository.record(req, user.id, "signup");
  res.status(201).json(await startSession(req, res, user));
}

export async function logout(req: Request, res: Response) {
  const userId = req.user?.id;
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  res.clearCookie("connect.sid");
  if (userId) await activityRepository.record(req, userId, "logout");
  res.json({ success: true });
}

export async function me(req: Request, res: Response) {
  const user = await usersRepository.findById(req.user!.id);
  if (!user) throw unauthorized();
  const subscription = user.role === "superadmin" ? null : await billingRepository.activeSubscription(req.user!.tenantId!);
  res.json({ user: toPublicUser(user), subscription });
}

export function check(req: Request, res: Response) {
  res.json({ authenticated: Boolean(req.user), role: req.user?.role ?? null });
}

export async function updateProfile(req: Request, res: Response) {
  const input = parseBody(updateProfileSchema, req);
  if (input.email) {
    const taken = await usersRepository.existsUsernameOrEmail("\u0000", input.email, req.user!.id);
    if (taken.email) throw conflict("An account with that email already exists", "EMAIL_TAKEN");
  }
  const user = await usersRepository.update(req.user!.id, input);
  await activityRepository.record(req, req.user!.id, "profile_updated", { type: "user", id: req.user!.id });
  res.json({ user: toPublicUser(user!) });
}

export async function changePassword(req: Request, res: Response) {
  const { currentPassword, newPassword } = parseBody(changePasswordSchema, req);
  const user = await usersRepository.findById(req.user!.id);
  if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
    throw forbidden("Current password is incorrect", "WRONG_PASSWORD");
  }
  await usersRepository.update(user.id, { password: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) });
  await activityRepository.record(req, user.id, "password_changed", { type: "user", id: user.id });
  res.json({ success: true });
}
