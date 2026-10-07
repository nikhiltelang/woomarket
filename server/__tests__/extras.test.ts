import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Express } from "express";
import { DEFAULT_TEAM_PERMISSIONS } from "@shared/roles";
import { couponDiscount, couponSchema } from "@shared/platform";
import type { Coupon, Plan } from "@shared/schema";
import { createApp } from "../app";
import { login, makeUser, mockDirectory } from "./helpers";
import { couponsRepository } from "../repositories/coupons.repository";
import { supportRepository } from "../repositories/support.repository";
import * as notifications from "../services/notification.service";
import { couponProblem, quote } from "../services/coupon.service";
import { formatBytes, formatDuration } from "../controllers/system-info.controller";

const admin = makeUser({ username: "x_admin", role: "admin" });
const root = makeUser({ username: "x_root", role: "superadmin" });
const agent = makeUser({ username: "x_agent", role: "team", createdBy: admin.id, permissions: [...DEFAULT_TEAM_PERMISSIONS] });
let app: Express;

const coupon = (o: Partial<Coupon> = {}): Coupon => ({
  id: 1,
  name: "Launch",
  code: "LAUNCH20",
  type: "percent",
  discountValue: "20.00",
  expiryType: "lifetime",
  expiresAt: null,
  usageLimit: -1,
  usedCount: 0,
  status: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});
const plan = { id: "p1", monthlyPrice: "49.00", annualPrice: "490.00" } as Plan;

beforeEach(() => {
  mockDirectory([admin, root, agent]);
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

describe("coupon pricing", () => {
  it("applies percent and fixed discounts, rounded to cents and capped at the price", () => {
    expect(couponDiscount({ type: "percent", discountValue: "20" }, 49)).toBe(9.8);
    expect(couponDiscount({ type: "percent", discountValue: "33.33" }, 10)).toBe(3.33);
    expect(couponDiscount({ type: "fixed", discountValue: "15" }, 49)).toBe(15);
    expect(couponDiscount({ type: "fixed", discountValue: "100" }, 49)).toBe(49);
    expect(couponDiscount({ type: "fixed", discountValue: "5" }, 0)).toBe(0);
  });

  it("reports why a coupon can't be used", () => {
    expect(couponProblem(coupon())).toBeNull();
    expect(couponProblem(coupon({ status: false }))).toMatch(/inactive/);
    expect(couponProblem(coupon({ expiryType: "date", expiresAt: new Date(Date.now() - 1000) }))).toMatch(/expired/);
    expect(couponProblem(coupon({ expiryType: "date", expiresAt: new Date(Date.now() + 86400_000) }))).toBeNull();
    expect(couponProblem(coupon({ usageLimit: 3, usedCount: 3 }))).toMatch(/usage limit/);
  });

  it("quotes a plan for the billing cycle", async () => {
    vi.spyOn(couponsRepository, "findByCode").mockResolvedValue(coupon());
    expect(await quote(plan, "monthly")).toMatchObject({ price: 49, discount: 0, total: 49, coupon: null });
    expect(await quote(plan, "annual", "launch20")).toMatchObject({ price: 490, discount: 98, total: 392 });
  });

  it("rejects unknown and used-up codes with COUPON_INVALID", async () => {
    vi.spyOn(couponsRepository, "findByCode").mockResolvedValueOnce(undefined).mockResolvedValueOnce(coupon({ usageLimit: 1, usedCount: 1 }));
    await expect(quote(plan, "monthly", "NOPE")).rejects.toMatchObject({ code: "COUPON_INVALID" });
    await expect(quote(plan, "monthly", "LAUNCH20")).rejects.toMatchObject({ code: "COUPON_INVALID" });
  });

  it("validates coupon input", () => {
    const base = { name: "X", code: " spring-25 ", type: "fixed", discountValue: "5", expiryType: "lifetime", usageLimit: "-1" };
    expect(couponSchema.parse(base)).toMatchObject({ code: "SPRING-25", discountValue: 5, usageLimit: -1 });
    expect(couponSchema.safeParse({ ...base, usageLimit: "0" }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, type: "percent", discountValue: "120" }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, expiryType: "date" }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, code: "a b" }).success).toBe(false);
  });
});

describe("access", () => {
  it("keeps coupons, system info and cache to the superadmin", async () => {
    const s = await login(app, "x_admin");
    for (const path of ["/api/superadmin/coupons", "/api/superadmin/system-info/server", "/api/superadmin/cache", "/api/superadmin/support-requests"]) {
      await s.agent.get(path).expect(403);
    }
    await s.agent.post("/api/superadmin/cache/clear").set("X-CSRF-Token", s.csrf).send({}).expect(403);
  });

  it("lets tenants and team file requests but not the superadmin", async () => {
    const s = await login(app, "x_root");
    await s.agent.post("/api/support-requests").set("X-CSRF-Token", s.csrf).send({ type: "bug", message: "Something broke here" }).expect(403);
  });
});

describe("report & request", () => {
  it("files a request and tells the superadmins", async () => {
    vi.spyOn(supportRepository, "recentCount").mockResolvedValue(0);
    const create = vi.spyOn(supportRepository, "create").mockImplementation(async (v) => ({ id: 7, status: "open", adminReply: null, repliedAt: null, createdAt: new Date(), updatedAt: new Date(), ...v }));
    const notify = vi.spyOn(notifications, "sendNotification").mockResolvedValue({} as never);
    const s = await login(app, "x_agent");
    await s.agent.post("/api/support-requests").set("X-CSRF-Token", s.csrf).send({ type: "bug", message: "Export button does nothing" }).expect(201);
    expect(create).toHaveBeenCalledWith({ userId: agent.id, type: "bug", message: "Export button does nothing" });
    expect(notify.mock.calls[0][0]).toMatchObject({ targetType: "superadmins", viaInApp: true, viaEmail: false });
  });

  it("rejects short messages and too many requests", async () => {
    const s = await login(app, "x_admin");
    await s.agent.post("/api/support-requests").set("X-CSRF-Token", s.csrf).send({ type: "bug", message: "short" }).expect(400);
    vi.spyOn(supportRepository, "recentCount").mockResolvedValue(10);
    const res = await s.agent.post("/api/support-requests").set("X-CSRF-Token", s.csrf).send({ type: "support", message: "Please help me with this" }).expect(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  it("notifies the reporter when the status changes or a reply is added", async () => {
    const row = { id: 3, userId: admin.id, type: "support", message: "Need help", status: "open", adminReply: null, repliedAt: null, createdAt: new Date(), updatedAt: new Date() };
    vi.spyOn(supportRepository, "find").mockResolvedValue(row);
    const update = vi.spyOn(supportRepository, "update").mockResolvedValue({ ...row, status: "resolved" });
    const notify = vi.spyOn(notifications, "sendNotification").mockResolvedValue({} as never);
    const s = await login(app, "x_root");
    await s.agent.put("/api/superadmin/support-requests/3").set("X-CSRF-Token", s.csrf).send({ status: "resolved", reply: "Fixed in 3.8.1" }).expect(200);
    expect(update.mock.calls[0][1]).toMatchObject({ status: "resolved", adminReply: "Fixed in 3.8.1" });
    expect(notify.mock.calls[0][0]).toMatchObject({ targetType: "users", targetIds: [admin.id], message: "Fixed in 3.8.1" });

    notify.mockClear();
    vi.spyOn(supportRepository, "find").mockResolvedValue({ ...row, status: "resolved", adminReply: "Fixed in 3.8.1" });
    await s.agent.put("/api/superadmin/support-requests/3").set("X-CSRF-Token", s.csrf).send({ status: "resolved", reply: "Fixed in 3.8.1" }).expect(200);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("system info formatting", () => {
  it("formats durations and sizes", () => {
    expect(formatDuration(59)).toBe("0m");
    expect(formatDuration(3 * 3600 + 120)).toBe("3h 2m");
    expect(formatDuration(2 * 86400 + 60)).toBe("2d 0h 1m");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(8 * 1024 ** 3)).toBe("8.0 GB");
  });
});
