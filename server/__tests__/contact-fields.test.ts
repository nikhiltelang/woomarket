import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Express } from "express";
import { contactFieldsSchema, normalizeFieldKey } from "@shared/contact-fields";
import { contactSchema } from "@shared/validation";
import { renderMergeTags } from "@shared/sms";
import { createApp } from "../app";
import { login, makeChannel, makeUser, mockDirectory } from "./helpers";
import { contactsRepository } from "../repositories/contacts.repository";
import { billingRepository } from "../repositories/billing.repository";
import { resolveVariable } from "../services/campaign.service";
import { renderEmail } from "../services/email/render";

const admin = makeUser({ username: "f_admin", role: "admin" });
const channel = makeChannel({ createdBy: admin.id });
let app: Express;

beforeEach(() => {
  mockDirectory([admin], [channel]);
  // An active plan without limits, so plan checks pass without a database.
  vi.spyOn(billingRepository, "activeSubscription").mockResolvedValue({ planData: { name: "Test", permissions: {} } } as never);
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

describe("field names", () => {
  it("normalises to snake_case merge-tag keys", () => {
    expect(normalizeFieldKey("Age")).toBe("age");
    expect(normalizeFieldKey(" Home Address ")).toBe("home_address");
    expect(normalizeFieldKey("Date-of-Birth")).toBe("date_of_birth");
    expect(normalizeFieldKey("2nd phone")).toBe("f_2nd_phone");
    expect(normalizeFieldKey("Café")).toBe("cafe");
    expect(normalizeFieldKey("!!!")).toBe("");
  });

  it("validates and converts values to strings, dropping empty ones", () => {
    expect(contactFieldsSchema.parse({ Age: 34, "Home Address": " 12 High St ", vip: true, note: "", gone: null })).toEqual({ age: "34", home_address: "12 High St", vip: "true" });
    expect(contactFieldsSchema.safeParse({ Email: "x" }).success).toBe(false); // built-in
    expect(contactFieldsSchema.safeParse({ age: "1", AGE: "2" }).success).toBe(false); // same field twice
    expect(contactFieldsSchema.safeParse({ "%%": "x" }).success).toBe(false);
    expect(contactFieldsSchema.safeParse({ bio: "x".repeat(1001) }).success).toBe(false);
    expect(contactFieldsSchema.safeParse(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, "x"]))).success).toBe(false);
    expect(contactSchema.parse({ name: "A", phone: "+14155550123", metadata: { City: "Pune" } }).metadata).toEqual({ city: "Pune" });
  });
});

describe("merge tags", () => {
  it("fills custom fields and blanks missing ones for real sends", () => {
    const fields = { age: "34", city: "Pune" };
    expect(renderMergeTags("Hi {{first_name}}, {{age}} in {{ city }}{{zip}}", { name: "Ada Lovelace", fields })).toBe("Hi Ada, 34 in Pune");
    // Previews (no fields) leave custom tags untouched.
    expect(renderMergeTags("{{age}}", { name: "A" })).toBe("{{age}}");
  });

  it("escapes field values in email HTML and keeps the unsubscribe link", () => {
    const r = renderEmail(
      { subject: "For {{city}}", previewText: null, contentHtml: "<html><body><p>{{city}}</p><a href=\"{{unsubscribe_url}}\">x</a></body></html>", contentText: null } as never,
      { id: "r1", name: "Ada", email: "a@x.test", fields: { city: "<b>Pune</b>" } },
    );
    expect(r.html).toContain("&lt;b&gt;Pune&lt;/b&gt;");
    expect(r.html).toContain("/unsubscribe/");
    expect(r.subject).toBe("For <b>Pune</b>");
  });

  it("maps WhatsApp template variables to custom fields", () => {
    const contact = { name: "Ada", phone: "+1", email: null, metadata: { plan: "Gold" } };
    expect(resolveVariable("field:meta.plan", contact)).toBe("Gold");
    expect(resolveVariable("field:meta.missing", contact)).toBe("");
  });
});

describe("contacts API", () => {
  it("stores custom fields when a contact is created", async () => {
    vi.spyOn(contactsRepository, "findByPhone").mockResolvedValue(undefined);
    const create = vi.spyOn(contactsRepository, "create").mockImplementation(async (v) => ({ id: "c1", ...v }) as never);
    const s = await login(app, "f_admin");
    const res = await s.agent
      .post("/api/contacts")
      .set("X-CSRF-Token", s.csrf)
      .send({ channelId: channel.id, name: "Ada", phone: "+14155550123", metadata: { Age: "34", "Home address": "12 High St" } })
      .expect(201);
    expect(create.mock.calls[0][0].metadata).toEqual({ age: "34", home_address: "12 High St" });
    expect(res.body.data.metadata).toEqual({ age: "34", home_address: "12 High St" });
  });

  it("rejects a built-in name used as a custom field", async () => {
    const s = await login(app, "f_admin");
    await s.agent.post("/api/contacts").set("X-CSRF-Token", s.csrf).send({ channelId: channel.id, name: "Ada", phone: "+14155550123", metadata: { phone: "x" } }).expect(400);
  });

  it("imports extra CSV columns as custom fields and can update existing contacts", async () => {
    const insert = vi.spyOn(contactsRepository, "insertManyIgnoreDuplicates").mockResolvedValue(1);
    const merge = vi.spyOn(contactsRepository, "mergeFields").mockResolvedValue(1);
    vi.spyOn(contactsRepository, "existingPhones").mockResolvedValue(new Set(["+14155550124"]));
    const s = await login(app, "f_admin");
    const csv = "Name,Phone,Email,Age,Home Address,Tags\nAda,+14155550123,ada@x.test,34,12 High St,vip\nGrace,+14155550124,,,\"1 Main, Rd\",\n";
    const res = await s.agent
      .post("/api/contacts/import")
      .set("X-CSRF-Token", s.csrf)
      .field("channelId", channel.id)
      .field("updateExisting", "true")
      .attach("file", Buffer.from(csv), "people.csv")
      .expect(200);
    const rows = insert.mock.calls[0][0];
    expect(rows[0]).toMatchObject({ name: "Ada", tags: ["vip"], metadata: { age: "34", home_address: "12 High St" } });
    expect(rows[1].metadata).toEqual({ home_address: "1 Main, Rd" }); // empty age dropped
    expect(res.body).toMatchObject({ imported: 1, updated: 1, fields: ["age", "home_address"] });
    // Only the contact that already existed is merged; the new one was inserted with its fields.
    expect(merge.mock.calls[0][1]).toEqual([{ phone: "+14155550124", metadata: { home_address: "1 Main, Rd" } }]);
  });
});
