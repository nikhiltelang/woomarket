/** Link tracking and UTM helpers shared by the server and the campaign composers. */
import { z } from "zod";
import type { UtmSettings } from "./schema";

const utmValue = z.string().trim().max(100).default("");
export const utmSchema = z.object({
  enabled: z.boolean().default(false),
  source: utmValue,
  medium: utmValue,
  campaign: utmValue,
  content: utmValue,
});

/** "Autumn Sale 2026!" → "autumn-sale-2026" (default utm_campaign). */
export const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/** UTM values with defaults filled in: source = brand, medium = channel, campaign = campaign name. */
export function resolveUtm(utm: UtmSettings | null | undefined, d: { source: string; medium: string; campaign: string }): Required<UtmSettings> | null {
  if (!utm?.enabled) return null;
  return {
    enabled: true,
    source: utm.source?.trim() || slugify(d.source) || "newsletter",
    medium: utm.medium?.trim() || d.medium,
    campaign: utm.campaign?.trim() || slugify(d.campaign),
    content: utm.content?.trim() ?? "",
  };
}

/**
 * Appends UTM parameters to a URL without disturbing merge tags ({{email}}) or the #fragment.
 * Parameters already present in the URL are left as they are.
 */
export function appendUtm(url: string, utm: Required<UtmSettings> | null): string {
  if (!utm) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const params = (
    [
      ["utm_source", utm.source],
      ["utm_medium", utm.medium],
      ["utm_campaign", utm.campaign],
      ["utm_content", utm.content],
    ] as const
  ).filter(([k, v]) => v && !new RegExp(`[?&]${k}=`, "i").test(base));
  if (!params.length) return url;
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${base}${base.includes("?") ? (/[?&]$/.test(base) ? "" : "&") : "?"}${query}${hash}`;
}

/** Links worth tracking: absolute http(s), not the unsubscribe link. */
export const isTrackable = (href: string) => /^https?:\/\/[^\s]+$/i.test(href.trim()) && !/unsubscribe_url/i.test(href);

const HREF = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi;

/** Distinct trackable link targets in an HTML body, in order of first appearance. */
export function extractHtmlLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(HREF)) {
    const href = decodeEntities(m[3].trim());
    if (isTrackable(href) && !out.includes(href)) out.push(href);
  }
  return out;
}

/** Rewrites each trackable href through `rewrite` (returning null keeps the original). */
export function rewriteHtmlLinks(html: string, rewrite: (href: string) => string | null): string {
  return html.replace(HREF, (all, prefix: string, quote: string, href: string) => {
    const target = decodeEntities(href.trim());
    const next = isTrackable(target) ? rewrite(target) : null;
    return next ? `${prefix}${quote}${next}${quote}` : all;
  });
}

// Trailing punctuation usually ends the sentence, not the URL.
const TEXT_URL = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;

/** Distinct URLs in plain text (SMS bodies, text parts). */
export function extractTextUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TEXT_URL)) if (!out.includes(m[0]) && isTrackable(m[0])) out.push(m[0]);
  return out;
}

export function rewriteTextUrls(text: string, rewrite: (url: string) => string | null): string {
  return text.replace(TEXT_URL, (url) => (isTrackable(url) ? rewrite(url) ?? url : url));
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&#38;/g, "&");

/** Length of a short tracked link, for SMS segment estimates before codes exist. */
export const SHORT_CODE_LENGTH = 7;
