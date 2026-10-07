import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { changePasswordSchema, loginSchema, signupSchema, updateProfileSchema } from "@shared/validation";
import { ALL_PERMISSIONS } from "@shared/roles";
import { parseBody } from "../lib/http";
import { AppError, badRequest, conflict, forbidden, unauthorized } from "../lib/errors";
import { passwordProblems, resendVerificationSchema, verifyEmailSchema } from "@shared/platform";
import { otpRepository, levelsRepository } from "../repositories/platform.repository";
import { systemConfig } from "../services/system-config.service";
import { sendSystemEmail } from "../services/email/system-mail";
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

export async function startSession(req: Request, res: Response, user: User) {
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

const PENDING_2FA_MS = 5 * 60_000;

/**
 * Finishes a successful first factor (password, SSO, email code). With two-factor
 * authentication on, the session only remembers who is half-signed-in until the code arrives.
 */
export async function completeSignIn(req: Request, res: Response, user: User, via: string) {
  if (user.twoFactorEnabledAt) {
    await regenerate(req);
    req.session.pending2fa = { userId: user.id, expiresAt: Date.now() + PENDING_2FA_MS, attempts: 0, via };
    await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
    return { twoFactorRequired: true as const };
  }
  const result = await startSession(req, res, user);
  await activityRepository.record(req, user.id, "login", undefined, via === "password" ? undefined : { via });
  return result;
}

/** Blocks sign-in for accounts that aren't allowed to use the platform. */
async function assertCanSignIn(user: User) {
  if (user.status === "banned") throw forbidden("This account has been suspended. Contact support if you think this is a mistake.", "ACCOUNT_BANNED");
  if (user.status !== "active") throw forbidden("Your account is inactive. Contact your administrator.", "ACCOUNT_INACTIVE");
  const cfg = await systemConfig.get();
  if (cfg.emailVerification && user.role !== "superadmin" && !user.isEmailVerified) {
    await sendVerificationCode(user).catch((err) => log.warn({ err: (err as Error).message }, "Could not send verification code"));
    throw new AppError(403, "Verify your email address to continue. We've sent you a code.", "EMAIL_NOT_VERIFIED", { email: user.email });
  }
}

/** Emails a fresh 6-digit code, at most once a minute per user. */
async function sendVerificationCode(user: User): Promise<void> {
  if ((await otpRepository.recentCount(user.id, 60_000)) > 0) return;
  const code = await otpRepository.issue(user.id);
  await sendSystemEmail(
    user.email,
    `Your verification code: ${code}`,
    `<p style="margin:0 0 12px">Use this code to verify your email address:</p><p style="margin:0 0 12px;font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p style="margin:0;color:#6b7280">It expires in 10 minutes. If you didn't request it, ignore this email.</p>`,
  );
}

export async function login(req: Request, res: Response) {
  const { username, password } = parseBody(loginSchema, req);
  const user = await usersRepository.findByLogin(username);
  const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  if (!user || !ok) {
    log.info({ username, ip: req.ip }, "Failed login");
    throw unauthorized("Invalid username or password");
  }
  await assertCanSignIn(user);
  res.json(await completeSignIn(req, res, user, "password"));
}

/** Creates a tenant admin with the Free plan and the lowest access level. */
export async function createTenantAdmin(v: { username: string; email: string; passwordHash: string; firstName?: string | null; lastName?: string | null; emailVerified: boolean }): Promise<User> {
  const lowest = await levelsRepository.lowest();
  const user = await usersRepository.create({
    username: v.username,
    email: v.email,
    password: v.passwordHash,
    firstName: v.firstName ?? null,
    lastName: v.lastName ?? null,
    role: "admin",
    status: "active",
    permissions: [...ALL_PERMISSIONS],
    isEmailVerified: v.emailVerified,
    accessLevel: lowest?.levelNumber ?? null,
  });
  const free = await billingRepository.findPlanByName("Free");
  if (free) await billingRepository.assign(user.id, free, "annual");
  else log.warn("No 'Free' plan found; new tenant has no subscription until one is assigned");
  return user;
}

export async function signup(req: Request, res: Response) {
  const cfg = await systemConfig.get();
  if (!cfg.userRegistration) throw forbidden("New registrations are currently closed.", "REGISTRATION_CLOSED");
  const input = parseBody(signupSchema, req);
  const pub = await systemConfig.public();
  if (pub.agreePolicy && !input.acceptTerms) throw new AppError(400, "Please accept the terms to continue", "TERMS_REQUIRED", { acceptTerms: ["Required"] });
  if (cfg.forceSecurePassword) {
    const problem = passwordProblems(input.password);
    if (problem) throw new AppError(400, `Validation failed — password: ${problem}`, "BAD_REQUEST", { password: [problem] });
  }
  const taken = await usersRepository.existsUsernameOrEmail(input.username, input.email);
  if (taken.username) throw conflict("That username is already taken", "USERNAME_TAKEN");
  if (taken.email) throw conflict("An account with that email already exists", "EMAIL_TAKEN");

  const user = await createTenantAdmin({
    username: input.username,
    email: input.email,
    passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
    firstName: input.firstName,
    lastName: input.lastName,
    emailVerified: !cfg.emailVerification,
  });
  await activityRepository.record(req, user.id, "signup");

  if (cfg.emailVerification) {
    try {
      await sendVerificationCode(user);
    } catch (err) {
      log.error({ err: (err as Error).message }, "Verification email failed at signup");
      throw new AppError(503, "Your account was created, but we couldn't send the verification email because the email service isn't configured. Please contact support.", "EMAIL_UNAVAILABLE");
    }
    return res.status(201).json({ verificationRequired: true, email: user.email });
  }
  res.status(201).json(await startSession(req, res, user));
}

/** POST /api/users/verifyEmail — activates the account and signs the user in. */
export async function verifyEmail(req: Request, res: Response) {
  const { email, code } = parseBody(verifyEmailSchema, req);
  const user = await usersRepository.findByLogin(email);
  if (!user || !(await otpRepository.consume(user.id, code))) throw badRequest("That code is invalid or has expired");
  const verified = (await usersRepository.update(user.id, { isEmailVerified: true }))!;
  if (verified.status !== "active") throw forbidden("Your account is not active.", "ACCOUNT_INACTIVE");
  await activityRepository.record(req, user.id, "email_verified");
  res.json(await completeSignIn(req, res, verified, "email_code"));
}

/** POST /api/users/resend-verification — same response whether or not the address exists. */
export async function resendVerification(req: Request, res: Response) {
  const { email } = parseBody(resendVerificationSchema, req);
  const user = await usersRepository.findByLogin(email);
  if (user && !user.isEmailVerified) await sendVerificationCode(user).catch((err) => log.warn({ err: (err as Error).message }, "Resend failed"));
  res.json({ success: true, message: "If that account needs verification, a new code is on its way." });
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
