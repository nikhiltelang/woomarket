import { describe, it, expect, afterEach, vi, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { assertSafeUrl, isPrivateAddress, postWebhook, signPayload } from "../services/webhooks.service";
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_SAMPLES, WEBHOOK_EVENT_NAMES, webhookEndpointSchema } from "@shared/webhooks";
import { campaignCounts, changedFields } from "../services/webhook-events";
import { makeUser } from "./helpers";

describe("addresses", () => {
  it("blocks private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "34.120.10.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("signature", () => {
  it("signs `${t}.${body}` with HMAC-SHA256", () => {
    const sig = signPayload("whsec_x", '{"a":1}', 1700000000);
    const expected = crypto.createHmac("sha256", "whsec_x").update('1700000000.{"a":1}').digest("hex");
    expect(sig).toBe(`t=1700000000,v1=${expected}`);
  });
});

describe("catalogue", () => {
  it("has a sample for every event and validates subscriptions", () => {
    expect(Object.keys(WEBHOOK_SAMPLES).sort()).toEqual([...WEBHOOK_EVENT_NAMES].sort());
    expect(webhookEndpointSchema.safeParse({ url: "https://x.test/h", events: ["message.received"] }).success).toBe(true);
    expect(webhookEndpointSchema.safeParse({ url: "https://x.test/h", events: ["nope"] }).success).toBe(false);
    expect(webhookEndpointSchema.safeParse({ url: "https://x.test/h", events: [] }).success).toBe(false);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(7);
  });
  it("describes contact changes and campaign counts", () => {
    const a = { ...makeUser(), name: "A", phone: "+1", email: null, status: "active", tags: ["x"], groups: [], metadata: { city: "Pune" } } as never;
    expect(changedFields(a, { ...(a as object), tags: ["x", "y"], metadata: { city: "Delhi" } } as never)).toEqual(["tags", "fields"]);
    expect(campaignCounts({ sentCount: 3, openedCount: 1, name: "n", recipientCount: 5 })).toEqual({ sent: 3, opened: 1, recipient: 5 });
  });
});

describe("delivery", () => {
  let server: http.Server;
  let url: string;
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let reply = 200;
  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_URLS = "true";
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        if (reply === 302) res.writeHead(302, { Location: "http://169.254.169.254/" }).end();
        else res.writeHead(reply).end(reply === 200 ? "ok" : "nope");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => server.close());
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.WEBHOOK_ALLOW_PRIVATE_URLS = "true";
  });

  it("refuses private targets unless explicitly allowed", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_URLS = "false";
    await expect(assertSafeUrl(url)).rejects.toThrow(/https/);
    await expect(assertSafeUrl("https://127.0.0.1/x")).rejects.toThrow(/public internet/);
    await expect(assertSafeUrl("https://169.254.169.254/latest")).rejects.toThrow(/public internet/);
    await expect(assertSafeUrl("https://localhost/x")).rejects.toThrow(/public internet/);
    await expect(assertSafeUrl("https://user:pw@example.com/x")).rejects.toThrow(/password/);
    const r = await postWebhook(url, "s", { id: "e0", event: "contact.created", createdAt: "", data: {} });
    expect(r.ok).toBe(false);
    // An https URL whose name resolves to a private address is refused when connecting.
    const viaDns = await postWebhook("https://localhost:1/x", "s", { id: "e0", event: "contact.created", createdAt: "", data: {} });
    expect(viaDns.error).toMatch(/private network/);
  });

  it("posts a signed envelope the receiver can verify", async () => {
    const env = { id: "e1", event: "contact.created" as const, createdAt: new Date().toISOString(), data: { contact: { id: "c1" } } };
    const r = await postWebhook(url, "whsec_test", env);
    expect(r).toMatchObject({ ok: true, status: 200, body: "ok" });
    const got = received.at(-1)!;
    expect(got.headers["x-wm-event"]).toBe("contact.created");
    expect(got.headers["x-wm-delivery"]).toBe("e1");
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(got.headers["x-wm-signature"]))!;
    expect(crypto.createHmac("sha256", "whsec_test").update(`${t}.${got.body}`).digest("hex")).toBe(v1);
    expect(JSON.parse(got.body)).toEqual(env);
  });

  it("reports failures and never follows redirects", async () => {
    reply = 500;
    expect(await postWebhook(url, "s", { id: "e2", event: "contact.created", createdAt: "", data: {} })).toMatchObject({ ok: false, status: 500 });
    reply = 302;
    const r = await postWebhook(url, "s", { id: "e3", event: "contact.created", createdAt: "", data: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Redirects/);
    reply = 200;
  });
});
