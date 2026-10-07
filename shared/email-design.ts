/**
 * Drag-and-drop email designs: a list of blocks plus global settings, rendered to
 * table-based, inline-styled HTML that works in Outlook, Gmail and Apple Mail.
 * The browser (live canvas and preview) and the server (what is sent) share this renderer.
 */
import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/, "Use a hex colour like #1a73e8");
const align = z.enum(["left", "center", "right"]).default("left");
const id = z.string().min(1).max(40);
/** Links: http(s), mailto, tel, or a merge tag such as {{unsubscribe_url}}. */
const href = z.string().trim().max(2000);

export const blockSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("heading"), text: z.string().max(500), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1), align, color: color.nullish() }),
  z.object({ id, type: z.literal("text"), text: z.string().max(20_000), align, fontSize: z.number().int().min(12).max(24).default(16), color: color.nullish() }),
  z.object({
    id,
    type: z.literal("button"),
    label: z.string().max(200),
    url: href,
    align: align.default("center"),
    color: color.default("#16a34a"),
    textColor: color.default("#ffffff"),
    radius: z.number().int().min(0).max(40).default(6),
    fullWidth: z.boolean().default(false),
  }),
  z.object({ id, type: z.literal("image"), src: z.string().trim().max(2000), alt: z.string().max(300).default(""), url: href.default(""), width: z.number().int().min(10).max(100).default(100), align: align.default("center") }),
  z.object({ id, type: z.literal("divider"), color: color.default("#e5e7eb"), thickness: z.number().int().min(1).max(8).default(1) }),
  z.object({ id, type: z.literal("spacer"), height: z.number().int().min(4).max(160).default(24) }),
  z.object({
    id,
    type: z.literal("columns"),
    columns: z
      .array(z.object({ image: z.string().trim().max(2000).default(""), text: z.string().max(5000).default("") }))
      .length(2),
  }),
  z.object({ id, type: z.literal("social"), links: z.array(z.object({ label: z.string().max(40), url: href })).max(8), align: align.default("center") }),
  z.object({ id, type: z.literal("footer"), text: z.string().max(2000) }),
  z.object({ id, type: z.literal("html"), html: z.string().max(100_000) }),
]);
export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block["type"];

export const FONT_STACKS = {
  sans: "Helvetica,Arial,sans-serif",
  serif: "Georgia,'Times New Roman',serif",
  modern: "'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "'Courier New',Courier,monospace",
} as const;

export const designSettingsSchema = z.object({
  backgroundColor: color.default("#f3f4f6"),
  contentBackground: color.default("#ffffff"),
  width: z.number().int().min(480).max(800).default(600),
  font: z.enum(["sans", "serif", "modern", "mono"]).default("sans"),
  textColor: color.default("#111827"),
  linkColor: color.default("#16a34a"),
});
export type DesignSettings = z.infer<typeof designSettingsSchema>;

export const emailDesignSchema = z.object({
  version: z.literal(1).default(1),
  settings: designSettingsSchema.default({}),
  blocks: z.array(blockSchema).max(200),
});
export type EmailDesign = z.infer<typeof emailDesignSchema>;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A link target that is safe to put in href/src, or null. */
export function safeUrl(raw: string, { image = false } = {}): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/^\{\{\s*[a-z_][a-z0-9_]*\s*\}\}$/i.test(url)) return url;
  if (/^https?:\/\/[^\s"<>]+$/i.test(url)) return url;
  if (!image && /^(mailto|tel):[^\s"<>]+$/i.test(url)) return url;
  // Links whose host or query comes from a merge tag, e.g. https://shop.test/?u={{email}}
  if (/^https?:\/\/[^\s"<>]*\{\{/i.test(url)) return url;
  return null;
}

/**
 * Minimal formatting for text blocks: **bold**, *italic*, [label](url) and line breaks.
 * Everything else is escaped, so text blocks can't inject HTML.
 */
export function formatText(text: string, linkColor: string): string {
  let out = esc(text);
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const u = safeUrl(url.replace(/&amp;/g, "&"));
    return u ? `<a href="${esc(u)}" style="color:${linkColor};text-decoration:underline">${label}</a>` : label;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return out
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, "<br>"))
    .join('</p><p style="margin:12px 0 0">');
}

const HEADING_SIZE = { 1: 28, 2: 22, 3: 18 } as const;

/** One block as a table row (`<tr>`), the unit the canvas and the full email both use. */
export function renderBlock(b: Block, s: DesignSettings): string {
  const font = FONT_STACKS[s.font];
  const pad = "padding:12px 32px";
  const cell = (inner: string, style = "") => `<tr><td style="${pad};${style}">${inner}</td></tr>`;
  switch (b.type) {
    case "heading": {
      const size = HEADING_SIZE[b.level];
      return cell(`<h${b.level} style="margin:0;font-family:${font};font-size:${size}px;line-height:1.25;font-weight:700;color:${b.color ?? s.textColor};text-align:${b.align}">${esc(b.text) || "&nbsp;"}</h${b.level}>`);
    }
    case "text":
      return cell(`<p style="margin:0">${formatText(b.text, s.linkColor) || "&nbsp;"}</p>`, `font-family:${font};font-size:${b.fontSize}px;line-height:1.6;color:${b.color ?? s.textColor};text-align:${b.align}`);
    case "button": {
      const url = safeUrl(b.url) ?? "#";
      const width = b.fullWidth ? "width:100%;" : "";
      const btn = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${width}${b.align === "center" ? "margin:0 auto;" : b.align === "right" ? "margin-left:auto;" : ""}"><tr><td align="center" bgcolor="${b.color}" style="border-radius:${b.radius}px;background:${b.color}"><a href="${esc(url)}" target="_blank" style="display:${b.fullWidth ? "block" : "inline-block"};padding:12px 24px;font-family:${font};font-size:16px;font-weight:600;line-height:1.2;color:${b.textColor};text-decoration:none;border-radius:${b.radius}px">${esc(b.label) || "Button"}</a></td></tr></table>`;
      return cell(btn, `text-align:${b.align}`);
    }
    case "image": {
      const src = safeUrl(b.src, { image: true });
      if (!src) return cell(`<div style="padding:32px;border:1px dashed #d1d5db;text-align:center;font-family:${font};font-size:13px;color:#6b7280">Image: add a URL</div>`);
      const px = Math.round(((s.width - 64) * b.width) / 100);
      let img = `<img src="${esc(src)}" alt="${esc(b.alt)}" width="${px}" style="display:block;width:100%;max-width:${px}px;height:auto;border:0;${b.align === "center" ? "margin:0 auto;" : b.align === "right" ? "margin-left:auto;" : ""}">`;
      const link = safeUrl(b.url);
      if (link) img = `<a href="${esc(link)}" target="_blank">${img}</a>`;
      return cell(img, `text-align:${b.align}`);
    }
    case "divider":
      return cell(`<div style="border-top:${b.thickness}px solid ${b.color};font-size:0;line-height:0">&nbsp;</div>`);
    case "spacer":
      return `<tr><td style="height:${b.height}px;font-size:0;line-height:0">&nbsp;</td></tr>`;
    case "columns": {
      const col = (c: { image: string; text: string }) => {
        const src = safeUrl(c.image, { image: true });
        const img = src ? `<img src="${esc(src)}" alt="" style="display:block;width:100%;height:auto;border:0;margin:0 0 8px">` : "";
        return `<td class="wm-col" width="50%" valign="top" style="width:50%;padding:0 8px;font-family:${font};font-size:15px;line-height:1.5;color:${s.textColor}">${img}${c.text ? `<p style="margin:0">${formatText(c.text, s.linkColor)}</p>` : ""}</td>`;
      };
      return `<tr><td style="padding:12px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${b.columns.map(col).join("")}</tr></table></td></tr>`;
    }
    case "social": {
      const links = b.links
        .map((l) => {
          const u = safeUrl(l.url);
          return u && l.label.trim() ? `<a href="${esc(u)}" target="_blank" style="color:${s.linkColor};text-decoration:none;font-weight:600">${esc(l.label)}</a>` : "";
        })
        .filter(Boolean)
        .join(' <span style="color:#9ca3af">&nbsp;·&nbsp;</span> ');
      return cell(links || "&nbsp;", `font-family:${font};font-size:14px;text-align:${b.align}`);
    }
    case "footer":
      return cell(
        `<p style="margin:0">${formatText(b.text, "#6b7280")}</p><p style="margin:8px 0 0"><a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a></p>`,
        `padding-top:24px;font-family:${font};font-size:12px;line-height:1.5;color:#6b7280;text-align:center`,
      );
    case "html":
      return `<tr><td style="${pad}">${b.html}</td></tr>`;
  }
}

/** The complete email document. */
export function renderDesign(input: EmailDesign, opts: { title?: string } = {}): string {
  // Invalid input (mid-edit in the builder) renders as given; the server always validates first.
  const parsed = emailDesignSchema.safeParse(input);
  const d = parsed.success ? parsed.data : input;
  const s = d.settings;
  const rows = d.blocks.map((b) => renderBlock(b, s)).join("\n");
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(opts.title ?? "")}</title>
<style>
a{color:${s.linkColor}}
@media only screen and (max-width:${s.width + 20}px){
  .wm-container{width:100%!important}
  .wm-col{display:block!important;width:100%!important;padding:0 0 16px!important}
}
</style>
</head>
<body style="margin:0;padding:0;background:${s.backgroundColor}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${s.backgroundColor}" style="background:${s.backgroundColor}">
<tr><td align="center" style="padding:24px 8px">
<table role="presentation" class="wm-container" width="${s.width}" cellpadding="0" cellspacing="0" border="0" bgcolor="${s.contentBackground}" style="width:${s.width}px;max-width:100%;background:${s.contentBackground};border-radius:8px">
<tr><td style="height:20px;font-size:0;line-height:0">&nbsp;</td></tr>
${rows}
<tr><td style="height:20px;font-size:0;line-height:0">&nbsp;</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Builder helpers
// ---------------------------------------------------------------------------

export const BLOCK_LABELS: Record<BlockType, string> = {
  heading: "Heading",
  text: "Text",
  button: "Button",
  image: "Image",
  divider: "Divider",
  spacer: "Spacer",
  columns: "Two columns",
  social: "Social links",
  footer: "Footer",
  html: "Custom HTML",
};

const newId = () => Math.random().toString(36).slice(2, 10);

export function newBlock(type: BlockType): Block {
  const id = newId();
  switch (type) {
    case "heading":
      return { id, type, text: "Your headline", level: 1, align: "left" };
    case "text":
      return { id, type, text: "Hi {{first_name}},\n\nWrite your message here. Use **bold**, *italic* and [links](https://example.com).", align: "left", fontSize: 16 };
    case "button":
      return { id, type, label: "Shop now", url: "", align: "center", color: "#16a34a", textColor: "#ffffff", radius: 6, fullWidth: false };
    case "image":
      return { id, type, src: "", alt: "", url: "", width: 100, align: "center" };
    case "divider":
      return { id, type, color: "#e5e7eb", thickness: 1 };
    case "spacer":
      return { id, type, height: 24 };
    case "columns":
      return { id, type, columns: [{ image: "", text: "**First item**\nA short description." }, { image: "", text: "**Second item**\nA short description." }] };
    case "social":
      return { id, type, align: "center", links: [{ label: "Instagram", url: "https://instagram.com/" }, { label: "Facebook", url: "https://facebook.com/" }] };
    case "footer":
      return { id, type, text: "Your Company · 123 Street, City\nYou're receiving this because you subscribed." };
    case "html":
      return { id, type, html: "<p>Custom HTML</p>" };
  }
}

/** Fresh ids, e.g. when duplicating. */
export const cloneBlock = (b: Block): Block => ({ ...structuredClone(b), id: newId() });

export function starterDesign(kind: "blank" | "newsletter" | "promotion" = "newsletter"): EmailDesign {
  const settings = designSettingsSchema.parse({});
  if (kind === "blank") return { version: 1, settings, blocks: [newBlock("text"), newBlock("footer")] };
  if (kind === "promotion") {
    return {
      version: 1,
      settings: { ...settings, linkColor: "#dc2626" },
      blocks: [
        { ...newBlock("heading"), text: "48-hour sale: 30% off everything", align: "center" } as Block,
        { ...newBlock("image") },
        { ...newBlock("text"), text: "Hi {{first_name}}, our biggest sale of the season ends soon. Use code **SAVE30** at checkout.", align: "center" } as Block,
        { ...newBlock("button"), label: "Shop the sale", color: "#dc2626" } as Block,
        newBlock("divider"),
        newBlock("footer"),
      ],
    };
  }
  return {
    version: 1,
    settings,
    blocks: [newBlock("heading"), newBlock("text"), newBlock("button"), newBlock("divider"), newBlock("columns"), newBlock("social"), newBlock("footer")],
  };
}
