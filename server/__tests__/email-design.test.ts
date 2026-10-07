import { describe, it, expect } from "vitest";
import { emailDesignSchema, formatText, newBlock, renderDesign, safeUrl, starterDesign, type Block } from "@shared/email-design";
import { emailCampaignSchema } from "@shared/validation";
import { renderEmail } from "../services/email/render";

const design = (blocks: Block[]) => emailDesignSchema.parse({ blocks });

describe("email design", () => {
  it("escapes text and only allows safe links", () => {
    const html = renderDesign(design([{ ...newBlock("heading"), text: `<script>alert(1)</script>` } as Block, { ...newBlock("text"), text: `Hi "you" [click](javascript:alert(1)) and [ok](https://shop.test/?a=1&b=2)` } as Block]));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://shop.test/?a=1&amp;b=2"');
    expect(safeUrl("{{unsubscribe_url}}")).toBe("{{unsubscribe_url}}");
    expect(safeUrl("https://x.test/?u={{email}}")).toBe("https://x.test/?u={{email}}");
    expect(safeUrl("mailto:a@b.c", { image: true })).toBeNull();
    expect(safeUrl('https://x.test/"onerror="')).toBeNull();
  });

  it("formats bold, italic, paragraphs", () => {
    expect(formatText("**Big** and *small*\nline\n\nnext", "#000")).toBe('<strong>Big</strong> and <em>small</em><br>line</p><p style="margin:12px 0 0">next');
  });

  it("renders every block type in a table layout with a footer unsubscribe link", () => {
    const all = (["heading", "text", "button", "image", "divider", "spacer", "columns", "social", "footer", "html"] as const).map(newBlock);
    const html = renderDesign(design(all), { title: "Hello" });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('class="wm-container" width="600"');
    expect(html).toContain("{{unsubscribe_url}}");
    expect(html).toContain("@media only screen");
    expect(html).toContain("<title>Hello</title>");
    // The unsubscribe link from the footer block is used instead of the auto-appended one.
    const sent = renderEmail({ subject: "s", contentHtml: html }, { id: "r1", email: "a@b.c", name: "Priya Sharma" });
    expect(sent.html.match(/Unsubscribe<\/a>/g)?.length).toBe(1);
    expect(sent.html).toContain("Hi Priya,");
  });

  it("validates designs on campaigns", () => {
    const base = { name: "n", subject: "s", senderName: "x", contentHtml: "<p>x</p>", targetAudience: "all_contacts" };
    expect(emailCampaignSchema.safeParse({ ...base, design: starterDesign("promotion") }).success).toBe(true);
    expect(emailCampaignSchema.safeParse({ ...base, design: { blocks: [{ id: "a", type: "button", label: "x", url: "https://", color: "red" }] } }).success).toBe(false);
    expect(emailCampaignSchema.safeParse({ ...base, design: { blocks: [{ id: "a", type: "marquee" }] } }).success).toBe(false);
  });
});
