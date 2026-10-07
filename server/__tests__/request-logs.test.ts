import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app";
import { login, makeUser, mockDirectory, mockSystemConfig, PASSWORD } from "./helpers";
import { REDACTED, redactHeaders, redactText, redactValue, truncate, MAX_BODY_CHARS } from "../lib/redact";
import { requestLogsRepository, type NewRequestLog } from "../repositories/request-logs.repository";
import { flushRequestLogs } from "../services/request-log.service";

const admin = makeUser({ username: "l_admin", role: "admin" });
const root = makeUser({ username: "l_root", role: "superadmin" });
let app: Express;

/** Rows written since the last call (flushes the buffer first). */
async function written(): Promise<NewRequestLog[]> {
  await new Promise((r) => setTimeout(r, 20)); // settings lookup runs after "finish"
  await flushRequestLogs();
  const spy = vi.mocked(requestLogsRepository.insertMany);
  const rows = spy.mock.calls.flatMap((c) => c[0]);
  spy.mockClear();
  return rows;
}

beforeEach(async () => {
  mockDirectory([admin, root]);
  app = createApp().app;
  await written();
});
afterEach(() => vi.restoreAllMocks());

describe("redaction", () => {
  it("replaces credentials, tokens and codes but keeps ordinary fields", () => {
    const out = redactValue(
      { username: "a", password: "x", nested: { newPassword: "y", accessToken: "t", apiKey: "k" }, list: [{ clientSecret: "s" }], couponCode: "SAVE10", cookieLifespanDays: 30 },
      "/api/x",
    );
    expect(out).toEqual({
      username: "a",
      password: REDACTED,
      nested: { newPassword: REDACTED, accessToken: REDACTED, apiKey: REDACTED },
      list: [{ clientSecret: REDACTED }],
      couponCode: "SAVE10",
      cookieLifespanDays: 30,
    });
  });

  it("treats code and state as secrets only on verification / OAuth paths", () => {
    expect(redactValue({ code: "123456" }, "/api/users/verifyEmail")).toEqual({ code: REDACTED });
    expect(redactValue({ code: "abc", state: "xyz" }, "/api/auth/google/callback")).toEqual({ code: REDACTED, state: REDACTED });
    expect(redactValue({ code: "SPRING25" }, "/api/superadmin/coupons")).toEqual({ code: "SPRING25" });
  });

  it("redacts headers and unparseable text", () => {
    expect(redactHeaders({ Cookie: "sid=1", "X-CSRF-Token": "t", Authorization: "Bearer x", "Content-Type": "application/json" })).toEqual({
      cookie: REDACTED,
      "x-csrf-token": REDACTED,
      authorization: REDACTED,
      "content-type": "application/json",
    });
    expect(redactText('{"user":"a","password":"hunter2","tok')).toBe(`{"user":"a","password":"${REDACTED}","tok`);
    expect(redactText("username=a&password=hunter2")).toBe(`username=a&password=${REDACTED}`);
    expect(redactText("Authorization: Bearer abc.def")).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("truncates long bodies with a marker", () => {
    const t = truncate("x".repeat(MAX_BODY_CHARS + 10), 999999);
    expect(t.length).toBeLessThan(MAX_BODY_CHARS + 100);
    expect(t).toMatch(/truncated; 999999 bytes in total/);
  });
});

describe("capture", () => {
  it("stores the request and response with timing, never the password or token", async () => {
    await request(app).post("/api/auth/login").send({ username: "l_admin", password: PASSWORD }).expect(200);
    const [row] = (await written()).filter((r) => r.path === "/api/auth/login");
    expect(row).toMatchObject({ method: "POST", statusCode: 200, aborted: false, userId: admin.id });
    expect(JSON.parse(row.requestBody!)).toEqual({ username: "l_admin", password: REDACTED });
    const body = JSON.parse(row.responseBody!);
    expect(body.user.username).toBe("l_admin");
    expect(body.csrfToken).toBe(REDACTED);
    expect(row.responseBody).not.toContain(PASSWORD);
    expect(row.responseHeaders?.["set-cookie"]).toBe(REDACTED);
    expect(row.requestedAt!.getTime()).toBeLessThanOrEqual(row.respondedAt!.getTime());
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.responseSize).toBeGreaterThan(0);
  });

  it("records the signed-in user, query and error responses", async () => {
    const s = await login(app, "l_admin");
    await written();
    await s.agent.get("/api/superadmin/coupons?search=x&page=2").expect(403);
    const [row] = await written();
    expect(row).toMatchObject({ method: "GET", path: "/api/superadmin/coupons", statusCode: 403, username: "l_admin", role: "admin", query: { search: "x", page: "2" } });
    expect(JSON.parse(row.responseBody!).code).toBe("FORBIDDEN");
    expect(row.requestHeaders?.cookie).toBe(REDACTED);
  });

  it("skips bodies when body capture is off, and excluded paths entirely", async () => {
    mockSystemConfig({ requestLogSettings: { enabled: true, captureBodies: false, retentionDays: 7, excludePaths: ["/api/csrf-token"] } });
    await request(app).post("/api/auth/login").send({ username: "nobody", password: "x" }).expect(401);
    await request(app).get("/api/csrf-token").expect(200);
    const rows = await written();
    expect(rows.map((r) => r.path)).toEqual(["/api/auth/login"]);
    expect(rows[0]).toMatchObject({ statusCode: 401, requestBody: null, responseBody: null });
  });

  it("logs nothing when disabled, and never logs the log viewer", async () => {
    const s = await login(app, "l_root");
    vi.spyOn(requestLogsRepository, "list").mockResolvedValue({ rows: [], total: 0 });
    await written();
    await s.agent.get("/api/superadmin/request-logs").expect(200);
    expect(await written()).toEqual([]);
    mockSystemConfig({ requestLogSettings: { enabled: false } });
    await request(app).get("/api/csrf-token").expect(200);
    expect(await written()).toEqual([]);
  });

  it("does not log pages and assets outside the API", async () => {
    await request(app).get("/robots.txt");
    expect(await written()).toEqual([]);
  });
});

describe("viewer access", () => {
  it("is superadmin-only", async () => {
    const s = await login(app, "l_admin");
    await s.agent.get("/api/superadmin/request-logs").expect(403);
    await s.agent.get("/api/superadmin/request-logs/1").expect(403);
    await s.agent.post("/api/superadmin/request-logs/clear").set("X-CSRF-Token", s.csrf).send({}).expect(403);
  });

  it("validates filters", async () => {
    const s = await login(app, "l_root");
    await s.agent.get("/api/superadmin/request-logs?status=abc").expect(400);
    await s.agent.get("/api/superadmin/request-logs?method=TRACE").expect(400);
  });
});
