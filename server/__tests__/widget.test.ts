import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app";
import { mockDirectory, makeChannel, makeUser } from "./helpers";
import { originAllowed, startChatSchema, whatsappLink, widgetSettingsSchema } from "@shared/widget";
import { visitorToken, widgetsRepository } from "../services/widget.service";
import { conversationsRepository } from "../repositories/conversations.repository";
import type { ChatWidget, Conversation } from "@shared/schema";

describe("origin allow-list", () => {
  it("matches exact origins and wildcard subdomains only", () => {
    const allowed = ["https://shop.example.com", "https://*.brand.io"];
    expect(originAllowed("https://shop.example.com", allowed)).toBe(true);
    expect(originAllowed("http://shop.example.com", allowed)).toBe(false);
    expect(originAllowed("https://evil-shop.example.com", allowed)).toBe(false);
    expect(originAllowed("https://www.brand.io", allowed)).toBe(true);
    expect(originAllowed("https://a.b.brand.io", allowed)).toBe(true);
    expect(originAllowed("https://brand.io", allowed)).toBe(false);
    expect(originAllowed("https://notbrand.io", allowed)).toBe(false);
    expect(originAllowed("https://brand.io.evil.com", allowed)).toBe(false);
    expect(originAllowed(null, allowed)).toBe(false);
    expect(originAllowed("https://anything.test", [])).toBe(true);
  });
  it("validates settings and visitor input", () => {
    expect(widgetSettingsSchema.parse({}).liveChat.enabled).toBe(true);
    expect(widgetSettingsSchema.safeParse({ color: "red" }).success).toBe(false);
    expect(startChatSchema.safeParse({ message: "hi", website: "http://spam" }).success).toBe(false);
    expect(startChatSchema.safeParse({ message: "  " }).success).toBe(false);
    expect(whatsappLink("+91 98123 45678", "Hi there & more")).toBe("https://wa.me/919812345678?text=Hi%20there%20%26%20more");
  });
});

const owner = makeUser({ username: "widget_owner" });
const channel = makeChannel({ createdBy: owner.id });
const widget = { id: "0b1e2c3d-0000-4000-8000-000000000001", userId: owner.id, channelId: channel.id, name: "Site", enabled: true, settings: {}, allowedOrigins: ["https://shop.example.com"], createdBy: null, createdAt: new Date(), updatedAt: new Date() } as ChatWidget;
const conv = { id: "0b1e2c3d-0000-4000-8000-000000000002", channelId: channel.id, type: "web" } as Conversation;
let app: Express;

beforeEach(() => {
  mockDirectory([owner], [channel]);
  vi.spyOn(widgetsRepository, "find").mockImplementation(async (id) => (id === widget.id ? widget : undefined));
  vi.spyOn(conversationsRepository, "findById").mockImplementation(async (id) => (id === conv.id ? conv : undefined));
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

describe("public widget API", () => {
  it("serves config with CORS only to allowed sites", async () => {
    const ok = await request(app).get(`/api/widget/${widget.id}/config`).set("Origin", "https://shop.example.com").expect(200);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://shop.example.com");
    expect(ok.body.data.liveChat).toBe(true);
    expect(ok.body.data.whatsappUrl).toMatch(/^https:\/\/wa\.me\/15550000000\?text=/);
    expect(ok.body.data.settings.whatsapp.phone).toBe("");
    const bad = await request(app).get(`/api/widget/${widget.id}/config`).set("Origin", "https://other.test").expect(403);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await request(app).options(`/api/widget/${widget.id}/messages`).set("Origin", "https://shop.example.com").set("Access-Control-Request-Method", "POST").expect(204);
    expect(pre.headers["access-control-allow-headers"]).toContain("X-Widget-Token");
  });

  it("hides disabled or unknown widgets", async () => {
    await request(app).get(`/api/widget/0b1e2c3d-0000-4000-8000-00000000ffff/config`).expect(404);
    vi.spyOn(widgetsRepository, "find").mockResolvedValue({ ...widget, id: "0b1e2c3d-0000-4000-8000-000000000003", enabled: false });
    await request(app).get(`/api/widget/0b1e2c3d-0000-4000-8000-000000000003/config`).expect(404);
  });

  it("needs this widget's signed token to read a chat", async () => {
    await request(app).get(`/api/widget/${widget.id}/messages`).expect(401);
    await request(app).get(`/api/widget/${widget.id}/messages`).set("X-Widget-Token", `${widget.id}:${conv.id}.forged`).expect(401);
    const otherWidget = visitorToken("0b1e2c3d-0000-4000-8000-0000000000aa", conv.id);
    await request(app).get(`/api/widget/${widget.id}/messages`).set("X-Widget-Token", otherWidget).expect(401);
  });

  it("serves the embed script cross-origin", async () => {
    const res = await request(app).get("/widget.js").expect(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.text).toContain("attachShadow");
    // Author CSS must not override the hidden attribute (closed panel, empty badge).
    expect(res.text).toContain("[hidden]{display:none!important}");
    expect(res.text).not.toContain("innerHTML = m.");
  });
});
