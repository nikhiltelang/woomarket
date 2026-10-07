import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app";
import { makeSystemConfig, makeUser, mockDirectory, PASSWORD } from "./helpers";
import { base32Decode, base32Encode, generateSecret, hotp, otpauthUrl, totp, verifyTotp, currentStep } from "../lib/totp";
import { encryptStoredSecret } from "../lib/crypto";
import { systemConfig } from "../services/system-config.service";
import { twoFactorRepository } from "../services/two-factor.service";
import type { UserTwoFactor } from "@shared/schema";

describe("TOTP (RFC 6238 vectors)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it("matches the reference codes", () => {
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(totp(secret, 59_000)).toBe("287082");
    expect(totp(secret, 1111111109_000)).toBe("081804");
    expect(totp(secret, 1234567890_000)).toBe("005924");
    expect(totp(secret, 2000000000_000)).toBe("279037");
  });
  it("accepts one step of drift, refuses replays and junk", () => {
    const now = 1234567890_000;
    const prev = hotp(secret, currentStep(now) - 1);
    expect(verifyTotp(secret, prev, { now })).toBe(currentStep(now) - 1);
    expect(verifyTotp(secret, hotp(secret, currentStep(now) - 2), { now })).toBeNull();
    expect(verifyTotp(secret, totp(secret, now), { now, notAfterStep: currentStep(now) })).toBeNull();
    expect(verifyTotp(secret, "12345", { now })).toBeNull();
    expect(generateSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl(secret, "a@b.c", "Woo Market")).toBe(`otpauth://totp/Woo%20Market:a%40b.c?secret=${secret}&issuer=Woo+Market&algorithm=SHA1&digits=6&period=30`);
  });
});

// --- Sign-in flow ---------------------------------------------------------------------------

const SECRET = generateSecret();
const recovery = "abcde-fghjk";
const sha = (c: string) => crypto.createHash("sha256").update(c.replace(/-/g, "")).digest("hex");
const withTfa = makeUser({ username: "secure_admin", twoFactorEnabledAt: new Date() });
const plainAdmin = makeUser({ username: "plain_admin" });
let row: UserTwoFactor;
let app: Express;

beforeEach(() => {
  mockDirectory([withTfa, plainAdmin]);
  row = { userId: withTfa.id, secret: encryptStoredSecret(SECRET), pendingSecret: null, recoveryCodes: [sha(recovery)], lastUsedStep: null, updatedAt: new Date() };
  vi.spyOn(twoFactorRepository, "get").mockImplementation(async (id) => (id === row.userId ? row : undefined));
  vi.spyOn(twoFactorRepository, "claimStep").mockImplementation(async (_id, step) => {
    if (row.lastUsedStep != null && row.lastUsedStep >= step) return false;
    row.lastUsedStep = step;
    return true;
  });
  vi.spyOn(twoFactorRepository, "consumeRecoveryCode").mockImplementation(async (_id, _codes, used) => {
    if (!row.recoveryCodes!.includes(used)) return false;
    row.recoveryCodes = row.recoveryCodes!.filter((c) => c !== used);
    return true;
  });
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

async function passwordStep(agent: ReturnType<typeof request.agent>, username = "secure_admin") {
  return agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
}

describe("two-step sign-in", () => {
  it("asks for a code instead of signing in, and gives no token or session yet", async () => {
    const agent = request.agent(app);
    const res = await passwordStep(agent);
    expect(res.body).toEqual({ twoFactorRequired: true });
    await agent.get("/api/auth/2fa").expect(401);
  });

  it("signs in with a valid code and refuses the same code twice", async () => {
    const agent = request.agent(app);
    await passwordStep(agent);
    const code = totp(SECRET);
    const ok = await agent.post("/api/auth/2fa/verify").send({ code }).expect(200);
    expect(ok.body.user.username).toBe("secure_admin");
    expect(ok.body.token).toBeTruthy();
    const other = request.agent(app);
    await passwordStep(other);
    const replay = await other.post("/api/auth/2fa/verify").send({ code }).expect(422);
    expect(replay.body.code).toBe("INVALID_CODE");
  });

  it("accepts a recovery code once", async () => {
    const a = request.agent(app);
    await passwordStep(a);
    const ok = await a.post("/api/auth/2fa/verify").send({ code: recovery.toUpperCase() }).expect(200);
    expect(ok.body.recoveryCodesLeft).toBe(0);
    const b = request.agent(app);
    await passwordStep(b);
    await b.post("/api/auth/2fa/verify").send({ code: recovery }).expect(422);
  });

  it("locks the attempt after five wrong codes", async () => {
    const agent = request.agent(app);
    await passwordStep(agent);
    for (let i = 0; i < 5; i++) await agent.post("/api/auth/2fa/verify").send({ code: "000000" }).expect(422);
    const locked = await agent.post("/api/auth/2fa/verify").send({ code: totp(SECRET) }).expect(429);
    expect(locked.body.code).toBe("TWO_FACTOR_LOCKED");
    await agent.post("/api/auth/2fa/verify").send({ code: totp(SECRET) }).expect(401);
  });

  it("needs the password step first", async () => {
    const res = await request(app).post("/api/auth/2fa/verify").send({ code: totp(SECRET) }).expect(401);
    expect(res.body.code).toBe("TWO_FACTOR_EXPIRED");
  });
});

describe("required by policy", () => {
  it("holds admins without 2FA at setup", async () => {
    vi.spyOn(systemConfig, "get").mockResolvedValue(makeSystemConfig({ twoFactorPolicy: "admins" }));
    const agent = request.agent(app);
    const login = await passwordStep(agent, "plain_admin");
    const csrf = login.body.csrfToken;
    const blocked = await agent.get("/api/groups").expect(403);
    expect(blocked.body.code).toBe("TWO_FACTOR_SETUP_REQUIRED");
    vi.spyOn(twoFactorRepository, "upsert").mockResolvedValue();
    const setup = await agent.post("/api/auth/2fa/setup").set("X-CSRF-Token", csrf).expect(200);
    expect(setup.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
  });

  it("only applies to the superadmin under the superadmin policy", async () => {
    vi.spyOn(systemConfig, "get").mockResolvedValue(makeSystemConfig({ twoFactorPolicy: "superadmin" }));
    const agent = request.agent(app);
    await passwordStep(agent, "plain_admin");
    const res = await agent.get("/api/groups");
    expect(res.status).not.toBe(403);
  });
});
