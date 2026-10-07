/**
 * Click tracking for email and SMS campaigns. When a campaign starts, its links are stored in
 * tracked_links (UTM applied); each recipient gets links that pass through /l/<signed token>
 * (email) or /s/<short code> (SMS) and redirect to the destination after counting the click.
 */
import { emitForCampaign } from "./webhook-events";
import crypto from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { appendUtm, extractHtmlLinks, extractTextUrls, resolveUtm, rewriteHtmlLinks, rewriteTextUrls, SHORT_CODE_LENGTH } from "@shared/tracking";
import { renderMergeTags } from "@shared/sms";
import { emailCampaignRecipients, emailCampaigns, linkClicks, shortLinks, smsCampaignRecipients, smsCampaigns, trackedLinks, type TrackedLink, type UtmSettings } from "@shared/schema";
import { db } from "../db";
import { childLogger } from "../lib/logger";
import { publicBaseUrl, signToken, verifyToken } from "../lib/tokens";
import { contactsRepository } from "../repositories/contacts.repository";
import { systemConfig } from "./system-config.service";

const log = childLogger("tracking");
export type CampaignType = "email" | "sms";
/** originalUrl → link id */
export type LinkMap = Map<string, number>;

// ---------------------------------------------------------------------------
// Preparing links
// ---------------------------------------------------------------------------

/** Creates tracked links for a campaign's URLs (idempotent: existing links are reused). */
export async function prepareLinks(type: CampaignType, campaignId: string, urls: string[], utm: UtmSettings | null | undefined, campaignName: string): Promise<LinkMap> {
  cache.delete(`${type}:${campaignId}`);
  const existing = await loadLinks(type, campaignId);
  const resolved = resolveUtm(utm, { source: (await systemConfig.get()).siteTitle ?? "newsletter", medium: type, campaign: campaignName });
  const fresh = urls.filter((u) => !existing.has(u));
  if (fresh.length) {
    const start = existing.size;
    await db.insert(trackedLinks).values(fresh.map((u, i) => ({ campaignType: type, campaignId, originalUrl: u, url: appendUtm(u, resolved), position: start + i })));
  }
  // Never serve a cached map from before the insert.
  cache.delete(`${type}:${campaignId}`);
  return linksFor(type, campaignId);
}

async function loadLinks(type: CampaignType, campaignId: string): Promise<LinkMap> {
  const rows = await db.select({ id: trackedLinks.id, originalUrl: trackedLinks.originalUrl }).from(trackedLinks).where(and(eq(trackedLinks.campaignType, type), eq(trackedLinks.campaignId, campaignId))).orderBy(asc(trackedLinks.position));
  return new Map(rows.map((r) => [r.originalUrl, r.id]));
}

/** Link map for a campaign, cached briefly so the worker doesn't reload it for every recipient. */
const cache = new Map<string, { at: number; map: LinkMap }>();
export async function linksFor(type: CampaignType, campaignId: string): Promise<LinkMap> {
  const key = `${type}:${campaignId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.map;
  const map = await loadLinks(type, campaignId);
  // Empty maps aren't cached: links may be prepared a moment later.
  if (map.size) cache.set(key, { at: Date.now(), map });
  return map;
}

export async function prepareEmailLinks(c: { id: string; name: string; contentHtml: string; contentText?: string | null; utm?: UtmSettings | null }, extraHtml: string[] = []) {
  const urls = [...new Set([...[c.contentHtml, ...extraHtml].flatMap(extractHtmlLinks), ...(c.contentText ? extractTextUrls(c.contentText) : [])])];
  return prepareLinks("email", c.id, urls, c.utm, c.name);
}

export async function prepareSmsLinks(c: { id: string; name: string; message: string; utm?: UtmSettings | null }, extraMessages: string[] = []) {
  const urls = [...new Set([c.message, ...extraMessages].flatMap(extractTextUrls))];
  return prepareLinks("sms", c.id, urls, c.utm, c.name);
}

/** What an SMS will look like once links are shortened (for segment estimates). */
export const smsWithShortLinkPlaceholders = (message: string) => rewriteTextUrls(message, () => `${publicBaseUrl()}/s/${"x".repeat(SHORT_CODE_LENGTH)}`);

// ---------------------------------------------------------------------------
// Per-recipient rewriting
// ---------------------------------------------------------------------------

const clickUrl = (linkId: number, recipientId: string) => `${publicBaseUrl()}/l/${signToken("click", `${linkId}-${recipientId}`)}`;

/** Email: tracked hrefs in HTML and tracked URLs in the text part (before merge tags are filled). */
export function trackEmailLinks(html: string, text: string | null | undefined, links: LinkMap, recipientId: string) {
  const swap = (u: string) => (links.has(u) ? clickUrl(links.get(u)!, recipientId) : null);
  return { html: rewriteHtmlLinks(html, swap), text: text ? rewriteTextUrls(text, swap) : text };
}

const CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(crypto.randomBytes(SHORT_CODE_LENGTH), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

/** SMS: replaces each tracked URL with a short per-recipient link (before merge tags are filled). */
export async function shortenSmsLinks(message: string, links: LinkMap, recipientId: string): Promise<string> {
  const urls = extractTextUrls(message).filter((u) => links.has(u));
  if (!urls.length) return message;
  const codes = new Map<string, string>();
  for (const u of urls) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const [res] = await db.insert(shortLinks).ignore().values({ code, linkId: links.get(u)!, recipientId });
      if (res.affectedRows) {
        codes.set(u, code);
        break;
      }
    }
  }
  return rewriteTextUrls(message, (u) => (codes.has(u) ? `${publicBaseUrl()}/s/${codes.get(u)}` : null));
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

/** Link scanners and previewers (security gateways, chat apps) open links without a person clicking. */
const NON_HUMAN = /bot|crawler|spider|preview|scanner|proofpoint|mimecast|barracuda|safelinks|urldefense|facebookexternalhit|whatsapp|slackbot|discordbot|curl|wget|python-requests|go-http-client/i;

export function decodeClickToken(token: string): { linkId: number; recipientId: string } | null {
  const v = verifyToken("click", token);
  const m = v && /^(\d+)-([0-9a-f-]{36})$/.exec(v);
  return m ? { linkId: Number(m[1]), recipientId: m[2] } : null;
}

async function recipientInfo(type: CampaignType, recipientId: string) {
  if (type === "email") {
    const [r] = await db.select({ name: emailCampaignRecipients.name, email: emailCampaignRecipients.email, contactId: emailCampaignRecipients.contactId, campaignId: emailCampaignRecipients.campaignId }).from(emailCampaignRecipients).where(eq(emailCampaignRecipients.id, recipientId)).limit(1);
    return r ? { ...r, phone: null as string | null } : undefined;
  }
  const [r] = await db.select({ name: smsCampaignRecipients.name, phone: smsCampaignRecipients.phone, contactId: smsCampaignRecipients.contactId, campaignId: smsCampaignRecipients.campaignId }).from(smsCampaignRecipients).where(eq(smsCampaignRecipients.id, recipientId)).limit(1);
  return r ? { ...r, email: null as string | null } : undefined;
}

/** Fills merge tags in a destination URL (values URL-encoded). Only http(s) results are allowed. */
async function destination(link: TrackedLink, info: Awaited<ReturnType<typeof recipientInfo>>): Promise<string> {
  let url = link.url;
  if (info && /\{\{/.test(url)) {
    const fields = info.contactId ? (await contactsRepository.fieldsByIds([info.contactId])).get(info.contactId) ?? {} : {};
    url = renderMergeTags(url, { name: info.name, email: info.email, phone: info.phone, fields }, encodeURIComponent);
  }
  return /^https?:\/\//i.test(url) ? url : publicBaseUrl();
}

/**
 * Records a click and returns where to redirect. Clicks by link scanners and HEAD requests
 * still redirect but aren't counted. The first click also counts as an open for email.
 */
export async function recordClick(link: TrackedLink, recipientId: string, req: { method: string; ip?: string; userAgent?: string }): Promise<string> {
  const info = await recipientInfo(link.campaignType as CampaignType, recipientId);
  const target = await destination(link, info);
  if (!info || info.campaignId !== link.campaignId) return target;
  if (req.method === "HEAD" || NON_HUMAN.test(req.userAgent ?? "")) return target;
  try {
    const [[{ seen }]] = (await db.execute(sql`SELECT COUNT(*) AS seen FROM ${linkClicks} WHERE ${linkClicks.linkId} = ${link.id} AND ${linkClicks.recipientId} = ${recipientId}`)) as unknown as [[{ seen: number }]];
    await db.insert(linkClicks).values({ linkId: link.id, recipientId, contactId: info.contactId ?? null, ip: req.ip?.slice(0, 64) ?? null, userAgent: req.userAgent?.slice(0, 300) ?? null });
    await db
      .update(trackedLinks)
      .set({ clicks: sql`${trackedLinks.clicks} + 1`, uniqueClicks: sql`${trackedLinks.uniqueClicks} + ${Number(seen) ? 0 : 1}` })
      .where(eq(trackedLinks.id, link.id));
    // First click by this recipient on any link: count a unique clicker.
    if (link.campaignType === "email") {
      const [res] = await db.update(emailCampaignRecipients).set({ clickedAt: new Date() }).where(and(eq(emailCampaignRecipients.id, recipientId), isNull(emailCampaignRecipients.clickedAt)));
      if (res.affectedRows) await db.update(emailCampaigns).set({ clickedCount: sql`${emailCampaigns.clickedCount} + 1` }).where(eq(emailCampaigns.id, link.campaignId));
      emitForCampaign("email", link.campaignId, "email.clicked", { campaignId: link.campaignId, email: info.email ?? null, contactId: info.contactId ?? null, url: target, firstClick: Boolean(res.affectedRows), at: new Date().toISOString() });
      // A click proves the email was opened, even when images were blocked.
      const [opened] = await db.update(emailCampaignRecipients).set({ openedAt: new Date() }).where(and(eq(emailCampaignRecipients.id, recipientId), isNull(emailCampaignRecipients.openedAt)));
      if (opened.affectedRows) await db.update(emailCampaigns).set({ openedCount: sql`${emailCampaigns.openedCount} + 1` }).where(eq(emailCampaigns.id, link.campaignId));
    } else {
      const [res] = await db.update(smsCampaignRecipients).set({ clickedAt: new Date() }).where(and(eq(smsCampaignRecipients.id, recipientId), isNull(smsCampaignRecipients.clickedAt)));
      if (res.affectedRows) await db.update(smsCampaigns).set({ clickedCount: sql`${smsCampaigns.clickedCount} + 1` }).where(eq(smsCampaigns.id, link.campaignId));
      emitForCampaign("sms", link.campaignId, "sms.clicked", { campaignId: link.campaignId, phone: info.phone ?? null, contactId: info.contactId ?? null, url: target, firstClick: Boolean(res.affectedRows), at: new Date().toISOString() });
    }
  } catch (err) {
    log.warn({ err: (err as Error).message, linkId: link.id }, "Click not recorded");
  }
  return target;
}

export async function findLink(id: number): Promise<TrackedLink | undefined> {
  return (await db.select().from(trackedLinks).where(eq(trackedLinks.id, id)).limit(1))[0];
}

export async function resolveShortCode(code: string): Promise<{ link: TrackedLink; recipientId: string } | null> {
  const [s] = await db.select().from(shortLinks).where(eq(shortLinks.code, code)).limit(1);
  const link = s ? await findLink(s.linkId) : undefined;
  return s && link ? { link, recipientId: s.recipientId } : null;
}

/** Per-link stats for a campaign (newest first by position). */
export async function linkStats(type: CampaignType, campaignId: string) {
  return db
    .select({ id: trackedLinks.id, url: trackedLinks.url, originalUrl: trackedLinks.originalUrl, clicks: trackedLinks.clicks, uniqueClicks: trackedLinks.uniqueClicks })
    .from(trackedLinks)
    .where(and(eq(trackedLinks.campaignType, type), eq(trackedLinks.campaignId, campaignId)))
    .orderBy(asc(trackedLinks.position));
}

/** Removes a campaign's links (and, by cascade, their clicks and short codes). */
export async function deleteCampaignLinks(type: CampaignType, campaignId: string) {
  cache.delete(`${type}:${campaignId}`);
  await db.delete(trackedLinks).where(and(eq(trackedLinks.campaignType, type), eq(trackedLinks.campaignId, campaignId)));
}
