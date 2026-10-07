import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { apiSendSchema, stringToSign } from "@shared/public-api";
import type { ApiKey } from "@shared/schema";
import { createApp } from "../app";
import { login, makeUser, mockDirectory } from "./helpers";
import { apiKeysRepository } from "../repositories/api-keys.repository";
import * as publicApi from "../services/public-api.service";
import * as levels from "../services/levels.service";

const admin = makeUser({ username: "k_admin", role: "admin" });
const agent = makeUser({ username: "k_agent", role: "team", createdBy: admin.id });
const SECRET = "s3cr3t-Value_with-40-characters-long-xyz";
const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

const makeKey = (o: Partial<ApiKey> = {}): ApiKey => ({
  id: crypto.randomUUID(),
  userId: admin.id,
  createdBy: admin.id,
  name: "Shop backend",
  accessKeyId: "AKWMTESTKEY000000001",
  secretHash: sha(SECRET),
  secretEncrypted: SECRET, // stored as-is when no ENCRYPTION_KEY is configured
  secretLast4: SECRET.slice(-4),
  channels: ["email", "sms", "whatsapp"],
  defaultChannelId: null,
  status: "active",
  expiresAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  requestCount: 0,
  revokedAt: null,
  createdAt: new Date(),
  ...o,
});

const body = { channel: "email", subject: "Order shipped", html: "<p>Hi {{name}}</p>", recipients: ["ada@example.test", { email: "grace@example.test", name: "Grace" }] };
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
const okResult = { id: "c1", channel: "email" as const, name: "API", status: "sending", scheduledAt: null, testMode: true, recipients: { requested: 2, accepted: 2, rejected: [] } };

function signed(key: ApiKey, payload: unknown, opts: { ts?: number; secret?: string; path?: string } = {}) {
  const raw = JSON.stringify(payload);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", opts.secret ?? SECRET).update(stringToSign(ts, "POST", opts.path ?? "/api/v1/send", sha(raw))).digest("hex");
  return { raw, headers: { "Content-Type": "application/json", "X-WM-Access-Key-Id": key.accessKeyId, "X-WM-Timestamp": ts, "X-WM-Signature": sig } };
}

let app: Express;
let key: ApiKey;
let send: MockInstance<typeof publicApi.sendViaApi>;

beforeEach(() => {
  mockDirectory([admin, agent]);
  key = makeKey();
  vi.spyOn(apiKeysRepository, "findByAccessKeyId").mockImplementation(async (id) => (id === key.accessKeyId ? key : undefined));
  vi.spyOn(apiKeysRepository, "touch").mockResolvedValue();
  const used = new Set<string>();
  vi.spyOn(apiKeysRepository, "claimSignature").mockImplementation(async (s) => !used.has(s) && Boolean(used.add(s)));
  send = vi.spyOn(publicApi, "sendViaApi").mockResolvedValue(okResult);
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

describe("authentication", () => {
  it("accepts Basic auth with the Access Key ID and Secret Access Key", async () => {
    const res = await request(app).post("/api/v1/send").set("Authorization", basic(key.accessKeyId, SECRET)).send(body).expect(202);
    expect(res.body.data).toEqual(okResult);
    expect(send.mock.calls[0][0]).toBe(key);
  });

  it("needs no session cookie or CSRF token", async () => {
    await request(app).post("/api/v1/send").set("Authorization", basic(key.accessKeyId, SECRET)).send(body).expect(202);
  });

  it("rejects missing, unknown and wrong credentials alike", async () => {
    expect((await request(app).post("/api/v1/send").send(body).expect(401)).body.code).toBe("MISSING_CREDENTIALS");
    expect((await request(app).post("/api/v1/send").set("Authorization", basic("AKWMNOSUCHKEY0000000", SECRET)).send(body).expect(401)).body.code).toBe("INVALID_CREDENTIALS");
    expect((await request(app).post("/api/v1/send").set("Authorization", basic(key.accessKeyId, "wrong")).send(body).expect(401)).body.code).toBe("INVALID_CREDENTIALS");
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed request and refuses to replay it", async () => {
    const s = signed(key, body);
    await request(app).post("/api/v1/send").set(s.headers).send(s.raw).expect(202);
    expect((await request(app).post("/api/v1/send").set(s.headers).send(s.raw).expect(401)).body.code).toBe("REPLAYED_REQUEST");
  });

  it("rejects a tampered body, wrong secret and stale timestamp", async () => {
    const s = signed(key, body);
    expect((await request(app).post("/api/v1/send").set(s.headers).send(JSON.stringify({ ...body, subject: "changed" })).expect(401)).body.code).toBe("INVALID_SIGNATURE");
    const w = signed(key, body, { secret: "not-the-secret" });
    expect((await request(app).post("/api/v1/send").set(w.headers).send(w.raw).expect(401)).body.code).toBe("INVALID_SIGNATURE");
    const old = signed(key, body, { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect((await request(app).post("/api/v1/send").set(old.headers).send(old.raw).expect(401)).body.code).toBe("TIMESTAMP_OUT_OF_RANGE");
  });

  it("refuses revoked and expired keys, and inactive accounts", async () => {
    key = makeKey({ status: "revoked" });
    expect((await request(app).post("/api/v1/send").set("Authorization", basic(key.accessKeyId, SECRET)).send(body).expect(401)).body.code).toBe("KEY_REVOKED");
    key = makeKey({ expiresAt: new Date(Date.now() - 1000) });
    expect((await request(app).post("/api/v1/send").set("Authorization", basic(key.accessKeyId, SECRET)).send(body).expect(401)).body.code).toBe("KEY_EXPIRED");
    mockDirectory([{ ...admin, status: "banned" }]);
    key = makeKey();
    expect((await request(app).post("/api/v1/send").set("Authorization", basic(key.accessKeyId, SECRET)).send(body).expect(403)).body.code).toBe("ACCOUNT_INACTIVE");
  });
});

describe("request handling", () => {
  it("validates the payload per channel", async () => {
    const auth = basic(key.accessKeyId, SECRET);
    const bad = await request(app).post("/api/v1/send").set("Authorization", auth).send({ channel: "sms", recipients: ["4155550123"], message: "hi" }).expect(400);
    expect(JSON.stringify(bad.body.details)).toMatch(/international format/);
    await request(app).post("/api/v1/send").set("Authorization", auth).send({ channel: "email", subject: "x", recipients: ["a@b.test"] }).expect(400);
    await request(app).post("/api/v1/send").set("Authorization", auth).send({ channel: "fax", recipients: ["x"] }).expect(400);
    await request(app).post("/api/v1/send").set("Authorization", auth).send({ ...body, recipients: Array.from({ length: 1001 }, (_, i) => `u${i}@x.test`) }).expect(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("normalises recipients", () => {
    const v = apiSendSchema.parse({ channel: "whatsapp", template: { name: "order_update" }, recipients: ["+1 (415) 555-0123", { phone: "+447700900001", variables: ["A-1"] }] });
    expect(v.recipients).toEqual([{ phone: "+14155550123" }, { phone: "+447700900001", variables: ["A-1"] }].map((r) => expect.objectContaining(r)));
  });

  it("replays the first response for a repeated Idempotency-Key", async () => {
    const store = new Map<string, { id: number; requestHash: string; statusCode: number; response: unknown }>();
    vi.spyOn(apiKeysRepository, "saveIdempotent").mockImplementation(async (v) => (store.has(v.idempotencyKey) ? false : (store.set(v.idempotencyKey, { id: store.size + 1, ...v }), true)));
    vi.spyOn(apiKeysRepository, "findIdempotent").mockImplementation(async (_k, i) => store.get(i) as never);
    vi.spyOn(apiKeysRepository, "completeIdempotent").mockImplementation(async (id, statusCode, response) => {
      for (const v of store.values()) if (v.id === id) Object.assign(v, { statusCode, response });
    });
    const auth = basic(key.accessKeyId, SECRET);
    const first = await request(app).post("/api/v1/send").set("Authorization", auth).set("Idempotency-Key", "order-42").send(body).expect(202);
    const again = await request(app).post("/api/v1/send").set("Authorization", auth).set("Idempotency-Key", "order-42").send(body).expect(202);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(send).toHaveBeenCalledTimes(1);
    const other = await request(app).post("/api/v1/send").set("Authorization", auth).set("Idempotency-Key", "order-42").send({ ...body, subject: "Different" }).expect(409);
    expect(other.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("enforces the level's API access and the key's channels", async () => {
    send.mockRestore();
    vi.spyOn(levels, "tenantLevel").mockResolvedValue({ name: "Starter", apiAccess: false } as never);
    expect((await request(app).post("/api/v1/send").set("Authorization", basic(key.accessKeyId, SECRET)).send(body).expect(403)).body.code).toBe("API_NOT_INCLUDED");
    vi.spyOn(levels, "tenantLevel").mockResolvedValue(undefined);
    key = makeKey({ channels: ["sms"] });
    expect((await request(app).post("/api/v1/send").set("Authorization", basic(key.accessKeyId, SECRET)).send(body).expect(403)).body.code).toBe("CHANNEL_NOT_ALLOWED");
  });

  it("returns JSON 404 for unknown v1 paths", async () => {
    expect((await request(app).get("/api/v1/nothing").expect(404)).body.code).toBe("NOT_FOUND");
  });
});

describe("key management", () => {
  it("lets tenant admins create a key and shows the secret once", async () => {
    vi.spyOn(apiKeysRepository, "listByTenant").mockResolvedValue([]);
    const create = vi.spyOn(apiKeysRepository, "create").mockImplementation(async (v) => ({ ...makeKey(), ...v }) as ApiKey);
    const s = await login(app, "k_admin");
    const res = await s.agent.post("/api/api-keys").set("X-CSRF-Token", s.csrf).send({ name: "Shop", channels: ["email", "sms"] }).expect(201);
    expect(res.body.data.accessKeyId).toMatch(/^AKWM[A-Z0-9]{16}$/);
    expect(res.body.secretAccessKey).toHaveLength(40);
    const stored = create.mock.calls[0][0];
    expect(stored.secretHash).toBe(sha(res.body.secretAccessKey));
    expect(JSON.stringify(res.body.data)).not.toContain(res.body.secretAccessKey);
    expect(res.body.data).not.toHaveProperty("secretHash");
  });

  it("is admin-only", async () => {
    const s = await login(app, "k_agent");
    await s.agent.get("/api/api-keys").expect(403);
    await s.agent.post("/api/api-keys").set("X-CSRF-Token", s.csrf).send({ name: "x", channels: ["sms"] }).expect(403);
  });
});
