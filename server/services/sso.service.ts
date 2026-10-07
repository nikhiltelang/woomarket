/**
 * Single sign-on with Google and Microsoft (OpenID Connect authorization-code flow).
 *
 * Accounts are matched by the provider's stable account id first (user_identities). An email
 * is only used to find or create an account when the provider vouches for it: Google's
 * `email_verified`, a personal Microsoft account, a Microsoft directory the superadmin pinned,
 * or Microsoft's `xms_edov` claim. Unverified work-account emails are refused, which blocks
 * the "nOAuth" takeover (an attacker setting a victim's email on their own Entra account).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { userIdentities, type User, type UserIdentity } from "@shared/schema";
import { db } from "../db";
import { decryptSecret } from "../lib/crypto";
import { publicBaseUrl } from "../lib/tokens";
import { systemConfig } from "./system-config.service";

export type SsoProvider = "google" | "microsoft";
export const SSO_PROVIDERS: SsoProvider[] = ["google", "microsoft"];
export const isSsoProvider = (p: unknown): p is SsoProvider => p === "google" || p === "microsoft";

/** Personal Microsoft accounts (outlook.com, hotmail.com, …) all sign in through this directory. */
export const MSA_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const MULTI_TENANT = new Set(["common", "organizations", "consumers"]);

export interface SsoSettings {
  provider: SsoProvider;
  clientId: string;
  clientSecret: string;
  tenant: string;
}

/** Overridable for tests. */
export const ssoEndpoints = {
  google: { authorize: () => "https://accounts.google.com/o/oauth2/v2/auth", token: () => "https://oauth2.googleapis.com/token" },
  microsoft: {
    authorize: (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    token: (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
  },
};

export const redirectUri = (p: SsoProvider) => `${publicBaseUrl()}/api/auth/${p}/callback`;

export async function ssoSettings(p: SsoProvider): Promise<SsoSettings | null> {
  const ext = (await systemConfig.get()).extensionSettings ?? {};
  const s = p === "google" ? ext.googleLogin : ext.microsoftLogin;
  if (!s?.enabled || !s.clientId || !s.clientSecret) return null;
  return { provider: p, clientId: s.clientId, clientSecret: decryptSecret(s.clientSecret), tenant: p === "microsoft" ? (ext.microsoftLogin?.tenant || "common") : "" };
}

export function authorizationUrl(s: SsoSettings, state: string, nonce: string): string {
  const url = new URL(s.provider === "google" ? ssoEndpoints.google.authorize() : ssoEndpoints.microsoft.authorize(s.tenant));
  url.search = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: redirectUri(s.provider),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
    ...(s.provider === "microsoft" ? { response_mode: "query" } : {}),
  }).toString();
  return url.toString();
}

export class SsoError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SsoProfile {
  provider: SsoProvider;
  subject: string;
  /** Lower-cased; null when the provider gave no usable email. */
  email: string | null;
  /** True when the provider vouches that the email belongs to this person. */
  emailTrusted: boolean;
  firstName: string | null;
  lastName: string | null;
}

type Claims = Record<string, unknown>;

function decodeJwtPayload(jwt: string): Claims {
  const part = jwt.split(".")[1];
  if (!part) throw new SsoError("failed", "malformed id_token");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Claims;
  } catch {
    throw new SsoError("failed", "malformed id_token");
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const looksLikeEmail = (v: string | null) => (v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : null);

/**
 * Checks the ID token's claims. The token comes straight from the provider's token endpoint
 * over TLS, which OpenID Connect Core §3.1.3.7 accepts in place of a signature check for
 * confidential clients; issuer, audience, expiry and nonce are still verified.
 */
export function profileFromClaims(s: SsoSettings, c: Claims, nonce: string, now = Date.now()): SsoProfile {
  if (c.aud !== s.clientId && !(Array.isArray(c.aud) && c.aud.includes(s.clientId))) throw new SsoError("failed", "id_token audience mismatch");
  if (typeof c.exp !== "number" || c.exp * 1000 < now - 60_000) throw new SsoError("failed", "id_token expired");
  if (c.nonce !== nonce) throw new SsoError("state", "id_token nonce mismatch");
  const first = str(c.given_name);
  const last = str(c.family_name);

  if (s.provider === "google") {
    if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") throw new SsoError("failed", "unexpected issuer");
    const sub = str(c.sub);
    if (!sub) throw new SsoError("failed", "missing subject");
    const email = looksLikeEmail(str(c.email));
    return { provider: "google", subject: sub, email, emailTrusted: Boolean(email && c.email_verified === true), firstName: first, lastName: last };
  }

  const tid = str(c.tid);
  const oid = str(c.oid);
  if (!tid || !oid) throw new SsoError("failed", "missing tenant or object id");
  if (c.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new SsoError("failed", "unexpected issuer");
  const pinned = !MULTI_TENANT.has(s.tenant.toLowerCase());
  // A directory id pin must match exactly; domain pins are enforced by Microsoft's authority URL.
  if (pinned && /^[0-9a-f-]{36}$/i.test(s.tenant) && tid.toLowerCase() !== s.tenant.toLowerCase()) throw new SsoError("tenant", "account from another directory");
  if (s.tenant === "consumers" && tid !== MSA_TENANT) throw new SsoError("tenant", "work accounts aren't allowed");
  if (s.tenant === "organizations" && tid === MSA_TENANT) throw new SsoError("tenant", "personal accounts aren't allowed");

  const trusted = tid === MSA_TENANT || pinned || c.xms_edov === true || c.xms_edov === "1" || c.xms_edov === 1;
  // preferred_username is the sign-in name (often the UPN); only used when the account is trusted.
  const email = looksLikeEmail(str(c.email)) ?? (trusted ? looksLikeEmail(str(c.preferred_username)) : null);
  const [nameFirst, ...rest] = (str(c.name) ?? "").split(/\s+/);
  return { provider: "microsoft", subject: `${tid}:${oid}`, email, emailTrusted: Boolean(email && trusted), firstName: first ?? (nameFirst || null), lastName: last ?? (rest.join(" ") || null) };
}

/** Exchanges the authorization code and returns the verified profile. */
export async function exchangeCode(s: SsoSettings, code: string, nonce: string): Promise<SsoProfile> {
  const tokenUrl = s.provider === "google" ? ssoEndpoints.google.token() : ssoEndpoints.microsoft.token(s.tenant);
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: s.clientId,
      client_secret: s.clientSecret,
      redirect_uri: redirectUri(s.provider),
      grant_type: "authorization_code",
      ...(s.provider === "microsoft" ? { scope: "openid email profile" } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const token = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !token.id_token) throw new SsoError("failed", token.error_description?.split("\n")[0] ?? token.error ?? `token exchange failed (${res.status})`);
  return profileFromClaims(s, decodeJwtPayload(token.id_token), nonce);
}

// ---------------------------------------------------------------------------
// Linked identities
// ---------------------------------------------------------------------------

export const identitiesRepository = {
  async find(provider: SsoProvider, subject: string): Promise<UserIdentity | undefined> {
    const [row] = await db.select().from(userIdentities).where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject))).limit(1);
    return row;
  },
  listForUser(userId: string) {
    return db.select().from(userIdentities).where(eq(userIdentities.userId, userId));
  },
  async link(user: Pick<User, "id">, p: SsoProfile) {
    await db.insert(userIdentities).values({ id: randomUUID(), userId: user.id, provider: p.provider, subject: p.subject, email: p.email, lastLoginAt: new Date() });
  },
  async touch(id: string, email: string | null) {
    await db.update(userIdentities).set({ lastLoginAt: new Date(), ...(email ? { email } : {}) }).where(eq(userIdentities.id, id));
  },
  async unlink(userId: string, provider: string) {
    const [res] = await db.delete(userIdentities).where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)));
    return res.affectedRows;
  },
};
