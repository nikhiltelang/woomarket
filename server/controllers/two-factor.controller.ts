import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { twoFactorCodeSchema, twoFactorRequired } from "@shared/platform";
import { parseBody } from "../lib/http";
import { AppError, forbidden, notFound, unprocessable } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { usersRepository } from "../repositories/users.repository";
import { activityRepository } from "../repositories/activity.repository";
import { systemConfig } from "../services/system-config.service";
import { beginSetup, checkCode, confirmSetup, regenerateRecoveryCodes, status, twoFactorRepository } from "../services/two-factor.service";
import { startSession } from "./auth.controller";

const log = childLogger("2fa");
const MAX_ATTEMPTS = 5;

const saveSession = (req: Request) => new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));

/** POST /api/auth/2fa/verify — second step of sign-in. */
export async function verifyLogin(req: Request, res: Response) {
  const pending = req.session.pending2fa;
  if (!pending || pending.expiresAt < Date.now()) {
    delete req.session.pending2fa;
    throw new AppError(401, "Your sign-in timed out. Enter your password again.", "TWO_FACTOR_EXPIRED");
  }
  const { code } = parseBody(twoFactorCodeSchema, req);
  if (pending.attempts >= MAX_ATTEMPTS) {
    delete req.session.pending2fa;
    await saveSession(req);
    throw new AppError(429, "Too many wrong codes. Sign in again.", "TWO_FACTOR_LOCKED");
  }
  pending.attempts += 1;
  await saveSession(req);

  const user = await usersRepository.findById(pending.userId);
  if (!user || user.status !== "active" || !user.twoFactorEnabledAt) {
    delete req.session.pending2fa;
    throw new AppError(401, "Sign in again.", "TWO_FACTOR_EXPIRED");
  }
  const result = await checkCode(user.id, code);
  if (!result.ok) {
    log.info({ userId: user.id, attempt: pending.attempts }, "Wrong two-factor code");
    throw unprocessable(`That code isn't right.${MAX_ATTEMPTS - pending.attempts > 0 ? ` ${MAX_ATTEMPTS - pending.attempts} tries left.` : ""}`, "INVALID_CODE");
  }
  const via = pending.via;
  delete req.session.pending2fa;
  const session = await startSession(req, res, user);
  await activityRepository.record(req, user.id, "login", undefined, { via, secondFactor: result.via });
  res.json({ ...session, ...(result.via === "recovery" ? { recoveryCodesLeft: result.recoveryLeft } : {}) });
}

/** GET /api/auth/2fa — the signed-in user's status. */
export async function getStatus(req: Request, res: Response) {
  const user = (await usersRepository.findById(req.user!.id))!;
  const policy = (await systemConfig.get()).twoFactorPolicy;
  res.json({
    data: {
      enabled: Boolean(user.twoFactorEnabledAt),
      enabledAt: user.twoFactorEnabledAt,
      required: twoFactorRequired(user.role, policy),
      ...(await status(user.id)),
    },
  });
}

/** POST /api/auth/2fa/setup — a new secret and QR link; active after /enable. */
export async function setup(req: Request, res: Response) {
  const user = (await usersRepository.findById(req.user!.id))!;
  res.json({ data: await beginSetup(user) });
}

/** POST /api/auth/2fa/enable { code } — returns recovery codes once. */
export async function enable(req: Request, res: Response) {
  const { code } = parseBody(twoFactorCodeSchema, req);
  const codes = await confirmSetup(req.user!.id, code);
  await activityRepository.record(req, req.user!.id, "two_factor_enabled");
  res.json({ data: { recoveryCodes: codes } });
}

async function requireCurrentCode(userId: string, code: string) {
  if (!(await checkCode(userId, code)).ok) throw unprocessable("That code isn't right.", "INVALID_CODE");
}

/** POST /api/auth/2fa/disable { password, code } */
export async function disable(req: Request, res: Response) {
  const input = parseBody(z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(20) }), req);
  const user = (await usersRepository.findById(req.user!.id))!;
  if (twoFactorRequired(user.role, (await systemConfig.get()).twoFactorPolicy)) throw forbidden("Your platform requires two-factor authentication for your role.", "TWO_FACTOR_REQUIRED");
  if (!(await bcrypt.compare(input.password, user.password))) throw unprocessable("Your password isn't right.", "INVALID_PASSWORD");
  await requireCurrentCode(user.id, input.code);
  await twoFactorRepository.remove(user.id);
  await activityRepository.record(req, user.id, "two_factor_disabled");
  res.json({ success: true });
}

/** POST /api/auth/2fa/recovery-codes { code } — replaces all recovery codes. */
export async function newRecoveryCodes(req: Request, res: Response) {
  const { code } = parseBody(twoFactorCodeSchema, req);
  if (!req.user!.twoFactorEnabled) throw unprocessable("Turn on two-factor authentication first.");
  await requireCurrentCode(req.user!.id, code);
  const codes = await regenerateRecoveryCodes(req.user!.id);
  await activityRepository.record(req, req.user!.id, "two_factor_recovery_codes");
  res.json({ data: { recoveryCodes: codes } });
}

/** POST /api/admin/users/:id/2fa/reset — superadmin helps a locked-out user. */
export async function adminReset(req: Request, res: Response) {
  const user = await usersRepository.findById(req.params.id);
  if (!user) throw notFound("User");
  if (user.id === req.user!.id) throw forbidden("Reset your own two-factor authentication from your account page.");
  await twoFactorRepository.remove(user.id);
  await activityRepository.record(req, req.user!.id, "two_factor_reset", { type: "user", id: user.id });
  res.json({ success: true });
}

/** Paths a user who must set up 2FA can still reach. */
const ENROLLMENT_ALLOWED = [/^\/auth\//, /^\/csrf-token$/, /^\/system-config\/public$/, /^\/brand-settings$/, /^\/languages\//];

/**
 * When the policy requires two-factor authentication for the caller's role and they haven't
 * set it up, every other API call is refused until they do.
 */
export async function requireTwoFactorEnrollment(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = req.user;
    if (!user || user.twoFactorEnabled) return next();
    if (!twoFactorRequired(user.role, (await systemConfig.get()).twoFactorPolicy)) return next();
    if (ENROLLMENT_ALLOWED.some((r) => r.test(req.path))) return next();
    next(forbidden("Set up two-factor authentication to continue.", "TWO_FACTOR_SETUP_REQUIRED"));
  } catch (err) {
    next(err);
  }
}
