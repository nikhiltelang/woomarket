import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { calculateSegments, renderMergeTags } from "@shared/sms";
import { DEFAULT_TEAM_PERMISSIONS } from "@shared/roles";
import { createApp } from "../app";
import { login, makeChannel, makeUser, mockDirectory } from "./helpers";
import { renderEmail, htmlToText } from "../services/email/render";
import { classifySmtpError } from "../services/email/mailer";
import { verifyTwilioSignature } from "../services/sms/providers";
import { signToken, verifyToken } from "../lib/tokens";
import { emailCampaignsRepository } from "../repositories/email.repository";
import { smsCampaignsRepository } from "../repositories/sms.repository";

describe("SMS segments", () => {
  it("counts GSM-7 single and concatenated messages", () => {
    expect(calculateSegments("")).toMatchObject({ segments: 0, encoding: "GSM-7" });
    expect(calculateSegments("a".repeat(160))).toMatchObject({ segments: 1, perSegment: 160 });
    expect(calculateSegments("a".repeat(161))).toMatchObject({ segments: 2, perSegment: 153 });
    expect(calculateSegments("a".repeat(306))).toMatchObject({ segments: 2 });
    expect(calculateSegments("a".repeat(307))).toMatchObject({ segments: 3 });
  });

  it("counts GSM extension characters twice", () => {
    expect(calculateSegments("€".repeat(80))).toMatchObject({ encoding: "GSM-7", units: 160, segments: 1 });
    expect(calculateSegments("€".repeat(81))).toMatchObject({ units: 162, segments: 2 });
  });

  it("switches to UCS-2 for emoji and non-GSM characters", () => {
    const s = calculateSegments("Hi 😀");
    expect(s.encoding).toBe("UCS-2");
    expect(s.units).toBe(5); // emoji is two UTF-16 units
    expect(s.nonGsmChars).toContain("😀");
    expect(calculateSegments("é".repeat(70)).encoding).toBe("GSM-7"); // é is in GSM basic
    expect(calculateSegments("ł".repeat(71))).toMatchObject({ encoding: "UCS-2", segments: 2, perSegment: 67 });
  });

  it("renders merge tags", () => {
    expect(renderMergeTags("Hi {{first_name}} ({{ name }}) {{phone}}", { name: "Priya Sharma", phone: "+91" })).toBe("Hi Priya (Priya Sharma) +91");
  });
});

describe("email rendering", () => {
  const campaign = { subject: "Hi {{first_name}}", previewText: "Deals for {{name}}", contentHtml: "<html><body><p>Hello {{name}}</p></body></html>" };

  it("escapes merge values in HTML but not in the subject", () => {
    const r = renderEmail(campaign, { id: "r1", name: "<b>Eve</b> & Co", email: "eve@example.com" });
    expect(r.subject).toBe("Hi <b>Eve</b>");
    expect(r.html).toContain("Hello &lt;b&gt;Eve&lt;/b&gt; &amp; Co");
    expect(r.html).not.toContain("<b>Eve</b>");
  });

  it("always includes an unsubscribe link, the open pixel and one-click headers", () => {
    const r = renderEmail(campaign, { id: "r1", name: "Ann", email: "a@x.test" });
    expect(r.html).toContain(r.unsubscribeUrl);
    expect(r.html).toMatch(/\/api\/email-marketing\/o\/r1\.[\w-]+\.gif/);
    expect(r.text).toContain(`Unsubscribe: ${r.unsubscribeUrl}`);
    expect(r.headers["List-Unsubscribe"]).toBe(`<${r.unsubscribeUrl}>`);
    expect(r.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(r.html.indexOf("display:none")).toBeLessThan(r.html.indexOf("Hello")); // preview text first
  });

  it("uses {{unsubscribe_url}} when placed by the author and adds no footer", () => {
    const r = renderEmail({ ...campaign, contentHtml: '<p>Bye <a href="{{unsubscribe_url}}">leave</a></p>' }, { id: "r2", email: "a@x.test" });
    expect(r.html.match(/unsubscribe\//g)?.length).toBe(1);
  });

  it("test sends carry no tracking pixel", () => {
    expect(renderEmail(campaign, { email: "a@x.test" }).html).not.toContain("/o/");
  });

  it("derives readable plain text from HTML", () => {
    expect(htmlToText('<h1>Title</h1><p>Line &amp; more<br>next</p><a href="https://x.test">Shop</a><style>p{}</style>')).toBe("Title\nLine & more\nnext\nShop (https://x.test)");
  });
});

describe("tokens & signatures", () => {
  it("signs and verifies purpose-bound tokens", () => {
    const t = signToken("unsubscribe", "abc-123");
    expect(verifyToken("unsubscribe", t)).toBe("abc-123");
    expect(verifyToken("open", t)).toBeNull();
    expect(verifyToken("unsubscribe", t.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(verifyToken("unsubscribe", "abc-124" + t.slice(7))).toBeNull();
  });

  it("verifies Twilio request signatures", () => {
    const url = "https://app.example.com/webhooks/sms/twilio/g1";
    const params = { MessageSid: "SM1", MessageStatus: "delivered", AccountSid: "AC1" };
    const data = url + "AccountSidAC1MessageSidSM1MessageStatusdelivered";
    const sig = crypto.createHmac("sha1", "tok").update(data).digest("base64");
    expect(verifyTwilioSignature("tok", url, params, sig)).toBe(true);
    expect(verifyTwilioSignature("tok", url, { ...params, MessageStatus: "failed" }, sig)).toBe(false);
    expect(verifyTwilioSignature("tok", url, params, undefined)).toBe(false);
  });

  it("classifies SMTP errors", () => {
    expect(classifySmtpError({ code: "EAUTH" })).toBe("config");
    expect(classifySmtpError({ code: "ECONNECTION" })).toBe("config");
    expect(classifySmtpError({ responseCode: 452 })).toBe("temporary");
    expect(classifySmtpError({ responseCode: 550 })).toBe("permanent");
  });
});

describe("marketing API access", () => {
  const adminA = makeUser({ username: "mk_admin_a", role: "admin" });
  const adminB = makeUser({ username: "mk_admin_b", role: "admin" });
  const agent = makeUser({ username: "mk_agent", role: "team", createdBy: adminA.id, permissions: [...DEFAULT_TEAM_PERMISSIONS] });
  const noMarketing = makeUser({ username: "mk_none", role: "team", createdBy: adminA.id, permissions: ["inbox:view"] });
  const channelA = makeChannel({ createdBy: adminA.id });
  let app: Express;

  beforeEach(() => {
    mockDirectory([adminA, adminB, agent, noMarketing], [channelA]);
    app = createApp().app;
  });
  afterEach(() => vi.restoreAllMocks());

  it("requires email:view / sms:view", async () => {
    const s = await login(app, "mk_none");
    expect((await s.agent.get("/api/email-marketing/campaigns").expect(403)).body.code).toBe("MISSING_PERMISSION");
    await s.agent.get("/api/sms-marketing/campaigns").expect(403);
  });

  it("lets viewers read but not send", async () => {
    vi.spyOn(emailCampaignsRepository, "list").mockResolvedValue({ rows: [], total: 0 });
    const s = await login(app, "mk_agent");
    await s.agent.get("/api/email-marketing/campaigns").expect(200);
    const res = await s.agent.post("/api/email-marketing/campaigns").set("X-CSRF-Token", s.csrf).send({ channelId: channelA.id }).expect(403);
    expect(res.body.code).toBe("MISSING_PERMISSION");
  });

  it("scopes campaigns to the tenant (404 for another tenant's campaign)", async () => {
    vi.spyOn(emailCampaignsRepository, "find").mockResolvedValue({ id: "x", userId: adminB.id } as never);
    vi.spyOn(smsCampaignsRepository, "find").mockResolvedValue({ id: "y", userId: adminB.id } as never);
    const s = await login(app, "mk_admin_a");
    await s.agent.get("/api/email-marketing/campaigns/x").expect(404);
    await s.agent.post("/api/sms-marketing/campaigns/y/send").set("X-CSRF-Token", s.csrf).expect(404);
  });

  it("keeps the gateway admin-only", async () => {
    const s = await login(app, "mk_agent");
    await s.agent.post("/api/sms-marketing/gateway").set("X-CSRF-Token", s.csrf).send({ provider: "simulator" }).expect(403);
  });

  it("serves the segment calculator publicly and validates input", async () => {
    const r = await request(app).post("/api/sms-marketing/calculate-segments").send({ message: "Hello 👋" }).expect(200);
    expect(r.body).toMatchObject({ encoding: "UCS-2", segments: 1 });
  });

  it("answers the open pixel for any token without leaking validity", async () => {
    const r = await request(app).get("/api/email-marketing/o/bogus.gif").expect(200);
    expect(r.headers["content-type"]).toBe("image/gif");
  });

  it("rejects invalid unsubscribe tokens without CSRF", async () => {
    await request(app).post("/api/email-marketing/unsubscribe/not-a-token").expect(404);
  });
});
