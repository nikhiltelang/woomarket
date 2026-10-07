import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { DEFAULT_LANDING, landingPageSchema, newSection, resolveLanding } from "@shared/landing";
import { createApp } from "../app";
import { login, makeUser, mockDirectory, mockSystemConfig } from "./helpers";
import { billingRepository } from "../repositories/billing.repository";
import { systemConfig } from "../services/system-config.service";

const root = makeUser({ username: "lp_root", role: "superadmin" });
const admin = makeUser({ username: "lp_admin", role: "admin" });
let app: Express;
const plan = { id: "p1", name: "Pro", description: "For teams", monthlyPrice: "49.00", annualPrice: "490.00", features: ["3 numbers"], popular: true, badge: null, stripePriceIdMonthly: "price_secret", permissions: { channel: 3 } };

beforeEach(() => {
  mockDirectory([root, admin]);
  vi.spyOn(billingRepository, "listPlans").mockResolvedValue([plan] as never);
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

describe("content model", () => {
  it("accepts the starter content", () => {
    expect(landingPageSchema.safeParse(DEFAULT_LANDING).success).toBe(true);
    for (const t of ["hero", "stats", "features", "channels", "steps", "pricing", "testimonials", "faq", "cta", "custom"] as const) {
      expect(landingPageSchema.safeParse({ ...DEFAULT_LANDING, sections: [newSection(t, `x-${t}`)] }).success).toBe(true);
    }
  });

  it("refuses script links and duplicate section ids", () => {
    const hero = newSection("hero", "h1");
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//evil.example"]) {
      expect(landingPageSchema.safeParse({ ...DEFAULT_LANDING, sections: [{ ...hero, primary: { label: "Go", href } }] }).success).toBe(false);
    }
    for (const href of ["/signup", "#pricing", "https://example.com", "mailto:hi@example.com", ""]) {
      expect(landingPageSchema.safeParse({ ...DEFAULT_LANDING, sections: [{ ...hero, primary: { label: "Go", href } }] }).success).toBe(true);
    }
    expect(landingPageSchema.safeParse({ ...DEFAULT_LANDING, sections: [hero, { ...hero }] }).success).toBe(false);
  });

  it("falls back to the starter page for empty or broken stored data", () => {
    expect(resolveLanding(null)).toEqual(DEFAULT_LANDING);
    expect(resolveLanding({})).toEqual(DEFAULT_LANDING);
    expect(resolveLanding({ sections: "nope" })).toEqual(DEFAULT_LANDING);
  });
});

describe("public endpoint", () => {
  it("reveals nothing while the page is off", async () => {
    mockSystemConfig({ landingPage: { ...DEFAULT_LANDING, enabled: false } as never });
    const res = await request(app).get("/api/landing-page").expect(200);
    expect(res.body).toEqual({ data: { enabled: false } });
  });

  it("returns visible sections and public plan fields when on", async () => {
    const sections = DEFAULT_LANDING.sections.map((s) => (s.id === "faq" ? { ...s, enabled: false } : s));
    mockSystemConfig({ landingPage: { ...DEFAULT_LANDING, enabled: true, sections } as never });
    const res = await request(app).get("/api/landing-page").expect(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.sections.map((s: { id: string }) => s.id)).not.toContain("faq");
    expect(res.body.plans[0]).toEqual({ id: "p1", name: "Pro", description: "For teams", monthlyPrice: 49, annualPrice: 490, features: ["3 numbers"], popular: true, badge: null });
    expect(JSON.stringify(res.body)).not.toContain("price_secret");
  });

  it("stays available during maintenance", async () => {
    mockSystemConfig({ landingPage: { ...DEFAULT_LANDING, enabled: true } as never, maintenanceMode: { enabled: true, title: "Down", content: "Back soon", bypassSecret: "" } });
    await request(app).get("/api/landing-page").expect(200);
  });
});

describe("editing", () => {
  it("lets the superadmin save, and validates", async () => {
    mockSystemConfig();
    const update = vi.spyOn(systemConfig, "update").mockResolvedValue({} as never);
    const s = await login(app, "lp_root");
    const body = { ...DEFAULT_LANDING, enabled: true };
    await s.agent.put("/api/superadmin/landing-page").set("X-CSRF-Token", s.csrf).send(body).expect(200);
    expect((update.mock.calls[0][0] as { landingPage: { enabled: boolean } }).landingPage.enabled).toBe(true);
    const bad = { ...body, sections: [{ ...newSection("cta", "c"), primary: { label: "x", href: "javascript:alert(1)" } }] };
    await s.agent.put("/api/superadmin/landing-page").set("X-CSRF-Token", s.csrf).send(bad).expect(400);
  });

  it("is superadmin-only", async () => {
    mockSystemConfig();
    const s = await login(app, "lp_admin");
    await s.agent.get("/api/superadmin/landing-page").expect(403);
    await s.agent.put("/api/superadmin/landing-page").set("X-CSRF-Token", s.csrf).send(DEFAULT_LANDING).expect(403);
  });
});
