import { describe, it, expect } from "vitest";
import { appendUtm, extractHtmlLinks, extractTextUrls, resolveUtm, rewriteHtmlLinks, rewriteTextUrls, slugify } from "@shared/tracking";
import { decodeClickToken } from "../services/tracking.service";
import { renderEmail } from "../services/email/render";
import { signToken } from "../lib/tokens";

const utm = resolveUtm({ enabled: true, source: "", medium: "", campaign: "" }, { source: "Acme Store", medium: "email", campaign: "Autumn Sale 2026!" })!;

describe("UTM", () => {
  it("fills defaults from the brand, channel and campaign name", () => {
    expect(utm).toMatchObject({ source: "acme-store", medium: "email", campaign: "autumn-sale-2026" });
    expect(slugify("Café Déjà Vu")).toBe("cafe-deja-vu");
    expect(resolveUtm({ enabled: false }, { source: "x", medium: "email", campaign: "y" })).toBeNull();
  });

  it("appends parameters, keeping existing ones, fragments and merge tags", () => {
    expect(appendUtm("https://shop.test/sale", utm)).toBe("https://shop.test/sale?utm_source=acme-store&utm_medium=email&utm_campaign=autumn-sale-2026");
    expect(appendUtm("https://shop.test/p?id=4#reviews", utm)).toBe("https://shop.test/p?id=4&utm_source=acme-store&utm_medium=email&utm_campaign=autumn-sale-2026#reviews");
    expect(appendUtm("https://shop.test/?utm_source=ig&e={{email}}", utm)).toBe("https://shop.test/?utm_source=ig&e={{email}}&utm_medium=email&utm_campaign=autumn-sale-2026");
    expect(appendUtm("https://shop.test/x", null)).toBe("https://shop.test/x");
  });
});

describe("link extraction", () => {
  const html = `<p><a href="https://shop.test/a?x=1&amp;y=2">A</a> <a class="b" href='https://shop.test/b'>B</a>
    <a href="mailto:hi@shop.test">mail</a> <a href="{{unsubscribe_url}}">unsub</a> <a href="#top">top</a> <a href="https://shop.test/a?x=1&amp;y=2">again</a></p>`;

  it("finds distinct http(s) links only", () => {
    expect(extractHtmlLinks(html)).toEqual(["https://shop.test/a?x=1&y=2", "https://shop.test/b"]);
  });

  it("rewrites every occurrence, leaving other links alone", () => {
    const out = rewriteHtmlLinks(html, (u) => (u.endsWith("/b") ? "https://t.test/2" : "https://t.test/1"));
    expect(out.match(/https:\/\/t\.test\/1/g)).toHaveLength(2);
    expect(out).toContain(`href='https://t.test/2'`);
    expect(out).toContain('href="mailto:hi@shop.test"');
    expect(out).toContain('href="{{unsubscribe_url}}"');
  });

  it("finds URLs in text without trailing punctuation", () => {
    const text = "Sale on (https://shop.test/sale). Also https://shop.test/b, and http://x.test!";
    expect(extractTextUrls(text)).toEqual(["https://shop.test/sale", "https://shop.test/b", "http://x.test"]);
    expect(rewriteTextUrls(text, () => "S")).toBe("Sale on (S). Also S, and S!");
  });
});

describe("click links in emails", () => {
  const rid = "11111111-2222-3333-4444-555555555555";

  it("signs tokens that decode to link and recipient, and rejects tampering", () => {
    const token = signToken("click", `42-${rid}`);
    expect(decodeClickToken(token)).toEqual({ linkId: 42, recipientId: rid });
    expect(decodeClickToken(token.replace(/^42/, "43"))).toBeNull();
    expect(decodeClickToken(signToken("open", `42-${rid}`))).toBeNull();
  });

  it("routes tracked links through /l/ in HTML and text, before merge tags are filled", () => {
    const links = new Map([["https://shop.test/p?e={{email}}", 7]]);
    const r = renderEmail({ subject: "Hi", contentHtml: '<html><body><a href="https://shop.test/p?e={{email}}">Shop</a> <a href="https://other.test">x</a></body></html>' }, { id: rid, email: "ada@x.test", name: "Ada" }, links);
    const tracked = r.html.match(/href="([^"]*\/l\/[^"]+)"/)?.[1];
    expect(tracked).toBeDefined();
    expect(decodeClickToken(tracked!.split("/l/")[1])).toEqual({ linkId: 7, recipientId: rid });
    expect(r.html).not.toContain("ada%40x.test");
    expect(r.html).toContain('href="https://other.test"');
    expect(r.text).toContain("/l/");
  });

  it("leaves test sends (no recipient id) untracked", () => {
    const r = renderEmail({ subject: "Hi", contentHtml: '<a href="https://shop.test">x</a>' }, { email: "a@x.test" }, new Map([["https://shop.test", 1]]));
    expect(r.html).not.toContain("/l/");
  });
});

describe("preparing links", () => {
  it("returns the newly created links, not a stale empty cache", async () => {
    const { vi } = await import("vitest");
    const { db } = await import("../db");
    const { systemConfig } = await import("../services/system-config.service");
    const svc = await import("../services/tracking.service");
    vi.spyOn(systemConfig, "get").mockResolvedValue({ siteTitle: "Acme" } as never);
    const stored: { id: number; originalUrl: string }[] = [];
    // Minimal stand-ins for the two queries prepareLinks makes.
    vi.spyOn(db, "select").mockImplementation((() => ({ from: () => ({ where: () => ({ orderBy: async () => [...stored] }) }) })) as never);
    vi.spyOn(db, "insert").mockImplementation((() => ({ values: async (rows: { originalUrl: string }[]) => rows.forEach((r) => stored.push({ id: stored.length + 1, originalUrl: r.originalUrl })) })) as never);
    const map = await svc.prepareLinks("email", "c-cache-test", ["https://a.test", "https://b.test"], null, "x");
    expect([...map.keys()]).toEqual(["https://a.test", "https://b.test"]);
    expect((await svc.linksFor("email", "c-cache-test")).size).toBe(2);
    vi.restoreAllMocks();
  });
});
