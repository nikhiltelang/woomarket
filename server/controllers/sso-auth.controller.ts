import crypto from "node:crypto";
import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import type { User } from "@shared/schema";
import { childLogger } from "../lib/logger";
import { notFound } from "../lib/errors";
import { usersRepository } from "../repositories/users.repository";
import { activityRepository } from "../repositories/activity.repository";
import { systemConfig } from "../services/system-config.service";
import { authorizationUrl, exchangeCode, identitiesRepository, isSsoProvider, SsoError, ssoSettings, type SsoProfile, type SsoProvider } from "../services/sso.service";
import { BCRYPT_ROUNDS, completeSignIn, createTenantAdmin } from "./auth.controller";

const log = childLogger("sso");

const safeNext = (n: unknown) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") ? n : null);

function providerOf(req: Request): SsoProvider {
  const p = req.path.split("/").filter(Boolean)[1];
  if (!isSsoProvider(p)) throw notFound("Sign-in provider");
  return p;
}

/** GET /api/auth/:provider — redirects to the provider. With ?link=1, links it to the signed-in account. */
export async function start(req: Request, res: Response) {
  const provider = providerOf(req);
  // The OAuth callback lives on the platform's domain, so SSO isn't offered on brand domains.
  if (req.brand) return res.redirect(`/login?error=${provider}_disabled`);
  const s = await ssoSettings(provider);
  const link = req.query.link === "1" && req.session.userId;
  if (!s) return res.redirect(link ? `/account?sso_error=${provider}_disabled` : `/login?error=${provider}_disabled`);
  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  req.session.oauthState = state;
  req.session.oauthNonce = nonce;
  req.session.oauthProvider = provider;
  req.session.oauthNext = safeNext(req.query.next) ?? undefined;
  req.session.oauthLinkUserId = link ? req.session.userId : undefined;
  req.session.save(() => res.redirect(authorizationUrl(s, state, nonce)));
}

/** Derives an unused username from the email's local part. */
async function uniqueUsername(email: string): Promise<string> {
  const base = (email.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "user").padEnd(3, "0");
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}${crypto.randomInt(100, 9999)}`;
    if (!(await usersRepository.existsUsernameOrEmail(candidate, "\u0000")).username) return candidate;
  }
  return `${base}${crypto.randomBytes(4).toString("hex")}`;
}

/** Finds the account for a profile: by linked identity, then by trusted email, else registers one. */
async function resolveUser(req: Request, p: SsoProfile): Promise<{ user: User; created: boolean } | { error: string }> {
  const identity = await identitiesRepository.find(p.provider, p.subject);
  if (identity) {
    const user = await usersRepository.findById(identity.userId);
    if (!user) return { error: "failed" };
    await identitiesRepository.touch(identity.id, p.email);
    return { user, created: false };
  }
  if (!p.email) return { error: "no_email" };
  if (!p.emailTrusted) return { error: "unverified" };

  const existing = await usersRepository.findByLogin(p.email);
  if (existing) {
    // Only an email the provider verified can link to an existing account.
    await identitiesRepository.link(existing, p);
    const user = existing.isEmailVerified ? existing : (await usersRepository.update(existing.id, { isEmailVerified: true }))!;
    return { user, created: false };
  }
  if (!(await systemConfig.get()).userRegistration) return { error: "registration_closed" };
  const user = await createTenantAdmin({
    username: await uniqueUsername(p.email),
    email: p.email,
    // Random password: the account signs in with SSO until the user sets one (via "Forgot password").
    passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), BCRYPT_ROUNDS),
    firstName: p.firstName,
    lastName: p.lastName,
    emailVerified: true,
  });
  await identitiesRepository.link(user, p);
  await activityRepository.record(req, user.id, "signup", undefined, { via: p.provider });
  return { user, created: true };
}

/** GET /api/auth/:provider/callback */
export async function callback(req: Request, res: Response) {
  const provider = providerOf(req);
  const { oauthState: expected, oauthNonce: nonce, oauthNext: next, oauthProvider, oauthLinkUserId: linkUserId } = req.session;
  delete req.session.oauthState;
  delete req.session.oauthNonce;
  delete req.session.oauthNext;
  delete req.session.oauthProvider;
  delete req.session.oauthLinkUserId;
  const fail = (reason: string) => res.redirect(linkUserId ? `/account?sso_error=${provider}_${reason}` : `/login?error=${provider}_${reason}`);

  if (!expected || !nonce || oauthProvider !== provider || typeof req.query.state !== "string" || req.query.state !== expected) return fail("state");
  if (typeof req.query.code !== "string") {
    const denied = req.query.error === "access_denied" || req.query.error === "consent_required";
    if (!denied) log.warn({ provider, error: req.query.error, description: String(req.query.error_description ?? "").slice(0, 300) }, "SSO error from provider");
    return fail(denied ? "cancelled" : "failed");
  }
  const s = await ssoSettings(provider);
  if (!s) return fail("disabled");

  let profile: SsoProfile;
  try {
    profile = await exchangeCode(s, req.query.code, nonce);
  } catch (err) {
    log.warn({ provider, err: (err as Error).message }, "SSO sign-in failed");
    return fail(err instanceof SsoError ? err.code : "failed");
  }

  // Linking from the account page: attach this provider account to the signed-in user.
  if (linkUserId) {
    if (req.session.userId !== linkUserId) return fail("state");
    const owner = await identitiesRepository.find(provider, profile.subject);
    if (owner && owner.userId !== linkUserId) return fail("linked_elsewhere");
    if (!owner) await identitiesRepository.link({ id: linkUserId }, profile);
    await activityRepository.record(req, linkUserId, "sso_linked", undefined, { provider });
    return res.redirect(`/account?sso_linked=${provider}`);
  }

  const result = await resolveUser(req, profile);
  if ("error" in result) return fail(result.error);
  const { user } = result;
  if (user.status === "banned") return fail("banned");
  if (user.status !== "active") return fail("inactive");
  const signedIn = await completeSignIn(req, res, user, provider);
  if ("twoFactorRequired" in signedIn) return res.redirect(`/login?step=2fa${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  res.redirect(next ?? signedIn.redirect);
}

/** GET /api/auth/identities — the signed-in user's linked sign-in providers. */
export async function listIdentities(req: Request, res: Response) {
  const rows = await identitiesRepository.listForUser(req.user!.id);
  res.json({ data: rows.map((r) => ({ provider: r.provider, email: r.email, createdAt: r.createdAt, lastLoginAt: r.lastLoginAt })) });
}

/** DELETE /api/auth/identities/:provider */
export async function unlinkIdentity(req: Request, res: Response) {
  if (!isSsoProvider(req.params.provider)) throw notFound("Sign-in provider");
  const removed = await identitiesRepository.unlink(req.user!.id, req.params.provider);
  if (!removed) throw notFound("Linked account");
  await activityRepository.record(req, req.user!.id, "sso_unlinked", undefined, { provider: req.params.provider });
  res.json({ success: true });
}
