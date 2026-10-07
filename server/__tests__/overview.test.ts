import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { login, makeChannel, makeUser, mockDirectory } from "./helpers";
import { channelsRepository } from "../repositories/channels.repository";
import { conversationsRepository } from "../repositories/conversations.repository";
import { overviewRepository } from "../repositories/overview.repository";
import { smsGatewayRepository } from "../repositories/sms.repository";
import * as mailer from "../services/email/mailer";

const admin = makeUser({ username: "o_admin", role: "admin" });
const limited = makeUser({ username: "o_agent", role: "team", createdBy: admin.id, permissions: ["inbox:view", "contacts:view"] });
const channel = makeChannel({ createdBy: admin.id });
const totals = { campaigns: 2, recipients: 100, sent: 90, delivered: 80, engaged: 40, failed: 10 };
let app: Express;

beforeEach(() => {
  mockDirectory([admin, limited], [channel]);
  vi.spyOn(channelsRepository, "listByTenant").mockResolvedValue([channel]);
  vi.spyOn(conversationsRepository, "countOpen").mockResolvedValue(3);
  vi.spyOn(conversationsRepository, "unreadCountForChannels").mockResolvedValue(5);
  vi.spyOn(overviewRepository, "whatsappTotals").mockResolvedValue(totals);
  vi.spyOn(overviewRepository, "emailTotals").mockResolvedValue({ ...totals, engaged: 20 });
  vi.spyOn(overviewRepository, "smsTotals").mockResolvedValue({ ...totals, engaged: 0, credits: 120 });
  vi.spyOn(overviewRepository, "sentPerDay").mockResolvedValue({ whatsapp: new Map(), email: new Map(), sms: new Map() });
  vi.spyOn(overviewRepository, "audience").mockResolvedValue({ total: 10, withPhone: 10, withEmail: 4 });
  vi.spyOn(overviewRepository, "recentCampaigns").mockResolvedValue([]);
  vi.spyOn(mailer, "resolveSmtp").mockResolvedValue({ source: "simulator", key: "sim" } as never);
  vi.spyOn(smsGatewayRepository, "get").mockResolvedValue(undefined);
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/dashboard/overview", () => {
  it("reports all three channels in the same shape", async () => {
    const s = await login(app, "o_admin");
    const { body } = await s.agent.get("/api/dashboard/overview").expect(200);
    const { whatsapp, email, sms } = body.data.channels;
    for (const c of [whatsapp, email, sms]) expect(Object.keys(c)).toEqual(expect.arrayContaining(["ready", "detail", "campaigns", "sent", "delivered", "failed", "deliveryRate", "engagementRate"]));
    expect(whatsapp).toMatchObject({ ready: true, detail: "1 number connected", deliveryRate: 88.9, engagementRate: 50, openConversations: 3, unreadMessages: 5 });
    expect(email).toMatchObject({ ready: true, detail: "Test mode (simulator)", engagementRate: 25 });
    expect(sms).toMatchObject({ ready: false, detail: "No SMS gateway set up", engagementRate: null, credits: 120 });
    expect(body.data.daily).toHaveLength(14);
    expect(Object.keys(body.data.daily[0]).sort()).toEqual(["day", "email", "sms", "whatsapp"]);
    expect(body.data.audience).toEqual({ total: 10, withPhone: 10, withEmail: 4 });
  });

  it("leaves out channels the user can't view", async () => {
    const s = await login(app, "o_agent");
    const { body } = await s.agent.get("/api/dashboard/overview").expect(200);
    expect(Object.keys(body.data.channels)).toEqual(["whatsapp"]);
    expect(Object.keys(body.data.daily[0]).sort()).toEqual(["day", "whatsapp"]);
    expect(overviewRepository.emailTotals).not.toHaveBeenCalled();
    expect(overviewRepository.recentCampaigns).toHaveBeenCalledWith(admin.id, [channel.id], { whatsapp: true, email: false, sms: false });
  });

  it("works without any WhatsApp number", async () => {
    vi.spyOn(channelsRepository, "listByTenant").mockResolvedValue([]);
    const s = await login(app, "o_admin");
    const { body } = await s.agent.get("/api/dashboard/overview").expect(200);
    expect(body.data.channels.whatsapp).toMatchObject({ ready: false, detail: "No number connected", unreadMessages: 0 });
    expect(body.data.channels.email.ready).toBe(true);
  });
});
