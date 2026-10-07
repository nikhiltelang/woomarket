import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app";
import { makeSystemConfig, makeUser, mockDirectory } from "./helpers";
import { systemConfig } from "../services/system-config.service";
import { usersRepository } from "../repositories/users.repository";
import { identitiesRepository, MSA_TENANT, profileFromClaims, type SsoSettings } from "../services/sso.service";
import type { UserIdentity } from "@shared/schema";

const ORG = "11111111-2222-3333-4444-555555555555";
const ms = (tenant = "common"): SsoSettings => ({ provider: "microsoft", clientId: "ms-client", clientSecret: "s", tenant });
const google: SsoSettings = { provider: "google", clientId: "g-client", clientSecret: "s", tenant: "" };
const exp = () => Math.floor(Date.now() / 1000) + 600;
const msClaims = (o: Record<string, unknown> = {}) => ({ aud: "ms-client", exp: exp(), nonce: "n1", tid: ORG, oid: "oid-1", iss: `https://login.microsoftonline.com/${ORG}/v2.0`, email: "Ann@Contoso.com", name: "Ann Lee", ...o });

describe("ID token checks", () => {
  it("accepts Google only with a verified email", () => {
    const base = { aud: "g-client", exp: exp(), nonce: "n1", iss: "https://accounts.google.com", sub: "g-1", email: "a@b.test", given_name: "A" };
    expect(profileFromClaims(google, { ...base, email_verified: true }, "n1")).toMatchObject({ subject: "g-1", email: "a@b.test", emailTrusted: true, firstName: "A" });
    expect(profileFromClaims(google, { ...base, email_verified: false }, "n1").emailTrusted).toBe(false);
  });

  it("rejects wrong audience, issuer, nonce or an expired token", () => {
    expect(() => profileFromClaims(ms(), msClaims({ aud: "other" }), "n1")).toThrow(/audience/);
    expect(() => profileFromClaims(ms(), msClaims({ iss: "https://evil.test/v2.0" }), "n1")).toThrow(/issuer/);
    expect(() => profileFromClaims(ms(), msClaims(), "n2")).toThrow(/nonce/);
    expect(() => profileFromClaims(ms(), msClaims({ exp: 1000 }), "n1")).toThrow(/expired/);
  });

  it("doesn't trust work-account emails on a multi-tenant app (nOAuth)", () => {
    const p = profileFromClaims(ms(), msClaims(), "n1");
    expect(p).toMatchObject({ subject: `${ORG}:oid-1`, email: "ann@contoso.com", emailTrusted: false, firstName: "Ann", lastName: "Lee" });
    expect(profileFromClaims(ms(), msClaims({ xms_edov: true }), "n1").emailTrusted).toBe(true);
    // Personal accounts are verified by Microsoft.
    const msa = profileFromClaims(ms(), msClaims({ tid: MSA_TENANT, iss: `https://login.microsoftonline.com/${MSA_TENANT}/v2.0` }), "n1");
    expect(msa.emailTrusted).toBe(true);
    // preferred_username is only a fallback for trusted accounts.
    expect(profileFromClaims(ms(), msClaims({ email: undefined, preferred_username: "ann@contoso.com" }), "n1").email).toBeNull();
  });

  it("trusts a pinned directory and rejects others", () => {
    expect(profileFromClaims(ms(ORG), msClaims(), "n1").emailTrusted).toBe(true);
    expect(() => profileFromClaims(ms("99999999-2222-3333-4444-555555555555"), msClaims(), "n1")).toThrow(/directory/);
    expect(() => profileFromClaims(ms("consumers"), msClaims(), "n1")).toThrow(/work accounts/);
  });
});

// --- Flow ------------------------------------------------------------------

const existing = makeUser({ username: "ann", email: "ann@contoso.com" });
let app: Express;
let identities: UserIdentity[];

function jwt(claims: Record<string, unknown>) {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b(claims)}.sig`;
}

async function signIn(agent: ReturnType<typeof request.agent>, claims: (nonce: string) => Record<string, unknown>, path = "/api/auth/microsoft") {
  const start = await agent.get(path).expect(302);
  const url = new URL(start.headers.location);
  expect(url.origin).toBe("https://login.microsoftonline.com");
  const state = url.searchParams.get("state")!;
  const nonce = url.searchParams.get("nonce")!;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ id_token: jwt(claims(nonce)) }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const cb = await agent.get(`/api/auth/microsoft/callback?code=abc&state=${state}`).expect(302);
  return { location: cb.headers.location as string, fetchSpy };
}

beforeEach(() => {
  mockDirectory([existing]);
  vi.spyOn(systemConfig, "get").mockResolvedValue(makeSystemConfig({ extensionSettings: { microsoftLogin: { enabled: true, clientId: "ms-client", clientSecret: "secret", tenant: "common" } } }));
  vi.spyOn(usersRepository, "update").mockImplementation(async (id, patch) => ({ ...existing, ...patch, id }) as never);
  identities = [];
  vi.spyOn(identitiesRepository, "find").mockImplementation(async (p, s) => identities.find((i) => i.provider === p && i.subject === s));
  vi.spyOn(identitiesRepository, "link").mockImplementation(async (u, p) => {
    identities.push({ id: String(identities.length + 1), userId: u.id, provider: p.provider, subject: p.subject, email: p.email, lastLoginAt: null, createdAt: new Date() });
  });
  vi.spyOn(identitiesRepository, "touch").mockResolvedValue();
  app = createApp().app;
});

afterEach(() => vi.restoreAllMocks());

describe("Microsoft sign-in flow", () => {
  it("sends the code to the token endpoint and signs in a verified account", async () => {
    const agent = request.agent(app);
    const { location, fetchSpy } = await signIn(agent, (nonce) => msClaims({ nonce, xms_edov: true }));
    expect(location).toBe("/dashboard");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(String((init as RequestInit).body)).toContain("code=abc");
    expect(identities).toHaveLength(1);
    // The session is signed in as Ann.
    const list = vi.spyOn(identitiesRepository, "listForUser").mockResolvedValue([]);
    await agent.get("/api/auth/identities").expect(200);
    expect(list).toHaveBeenCalledWith(existing.id);
  });

  it("refuses an unverified work email instead of taking over the account", async () => {
    const { location } = await signIn(request.agent(app), (nonce) => msClaims({ nonce }));
    expect(location).toBe("/login?error=microsoft_unverified");
    expect(identities).toHaveLength(0);
  });

  it("signs in by linked identity even without a trusted email", async () => {
    identities.push({ id: "1", userId: existing.id, provider: "microsoft", subject: `${ORG}:oid-1`, email: null, lastLoginAt: null, createdAt: new Date() });
    const { location } = await signIn(request.agent(app), (nonce) => msClaims({ nonce, email: "someone-else@contoso.com" }));
    expect(location).toBe("/dashboard");
  });

  it("rejects a forged state and a replayed nonce", async () => {
    const agent = request.agent(app);
    await agent.get("/api/auth/microsoft").expect(302);
    const bad = await agent.get("/api/auth/microsoft/callback?code=abc&state=forged").expect(302);
    expect(bad.headers.location).toBe("/login?error=microsoft_state");
    const { location } = await signIn(agent, () => msClaims({ nonce: "not-the-session-nonce", xms_edov: true }));
    expect(location).toBe("/login?error=microsoft_state");
  });

  it("redirects to sign-in when Microsoft isn't configured", async () => {
    vi.spyOn(systemConfig, "get").mockResolvedValue(makeSystemConfig());
    const res = await request(app).get("/api/auth/microsoft").expect(302);
    expect(res.headers.location).toBe("/login?error=microsoft_disabled");
  });
});
