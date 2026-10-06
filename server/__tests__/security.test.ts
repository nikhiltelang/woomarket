import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { DEFAULT_TEAM_PERMISSIONS } from "@shared/roles";
import { createApp } from "../app";
import { login, makeChannel, makeUser, mockDirectory } from "./helpers";
import { contactsRepository } from "../repositories/contacts.repository";
import { verifySignature } from "../services/webhook-handler";
import { isWithinServiceWindow } from "../services/messaging.service";
import { buildParams, resolveVariable } from "../services/campaign.service";
import { countTemplateVariables, renderTemplateBody } from "../repositories/templates.repository";
import { decryptSecret, encryptSecret } from "../lib/crypto";

const adminA = makeUser({ username: "admin_a", role: "admin" });
const adminB = makeUser({ username: "admin_b", role: "admin" });
const agentA = makeUser({ username: "agent_a", role: "team", createdBy: adminA.id, permissions: [...DEFAULT_TEAM_PERMISSIONS] });
const restrictedA = makeUser({ username: "restricted_a", role: "team", createdBy: adminA.id, permissions: ["inbox:view"] });
const inactive = makeUser({ username: "inactive_user", status: "inactive" });
const superadmin = makeUser({ username: "root", role: "superadmin" });
const channelA = makeChannel({ createdBy: adminA.id });
const channelB = makeChannel({ createdBy: adminB.id });

let app: Express;

beforeEach(() => {
  mockDirectory([adminA, adminB, agentA, restrictedA, inactive, superadmin], [channelA, channelB]);
  vi.spyOn(contactsRepository, "list").mockResolvedValue({ rows: [], total: 0 });
  app = createApp().app;
});

afterEach(() => vi.restoreAllMocks());

describe("authentication", () => {
  it("returns 401 for API calls without a session or token", async () => {
    const res = await request(app).get(`/api/contacts?channelId=${channelA.id}`).expect(401);
    expect(res.body).toMatchObject({ success: false, code: "UNAUTHORIZED" });
  });

  it("rejects a wrong password with a generic message", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "admin_a", password: "nope" }).expect(401);
    expect(res.body.message).toBe("Invalid username or password");
    await request(app).post("/api/auth/login").send({ username: "ghost", password: "nope" }).expect(401);
  });

  it("refuses inactive accounts", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "inactive_user", password: "Passw0rd!" }).expect(403);
    expect(res.body.code).toBe("ACCOUNT_INACTIVE");
  });

  it("drops the session as soon as a user is deactivated", async () => {
    const s = await login(app, "admin_a");
    await s.agent.get(`/api/contacts?channelId=${channelA.id}`).expect(200);
    adminA.status = "inactive";
    try {
      await s.agent.get(`/api/contacts?channelId=${channelA.id}`).expect(401);
    } finally {
      adminA.status = "active";
    }
  });

  it("accepts a bearer token without cookies and without CSRF", async () => {
    const { token } = await login(app, "admin_a");
    await request(app).get(`/api/contacts?channelId=${channelA.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    // State-changing call: passes CSRF (bearer) and reaches validation (400), not 403.
    const res = await request(app).post("/api/contacts").set("Authorization", `Bearer ${token}`).send({ channelId: channelA.id }).expect(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  it("rejects a forged bearer token", async () => {
    await request(app).get(`/api/contacts?channelId=${channelA.id}`).set("Authorization", "Bearer not.a.jwt").expect(401);
  });
});

describe("csrf", () => {
  it("rejects session-authenticated writes without the token", async () => {
    const s = await login(app, "admin_a");
    const res = await s.agent.post("/api/contacts").send({ channelId: channelA.id, name: "X", phone: "+14155550123" }).expect(403);
    expect(res.body.code).toBe("CSRF_INVALID");
  });

  it("rotates the token on login (fixation protection)", async () => {
    const agent = request.agent(app);
    const before = (await agent.get("/api/csrf-token").expect(200)).body.csrfToken;
    const res = await agent.post("/api/auth/login").send({ username: "admin_a", password: "Passw0rd!" }).expect(200);
    expect(res.body.csrfToken).not.toBe(before);
    await agent.post("/api/groups").set("X-CSRF-Token", before).send({ name: "x" }).expect(403);
  });
});

describe("authorization", () => {
  it("blocks tenant admins from superadmin endpoints", async () => {
    const s = await login(app, "admin_a");
    await s.agent.get("/api/admin/users").expect(403);
    await s.agent.get("/api/superadmin/dashboard-overview").expect(403);
  });

  it("requires the specific permission (no implicit bypass)", async () => {
    const s = await login(app, "restricted_a");
    const res = await s.agent.get(`/api/contacts?channelId=${channelA.id}`).expect(403);
    expect(res.body.code).toBe("MISSING_PERMISSION");
  });

  it("lets team members act inside their admin's tenant", async () => {
    const s = await login(app, "agent_a");
    await s.agent.get(`/api/contacts?channelId=${channelA.id}`).expect(200);
  });
});

describe("tenant isolation", () => {
  it("returns 404 (not 403) for another tenant's channel", async () => {
    const s = await login(app, "admin_a");
    const res = await s.agent.get(`/api/contacts?channelId=${channelB.id}`).expect(404);
    expect(res.body.message).toBe("Channel not found");
    expect(contactsRepository.list).not.toHaveBeenCalled();
  });

  it("applies to team members too", async () => {
    const s = await login(app, "agent_a");
    await s.agent.get(`/api/contacts?channelId=${channelB.id}`).expect(404);
  });

  it("hides another tenant's contact by id", async () => {
    vi.spyOn(contactsRepository, "findById").mockResolvedValue({ id: crypto.randomUUID(), channelId: channelB.id } as never);
    const s = await login(app, "admin_a");
    await s.agent.get(`/api/contacts/${crypto.randomUUID()}`).expect(404);
  });
});

describe("webhooks", () => {
  const body = JSON.stringify({ object: "page", entry: [] });
  const sign = (b: string, secret = "test-app-secret") => `sha256=${crypto.createHmac("sha256", secret).update(b).digest("hex")}`;

  it("answers Meta's verification challenge only with the right token", async () => {
    const ok = await request(app).get("/webhook/global").query({ "hub.mode": "subscribe", "hub.verify_token": "test-verify-token", "hub.challenge": "12345" }).expect(200);
    expect(ok.text).toBe("12345");
    await request(app).get("/webhook/global").query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" }).expect(403);
  });

  it("rejects events with a bad signature and accepts a valid one", async () => {
    await request(app).post("/webhook/global").set("Content-Type", "application/json").set("X-Hub-Signature-256", sign(body, "wrong")).send(body).expect(401);
    await request(app).post("/webhook/global").set("Content-Type", "application/json").send(body).expect(401);
    await request(app).post("/webhook/global").set("Content-Type", "application/json").set("X-Hub-Signature-256", sign(body)).send(body).expect(200);
  });

  it("verifySignature uses the raw bytes", () => {
    const raw = Buffer.from('{"a":1}');
    expect(verifySignature(raw, sign('{"a":1}'), "test-app-secret")).toBe(true);
    expect(verifySignature(Buffer.from('{"a": 1}'), sign('{"a":1}'), "test-app-secret")).toBe(false);
  });
});

describe("domain rules", () => {
  it("enforces the 24-hour customer service window", () => {
    const now = Date.now();
    const conv = (hoursAgo: number | null) => ({ lastIncomingMessageAt: hoursAgo === null ? null : new Date(now - hoursAgo * 3600_000) }) as never;
    expect(isWithinServiceWindow(conv(1), now)).toBe(true);
    expect(isWithinServiceWindow(conv(23.9), now)).toBe(true);
    expect(isWithinServiceWindow(conv(24.1), now)).toBe(false);
    expect(isWithinServiceWindow(conv(null), now)).toBe(false);
  });

  it("maps campaign variables from contact fields and fixed text", () => {
    const contact = { name: "Priya", phone: "+919812345601", email: null } as never;
    expect(resolveVariable("field:name", contact)).toBe("Priya");
    expect(resolveVariable("static:20% off", contact)).toBe("20% off");
    expect(buildParams(3, { "1": "field:name", "2": "field:email", "3": "field:phone" }, contact)).toEqual(["Priya", "-", "+919812345601"]);
  });

  it("counts and renders template placeholders", () => {
    expect(countTemplateVariables("Hi {{1}}, order {{2}} ships {{ 2 }}")).toBe(2);
    expect(renderTemplateBody("Hi {{1}}, code {{2}}", ["Ana", "X1"])).toBe("Hi Ana, code X1");
  });

  it("round-trips encrypted secrets", () => {
    const enc = encryptSecret("EAAG-secret-token");
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(enc)).toBe("EAAG-secret-token");
    expect(decryptSecret("legacy-plaintext")).toBe("legacy-plaintext");
  });
});
