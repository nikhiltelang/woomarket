import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { DEFAULT_TEAM_PERMISSIONS } from "@shared/roles";
import { passwordProblems, translate } from "@shared/platform";
import { createApp } from "../app";
import { login, makeChannel, makeUser, mockDirectory, mockSystemConfig } from "./helpers";
import { contactsRepository } from "../repositories/contacts.repository";
import { usersRepository } from "../repositories/users.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { levelsRepository, otpRepository } from "../repositories/platform.repository";
import * as systemMail from "../services/email/system-mail";
import * as levelsService from "../services/levels.service";
import { assertWithinLevel } from "../services/levels.service";
import { parseUserAgent } from "../repositories/stats.repository";
import { renderIndexHtml, systemConfig } from "../services/system-config.service";
import { panelRepository } from "../repositories/platform.repository";

const admin = makeUser({ username: "p_admin", role: "admin" });
const root = makeUser({ username: "p_root", role: "superadmin" });
const banned = makeUser({ username: "p_banned", status: "banned" });
const unverified = makeUser({ username: "p_unverified", isEmailVerified: false });
const agent = makeUser({ username: "p_agent", role: "team", createdBy: admin.id, permissions: [...DEFAULT_TEAM_PERMISSIONS] });
const channel = makeChannel({ createdBy: admin.id });
let app: Express;

beforeEach(() => {
  mockDirectory([admin, root, banned, unverified, agent], [channel]);
  vi.spyOn(contactsRepository, "list").mockResolvedValue({ rows: [], total: 0 });
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

describe("maintenance mode", () => {
  beforeEach(() => mockSystemConfig({ maintenanceMode: { enabled: true, title: "Upgrading", content: "Back at 10:00 UTC", bypassSecret: "letmein" } }));

  it("returns 503 with the configured message to tenants", async () => {
    const s = await login(app, "p_admin"); // sign-in itself stays available
    const res = await s.agent.get(`/api/contacts?channelId=${channel.id}`).expect(503);
    expect(res.body).toMatchObject({ code: "MAINTENANCE", title: "Upgrading", message: "Back at 10:00 UTC" });
    expect(res.headers["retry-after"]).toBe("600");
  });

  it("lets the superadmin keep working", async () => {
    const s = await login(app, "p_root");
    await s.agent.get("/api/admin/users/counts").expect((r) => expect(r.status).not.toBe(503));
  });

  it("keeps public config and auth endpoints reachable", async () => {
    await request(app).get("/api/csrf-token").expect(200);
    await request(app).post("/api/auth/login").send({ username: "x", password: "y" }).expect(401);
  });

  it("honours the bypass link only with the right secret", async () => {
    const agentReq = request.agent(app);
    await agentReq.get("/api/maintenance/bypass?secret=wrong").expect(403);
    await agentReq.get("/api/maintenance/bypass?secret=letmein").expect(302);
    const s = await login(app, "p_admin");
    await s.agent.get(`/api/contacts?channelId=${channel.id}`).expect(503); // different session → still blocked
  });
});

describe("sign-up and sign-in rules", () => {
  const body = { username: "newbie", email: "newbie@example.test", password: "weakpass" };

  it("refuses sign-up when registration is closed", async () => {
    mockSystemConfig({ userRegistration: false });
    const res = await request(app).post("/api/auth/signup").send(body).expect(403);
    expect(res.body.code).toBe("REGISTRATION_CLOSED");
  });

  it("requires accepting the terms when enabled", async () => {
    const cfg = mockSystemConfig({ agreePolicy: true });
    vi.spyOn(systemConfig, "public").mockResolvedValue({ ...(await systemConfig.public()), agreePolicy: Boolean(cfg.agreePolicy) });
    const res = await request(app).post("/api/auth/signup").send({ ...body, password: "Str0ngPass" }).expect(400);
    expect(res.body.code).toBe("TERMS_REQUIRED");
  });

  it("enforces password strength only when 'force secure password' is on", async () => {
    mockSystemConfig({ forceSecurePassword: true });
    const res = await request(app).post("/api/auth/signup").send(body).expect(400);
    expect(res.body.details.password[0]).toMatch(/uppercase/);
    expect(passwordProblems("Str0ngPass")).toBeNull();
    expect(passwordProblems("short")).toMatch(/8 characters/);
  });

  it("blocks banned accounts with a clear code", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "p_banned", password: "Passw0rd!" }).expect(403);
    expect(res.body.code).toBe("ACCOUNT_BANNED");
  });

  it("asks unverified users for a code when email verification is on", async () => {
    mockSystemConfig({ emailVerification: true });
    vi.spyOn(otpRepository, "recentCount").mockResolvedValue(0);
    vi.spyOn(otpRepository, "issue").mockResolvedValue("123456");
    const sent = vi.spyOn(systemMail, "sendSystemEmail").mockResolvedValue({ simulated: true });
    const res = await request(app).post("/api/auth/login").send({ username: "p_unverified", password: "Passw0rd!" }).expect(403);
    expect(res.body).toMatchObject({ code: "EMAIL_NOT_VERIFIED", details: { email: unverified.email } });
    expect(sent).toHaveBeenCalledWith(unverified.email, expect.stringContaining("123456"), expect.stringContaining("123456"));
  });

  it("verifies a correct code and signs the user in", async () => {
    vi.spyOn(otpRepository, "consume").mockImplementation(async (_id, code) => code === "654321");
    vi.spyOn(usersRepository, "update").mockImplementation(async () => ({ ...unverified, isEmailVerified: true }));
    await request(app).post("/api/users/verifyEmail").send({ email: unverified.email, code: "000000" }).expect(400);
    const res = await request(app).post("/api/users/verifyEmail").send({ email: unverified.email, code: "654321" }).expect(200);
    expect(res.body.csrfToken).toBeTruthy();
  });

  it("does not reveal whether an address exists on resend", async () => {
    const a = await request(app).post("/api/users/resend-verification").send({ email: "nobody@example.test" }).expect(200);
    expect(a.body.message).toMatch(/If that account/);
  });
});

describe("superadmin-only endpoints", () => {
  it("are refused to tenant admins", async () => {
    const s = await login(app, "p_admin");
    for (const path of ["/api/system-config", "/api/superadmin/levels", "/api/admin/users/counts", "/api/notifications", "/api/languages"]) {
      await s.agent.get(path).expect(403);
    }
  });

  it("notification inbox endpoints are available to every signed-in user", async () => {
    const s = await login(app, "p_agent");
    const { notificationsRepository } = await import("../repositories/platform.repository");
    vi.spyOn(notificationsRepository, "unreadCount").mockResolvedValue(3);
    expect((await s.agent.get("/api/notifications/unread-count").expect(200)).body.count).toBe(3);
  });
});

describe("access levels", () => {
  const level = { id: "l1", levelNumber: 1, name: "Starter", description: null, badgeColor: "gray", maxChannels: 1, maxContacts: 2, maxMessagesMonthly: 10, maxCampaigns: 1, aiAssistantEnabled: false, smsEnabled: false, emailEnabled: true, prioritySupport: false, apiAccess: false, whiteLabel: false, createdAt: null, updatedAt: null };

  beforeEach(() => {
    vi.spyOn(usersRepository, "findById").mockResolvedValue({ ...admin, accessLevel: 1 });
    vi.spyOn(levelsRepository, "findByNumber").mockResolvedValue(level);
  });

  it("caps counts and feature flags", async () => {
    vi.spyOn(channelsRepository, "countByTenant").mockResolvedValue(1);
    vi.spyOn(contactsRepository, "countByTenant").mockResolvedValue(1);
    await expect(assertWithinLevel(admin.id, "channel")).rejects.toMatchObject({ code: "LEVEL_LIMIT" });
    await expect(assertWithinLevel(admin.id, "contacts")).resolves.toBeUndefined();
    await expect(assertWithinLevel(admin.id, "contacts", 2)).rejects.toMatchObject({ code: "LEVEL_LIMIT" });
    await expect(assertWithinLevel(admin.id, "sms")).rejects.toMatchObject({ code: "LEVEL_FEATURE" });
    await expect(assertWithinLevel(admin.id, "email")).resolves.toBeUndefined();
  });

  it("treats -1 as unlimited and no level as no limits", async () => {
    vi.spyOn(levelsRepository, "findByNumber").mockResolvedValue({ ...level, maxChannels: -1 });
    vi.spyOn(channelsRepository, "countByTenant").mockResolvedValue(10_000);
    await expect(assertWithinLevel(admin.id, "channel")).resolves.toBeUndefined();
    vi.spyOn(usersRepository, "findById").mockResolvedValue({ ...admin, accessLevel: null });
    await expect(assertWithinLevel(admin.id, "sms")).resolves.toBeUndefined();
  });

  it("enforces the monthly message allowance", async () => {
    vi.spyOn(levelsService.levelUsage, "outboundMessagesThisMonth").mockResolvedValue(9);
    await expect(levelsService.assertMessageQuota(admin.id, 1)).resolves.toBeUndefined();
    await expect(levelsService.assertMessageQuota(admin.id, 2)).rejects.toMatchObject({ code: "LEVEL_LIMIT" });
    vi.spyOn(levelsService.levelUsage, "campaignsThisMonth").mockResolvedValue(1);
    await expect(assertWithinLevel(admin.id, "campaign")).rejects.toMatchObject({ code: "LEVEL_LIMIT" });
  });
});

describe("helpers", () => {
  it("parses common user agents", () => {
    expect(parseUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36")).toEqual({ browser: "Chrome", os: "macOS" });
    expect(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toEqual({ browser: "Safari", os: "iOS" });
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36 Edg/129.0")).toEqual({ browser: "Edge", os: "Windows" });
    expect(parseUserAgent("curl/8.4.0").browser).toBe("API client");
  });

  it("translates with English fallback and variables", () => {
    expect(translate({}, "nav.inbox")).toBe("Inbox");
    expect(translate({ "nav.inbox": "Bandeja" }, "nav.inbox")).toBe("Bandeja");
    expect(translate({}, "auth.signInTitle", { site: "Acme" })).toBe("Sign in to Acme");
    expect(translate({}, "unknown.key")).toBe("unknown.key");
  });

  it("escapes SEO values injected into the page shell", async () => {
    systemConfig.invalidate();
    mockSystemConfig({ siteTitle: "A&B <Store>", seoSettings: { metaDescription: '"><script>alert(1)</script>' }, customCss: "body{} </style><script>x</script>" });
    vi.spyOn(panelRepository, "get").mockResolvedValue({ id: "p", name: "A", favicon: "/uploads/branding/f.png" } as never);
    // renderIndexHtml reads the cached snapshot; feed it through the mocked repositories.
    const { systemConfigRepository, policyRepository, languagesRepository } = await import("../repositories/platform.repository");
    vi.spyOn(systemConfigRepository, "get").mockImplementation(() => systemConfig.get());
    vi.spyOn(policyRepository, "listPublished").mockResolvedValue([]);
    vi.spyOn(languagesRepository, "listEnabled").mockResolvedValue([]);
    const html = await renderIndexHtml('<html><head><title>x</title><link rel="icon" href="/favicon.svg" /></head><body></body></html>');
    expect(html).toContain("<title>A&amp;B &lt;Store&gt;</title>");
    expect(html).toContain('content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).not.toContain("</style><script>");
    expect(html).toContain('href="/uploads/branding/f.png"');
    systemConfig.invalidate();
  });
});
