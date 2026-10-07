import crypto from "node:crypto";
import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { decryptSecret } from "../lib/crypto";
import { childLogger } from "../lib/logger";
import { publicBaseUrl } from "../lib/tokens";
import { usersRepository } from "../repositories/users.repository";
import { activityRepository } from "../repositories/activity.repository";
import { systemConfig } from "../services/system-config.service";
import { BCRYPT_ROUNDS, createTenantAdmin, startSession } from "./auth.controller";

const log = childLogger("google-auth");
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const googleEndpoints = { token: TOKEN_URL, userinfo: USERINFO_URL };

const redirectUri = () => `${publicBaseUrl()}/api/auth/google/callback`;

async function googleSettings() {
  const g = (await systemConfig.get()).extensionSettings?.googleLogin;
  if (!g?.enabled || !g.clientId || !g.clientSecret) return null;
  return { clientId: g.clientId, clientSecret: decryptSecret(g.clientSecret) };
}

const safeNext = (n: unknown) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") ? n : null);

/** GET /api/auth/google — redirects to Google's consent screen. */
export async function start(req: Request, res: Response) {
  const g = await googleSettings();
  if (!g) return res.redirect("/login?error=google_disabled");
  const state = crypto.randomBytes(24).toString("base64url");
  req.session.oauthState = state;
  req.session.oauthNext = safeNext(req.query.next) ?? undefined;
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: g.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  req.session.save(() => res.redirect(url.toString()));
}

interface GoogleProfile {
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
}

async function exchange(code: string, g: { clientId: string; clientSecret: string }): Promise<GoogleProfile> {
  const tokenRes = await fetch(googleEndpoints.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(10_000),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!tokenRes.ok || !token.access_token) throw new Error(token.error_description ?? `token exchange failed (${tokenRes.status})`);
  const infoRes = await fetch(googleEndpoints.userinfo, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!infoRes.ok) throw new Error(`userinfo failed (${infoRes.status})`);
  return (await infoRes.json()) as GoogleProfile;
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

/** GET /api/auth/google/callback — signs in (or registers) the Google account. */
export async function callback(req: Request, res: Response) {
  const fail = (reason: string) => res.redirect(`/login?error=${reason}`);
  const expected = req.session.oauthState;
  const next = req.session.oauthNext;
  delete req.session.oauthState;
  delete req.session.oauthNext;
  if (!expected || typeof req.query.state !== "string" || req.query.state !== expected) return fail("google_state");
  if (typeof req.query.code !== "string") return fail(req.query.error === "access_denied" ? "google_cancelled" : "google_failed");
  const g = await googleSettings();
  if (!g) return fail("google_disabled");

  let profile: GoogleProfile;
  try {
    profile = await exchange(req.query.code, g);
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Google sign-in failed");
    return fail("google_failed");
  }
  if (!profile.email || !profile.email_verified) return fail("google_unverified");
  const email = profile.email.toLowerCase();

  let user = await usersRepository.findByLogin(email);
  if (user) {
    if (user.status === "banned") return fail("banned");
    if (user.status !== "active") return fail("inactive");
    if (!user.isEmailVerified) user = (await usersRepository.update(user.id, { isEmailVerified: true }))!;
  } else {
    const cfg = await systemConfig.get();
    if (!cfg.userRegistration) return fail("registration_closed");
    user = await createTenantAdmin({
      username: await uniqueUsername(email),
      email,
      // Random password: the account signs in with Google until the user sets one.
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), BCRYPT_ROUNDS),
      firstName: profile.given_name ?? null,
      lastName: profile.family_name ?? null,
      emailVerified: true,
    });
    await activityRepository.record(req, user.id, "signup", undefined, { via: "google" });
  }
  const session = await startSession(req, res, user);
  await activityRepository.record(req, user.id, "login", undefined, { via: "google" });
  res.redirect(next ?? session.redirect);
}
