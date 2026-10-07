import { renderMergeTags } from "@shared/sms";
import { publicBaseUrl, signToken } from "../../lib/tokens";
import { trackEmailLinks, type LinkMap } from "../tracking.service";

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain-text fallback derived from HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function insertBeforeBodyEnd(html: string, snippet: string): string {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${snippet}</body>`) : html + snippet;
}

function insertAfterBodyStart(html: string, snippet: string): string {
  return /<body[^>]*>/i.test(html) ? html.replace(/(<body[^>]*>)/i, `$1${snippet}`) : snippet + html;
}

export interface RenderInput {
  subject: string;
  previewText?: string | null;
  contentHtml: string;
  contentText?: string | null;
}

export interface RenderRecipient {
  /** Recipient row id; omitted for test sends (links become inert placeholders). */
  id?: string;
  name?: string | null;
  email: string;
  /** The contact's custom fields for {{field}} tags; omitted for previews and test sends. */
  fields?: Record<string, string>;
}

/**
 * Personalises a campaign for one recipient: merge tags (HTML-escaped in the body),
 * hidden preview text, a mandatory unsubscribe link, the open-tracking pixel and
 * RFC 8058 one-click unsubscribe headers.
 */
export function renderEmail(c: RenderInput, r: RenderRecipient, links?: LinkMap) {
  const base = publicBaseUrl();
  // Click tracking rewrites links in the raw template, so templated URLs ({{email}}) are
  // filled at click time instead of being baked into the tracked link.
  if (r.id && links?.size) {
    const t = trackEmailLinks(c.contentHtml, c.contentText ?? htmlToText(c.contentHtml), links, r.id);
    c = { ...c, contentHtml: t.html, contentText: t.text };
  }
  const unsubscribeUrl = r.id ? `${base}/api/email-marketing/unsubscribe/${signToken("unsubscribe", r.id)}` : `${base}/api/email-marketing/unsubscribe/test`;
  const values = { name: r.name ?? "", email: r.email, fields: r.fields };

  let html = renderMergeTags(c.contentHtml, values, escapeHtml).replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl);
  if (!html.includes(unsubscribeUrl)) {
    html = insertBeforeBodyEnd(
      html,
      `<p style="margin:24px 0 0;font:12px/1.5 Arial,sans-serif;color:#6b7280;text-align:center">You are receiving this email because you are a customer or subscriber. <a href="${unsubscribeUrl}" style="color:#6b7280">Unsubscribe</a></p>`,
    );
  }
  if (c.previewText) {
    html = insertAfterBodyStart(
      html,
      `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(renderMergeTags(c.previewText, values))}</div>`,
    );
  }
  if (r.id) {
    html = insertBeforeBodyEnd(html, `<img src="${base}/api/email-marketing/o/${signToken("open", r.id)}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`);
  }

  // Convert to text before merging, so values that look like markup ("<Ada>") survive verbatim.
  const textSource = renderMergeTags(c.contentText ?? htmlToText(c.contentHtml), values);
  let text = textSource.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl);
  if (!text.includes(unsubscribeUrl)) text += `\n\nUnsubscribe: ${unsubscribeUrl}`;

  return {
    subject: renderMergeTags(c.subject, values),
    html,
    text,
    unsubscribeUrl,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
