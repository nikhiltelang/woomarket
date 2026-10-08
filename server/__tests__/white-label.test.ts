import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app";
import { makeUser, mockDirectory, PASSWORD } from "./helpers";
import { domainSchema, verificationRecord } from "@shared/white-label";
import { brandsRepository, dnsLookup, forgetBrandCache, verifyDomain } from "../services/white-label.service";
import { usersRepository } from "../repositories/users.repository";
import { billingRepository } from "../repositories/billing.repository";
import { levelsRepository } from "../repositories/platform.repository";
import type { Brand, BrandDomain } from "@shared/schema";

const HOST = "app.agency.test";
const agencyOwner = makeUser({ username: "agency_owner" });
const client = makeUser({ username: "agency_client", resellerId: agencyOwner.id });
const clientAgent = makeUser({ username: "client_agent", role: "team", createdBy: client.id });
const outsider = makeUser({ username: "other_tenant" });
const root = makeUser({ username: "root_admin", role: "superadmin" });
const brand: Brand = { id: "b1", ownerId: agencyOwner.id, name: "Agency Pro", logo: "/uploads/brands/x.png", favicon: null, baseColor: "#2563eb", supportEmail: "help@agency.test", supportUrl: null, loginTitle: "Welcome to Agency Pro", loginSubtitle: "Messaging for our clients", hidePoweredBy: false, allowSignup: true, createdAt: new Date(), updatedAt: new Date() };
const domain: BrandDomain = { id: "d1", brandId: "b1", domain: HOST, verificationToken: "tok123", verifiedAt: new Date(), lastCheckedAt: null, lastError: null, disabled: false, createdAt: new Date() };
let app: Express;

beforeEach(() => {
  forgetBrandCache();
  mockDirectory([agencyOwner, client, clientAgent, outsider, root]);
  vi.spyOn(brandsRepository, "domainByName").mockImplementation(async (d) => (d === HOST ? domain : undefined));
  vi.spyOn(brandsRepository, "byId").mockImplementation(async (id) => (id === "b1" ? brand : undefined));
  vi.spyOn(brandsRepository, "byOwner").mockImplementation(async (o) => (o === agencyOwner.id ? brand : undefined));
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

describe("domains", () => {
  it("accepts host names only", () => {
    expect(domainSchema.parse({ domain: "https://App.Agency.com/login" }).domain).toBe("app.agency.com");
    for (const bad of ["localhost", "10.0.0.1", "agency", "-bad.com", "a".repeat(64) + ".com"]) expect(domainSchema.safeParse({ domain: bad }).success, bad).toBe(false);
  });

  it("verifies ownership with a TXT record", async () => {
    const update = vi.spyOn(brandsRepository, "updateDomain").mockResolvedValue(undefined);
    const d = { ...domain, verifiedAt: null };
    vi.spyOn(dnsLookup, "txt").mockResolvedValueOnce([["wm360-verify=wrong"]]);
    expect((await verifyDomain(d)).ok).toBe(false);
    vi.spyOn(dnsLookup, "txt").mockResolvedValueOnce([[verificationRecord(HOST, "tok").value.slice(0, 10), verificationRecord(HOST, "tok").value.slice(10)]]);
    expect(await verifyDomain({ ...d, verificationToken: "tok" })).toEqual({ ok: true, error: null });
    expect(update).toHaveBeenLastCalledWith("d1", expect.objectContaining({ verifiedAt: expect.any(Date), lastError: null }));
    vi.spyOn(dnsLookup, "txt").mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    expect((await verifyDomain(d)).error).toMatch(/No TXT record/);
  });
});

describe("on a brand domain", () => {
  it("serves the brand's look and hides platform-only sign-in", async () => {
    const res = await request(app).get("/api/system-config/public").set("Host", HOST).expect(200);
    expect(res.body.data).toMatchObject({ siteTitle: "Agency Pro", baseColor: "#2563eb", logo: "/uploads/brands/x.png", googleLogin: false, microsoftLogin: false, brand: { name: "Agency Pro", poweredBy: "Test", onBrandDomain: true } });
    expect(res.body.data.frontend.heroTitle).toBe("Welcome to Agency Pro");
    const plain = await request(app).get("/api/system-config/public").expect(200);
    expect(plain.body.data.brand).toBeNull();
  });

  it("lets only the agency, its clients and their teams sign in", async () => {
    for (const u of ["agency_owner", "agency_client", "client_agent"]) await request(app).post("/api/auth/login").set("Host", HOST).send({ username: u, password: PASSWORD }).expect(200);
    for (const u of ["other_tenant", "root_admin"]) {
      const res = await request(app).post("/api/auth/login").set("Host", HOST).send({ username: u, password: PASSWORD }).expect(403);
      expect(res.body.code).toBe("WRONG_BRAND");
    }
    // The platform's own domain is unaffected.
    await request(app).post("/api/auth/login").send({ username: "other_tenant", password: PASSWORD }).expect(200);
  });

  it("makes new sign-ups the agency's clients", async () => {
    vi.spyOn(usersRepository, "existsUsernameOrEmail").mockResolvedValue({ username: false, email: false });
    vi.spyOn(levelsRepository, "lowest").mockResolvedValue(undefined as never);
    vi.spyOn(billingRepository, "findPlanByName").mockResolvedValue(undefined);
    const create = vi.spyOn(usersRepository, "create").mockImplementation(async (v) => makeUser({ ...v, id: "new-user" } as never));
    vi.spyOn(usersRepository, "findById").mockImplementation(async (id) => (id === "new-user" ? makeUser({ id: "new-user", username: "fresh", resellerId: agencyOwner.id }) : [agencyOwner, client].find((u) => u.id === id)));
    await request(app).post("/api/auth/signup").set("Host", HOST).send({ username: "fresh", email: "fresh@example.test", password: "Str0ngPass1", acceptTerms: true }).expect(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ resellerId: agencyOwner.id }));
    vi.spyOn(brandsRepository, "byId").mockResolvedValue({ ...brand, allowSignup: false });
    forgetBrandCache();
    const closed = await request(app).post("/api/auth/signup").set("Host", HOST).send({ username: "fresh2", email: "fresh2@example.test", password: "Str0ngPass1", acceptTerms: true }).expect(403);
    expect(closed.body.code).toBe("REGISTRATION_CLOSED");
  });

  it("ignores unverified or disabled domains", async () => {
    vi.spyOn(brandsRepository, "domainByName").mockResolvedValue({ ...domain, verifiedAt: null });
    expect((await request(app).get("/api/system-config/public").set("Host", HOST)).body.data.brand).toBeNull();
    forgetBrandCache();
    vi.spyOn(brandsRepository, "domainByName").mockResolvedValue({ ...domain, disabled: true });
    expect((await request(app).get("/api/system-config/public").set("Host", HOST)).body.data.brand).toBeNull();
  });

  it("answers the proxy's certificate check", async () => {
    await request(app).get(`/api/white-label/tls-check?domain=${HOST}`).expect(200);
    await request(app).get("/api/white-label/tls-check?domain=unknown.test").expect(404);
  });
});
