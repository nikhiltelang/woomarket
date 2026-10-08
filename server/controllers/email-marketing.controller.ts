import type { Request, Response } from "express";
import { saveImage } from "../lib/uploads";
import { publicBaseUrl } from "../lib/tokens";
import { abOverview, decideTest } from "../services/ab-test.service";
import { z } from "zod";
import { emailCampaignSchema, emailTemplateSchema, marketingStatusSchema, paginationQuery, testEmailSchema } from "@shared/validation";
import type { EmailCampaign } from "@shared/schema";
import { paginated, parse, parseBody, parseQuery } from "../lib/http";
import { badRequest, conflict, notFound } from "../lib/errors";
import { emailCampaignsRepository, emailTemplatesRepository } from "../repositories/email.repository";
import { renderDesign, type EmailDesign } from "@shared/email-design";
import { loadSegment } from "../services/segments.service";
import { groupsRepository } from "../repositories/groups.repository";
import { activityRepository } from "../repositories/activity.repository";
import { assertChannelAccess, requireTenantId } from "../middlewares/tenant";
import { assertWithinPlan } from "../middlewares/subscription";
import { resolveSmtp, sendEmail, simulatedOutbox } from "../services/email/mailer";
import { renderEmail } from "../services/email/render";
import { deleteCampaignLinks, linkStats } from "../services/tracking.service";
import {
  changeEmailCampaignStatus,
  recordEmailOpen,
  resolveEmailAudience,
  startEmailCampaign,
  unsubscribeEmail,
} from "../services/marketing.service";

async function loadCampaign(req: Request): Promise<EmailCampaign> {
  const tenantId = requireTenantId(req.user);
  const c = await emailCampaignsRepository.find(req.params.id);
  if (!c || c.userId !== tenantId) throw notFound("Campaign");
  return c;
}

/** Designed emails: the HTML is always rendered here from the design, never trusted from the browser. */
function withDesign(input: { contentHtml: string; contentText?: string | null; subject?: string | null; design?: EmailDesign | null }) {
  if (!input.design) return { contentHtml: input.contentHtml, contentText: input.contentText ?? null, design: null };
  return { contentHtml: renderDesign(input.design, { title: input.subject ?? "" }), contentText: null, design: input.design as Record<string, unknown> };
}

async function campaignValues(req: Request, input: z.infer<typeof emailCampaignSchema>, channelId: string) {
  let targetGroupName: string | null = null;
  if (input.targetAudience === "group") {
    const group = await groupsRepository.findById(input.targetGroupId!);
    if (!group || group.createdBy !== req.user!.tenantId) throw notFound("Group");
    targetGroupName = group.name;
  }
  if (input.targetAudience === "segment") targetGroupName = (await loadSegment(requireTenantId(req.user), input.targetSegmentId!)).name;
  return {
    channelId,
    name: input.name,
    subject: input.subject,
    previewText: input.previewText ?? null,
    senderName: input.senderName,
    replyTo: input.replyTo || null,
    ...withDesign(input),
    templateId: input.templateId ?? null,
    targetAudience: input.targetAudience,
    targetGroupId: input.targetAudience === "group" ? input.targetGroupId! : null,
    targetSegmentId: input.targetAudience === "segment" ? input.targetSegmentId! : null,
    targetGroupName,
    csvData: input.targetAudience === "csv" ? input.csvData : [],
    scheduledAt: input.scheduledAt ?? null,
    status: input.scheduledAt ? "scheduled" : "draft",
    trackClicks: input.trackClicks,
    utm: input.utm ?? null,
    delivery: input.delivery ?? null,
    abTest: input.abTest?.enabled ? input.abTest : null,
  };
}

export async function listCampaigns(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const q = parseQuery(paginationQuery.extend({ status: z.string().max(20).optional() }), req);
  const { rows, total } = await emailCampaignsRepository.list(tenantId, q);
  res.json(paginated(rows.map(({ csvData, ...c }) => ({ ...c, csvCount: csvData?.length ?? 0 })), total, q.page, q.limit));
}

export async function getCampaign(req: Request, res: Response) {
  const { csvData, ...c } = await loadCampaign(req);
  res.json({ data: { ...c, csvCount: csvData?.length ?? 0 } });
}

export async function createCampaign(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  await assertWithinPlan(tenantId, "email");
  const input = parseBody(emailCampaignSchema, req);
  const smtp = await resolveSmtp(tenantId).catch(() => null);
  const campaign = await emailCampaignsRepository.create({
    userId: tenantId,
    senderEmail: smtp?.fromEmail ?? null,
    ...(await campaignValues(req, input, req.channel!.id)),
  });
  await activityRepository.record(req, req.user!.id, "email_campaign_created", { type: "email_campaign", id: campaign.id });
  res.status(201).json({ data: campaign });
}

export async function updateCampaign(req: Request, res: Response) {
  const c = await loadCampaign(req);
  if (!["draft", "scheduled"].includes(c.status ?? "")) throw conflict("Only draft or scheduled campaigns can be edited");
  // An edit that doesn't re-upload the CSV keeps the stored list.
  if (req.body?.targetAudience === "csv" && !req.body.csvData?.length && c.csvData?.length) req.body.csvData = c.csvData;
  const input = parseBody(emailCampaignSchema, req);
  const updated = await emailCampaignsRepository.update(c.id, await campaignValues(req, input, c.channelId ?? req.body.channelId));
  res.json({ data: updated });
}

export async function deleteCampaign(req: Request, res: Response) {
  const c = await loadCampaign(req);
  if (["sending", "paused"].includes(c.status ?? "")) throw conflict("Cancel the campaign before deleting it", "CAMPAIGN_ACTIVE");
  await emailCampaignsRepository.delete(c.id);
  await deleteCampaignLinks("email", c.id);
  await activityRepository.record(req, req.user!.id, "email_campaign_deleted", { type: "email_campaign", id: c.id });
  res.json({ success: true });
}

export async function sendCampaign(req: Request, res: Response) {
  const c = await loadCampaign(req);
  const started = await startEmailCampaign(c.id);
  await activityRepository.record(req, req.user!.id, "email_campaign_sent", { type: "email_campaign", id: c.id }, { recipients: started.totalRecipients });
  res.json({ data: started });
}

export async function testCampaign(req: Request, res: Response) {
  const c = await loadCampaign(req);
  const { email } = parseBody(testEmailSchema, req);
  const smtp = await resolveSmtp(c.userId);
  const r = renderEmail(c, { name: req.user!.username, email });
  const result = await sendEmail(smtp, { to: email, subject: `[TEST] ${r.subject}`, html: r.html, text: r.text, senderName: c.senderName, replyTo: c.replyTo, headers: r.headers }, c.userId);
  res.json({ success: true, simulated: result.simulated, via: smtp.source });
}

export async function updateStatus(req: Request, res: Response) {
  const c = await loadCampaign(req);
  const { status } = parseBody(marketingStatusSchema, req);
  res.json({ data: await changeEmailCampaignStatus(c, status) });
}

export async function recipients(req: Request, res: Response) {
  const c = await loadCampaign(req);
  const q = parseQuery(paginationQuery.extend({ status: z.string().max(20).optional() }), req);
  const { rows, total } = await emailCampaignsRepository.listRecipients(c.id, q);
  res.json(paginated(rows, total, q.page, q.limit));
}

/** Size of an audience before saving, for the composer. */
export async function audienceCount(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const q = parse(z.object({ channelId: z.string().uuid(), targetAudience: z.enum(["all_contacts", "group", "segment"]), targetGroupId: z.string().uuid().optional(), targetSegmentId: z.string().uuid().optional() }), req.query);
  await assertChannelAccess(req.user!, q.channelId);
  const rows = await resolveEmailAudience({ userId: tenantId, channelId: q.channelId, targetAudience: q.targetAudience, targetGroupId: q.targetGroupId ?? null, targetSegmentId: q.targetSegmentId ?? null, csvData: [] } as never);
  res.json({ count: rows.length });
}

export async function analytics(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const t = await emailCampaignsRepository.totals(tenantId, new Date(Date.now() - days * 86_400_000));
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  res.json({ data: { days, ...t, openRate: pct(t.opened, t.delivered), failureRate: pct(t.failed, t.recipients) } });
}

export async function outbox(req: Request, res: Response) {
  res.json({ data: simulatedOutbox(requireTenantId(req.user)) });
}

// --- Templates ---------------------------------------------------------------

export async function listTemplates(req: Request, res: Response) {
  res.json({ data: await emailTemplatesRepository.list(requireTenantId(req.user)) });
}

export async function createTemplate(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(emailTemplateSchema, req);
  const t = await emailTemplatesRepository.create({ ...input, ...withDesign(input), userId: tenantId, isSystem: false });
  res.status(201).json({ data: t });
}

async function ownTemplate(req: Request) {
  const t = await emailTemplatesRepository.find(req.params.id);
  if (!t || t.isSystem || t.userId !== requireTenantId(req.user)) throw notFound("Template");
  return t;
}

export async function updateTemplate(req: Request, res: Response) {
  const t = await ownTemplate(req);
  const input = parseBody(emailTemplateSchema, req);
  res.json({ data: await emailTemplatesRepository.update(t.id, { ...input, ...withDesign(input) }) });
}

export async function deleteTemplate(req: Request, res: Response) {
  const t = await ownTemplate(req);
  await emailTemplatesRepository.delete(t.id);
  res.json({ success: true });
}

// --- Public (links inside emails) -------------------------------------------------

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function openPixel(req: Request, res: Response) {
  await recordEmailOpen(req.params.token.replace(/\.gif$/, "")).catch(() => {});
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0", "Content-Length": String(PIXEL.length) });
  res.end(PIXEL);
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f6f8;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}main{background:#fff;border:1px solid #e2e5ea;border-radius:12px;padding:32px;max-width:420px;text-align:center}button{background:#15803d;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;cursor:pointer}p{color:#5f6b7a}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}main{background:#161b22;border-color:#2b333d}p{color:#9aa5b1}}</style></head><body><main>${body}</main></body></html>`;

export async function unsubscribePage(req: Request, res: Response) {
  res.type("html").send(
    page(
      "Unsubscribe",
      `<h1>Unsubscribe</h1><p>Stop receiving marketing emails from this sender?</p><form method="post"><button type="submit">Unsubscribe</button></form>`,
    ),
  );
}

/** Handles both the confirmation form and RFC 8058 one-click POSTs from mail clients. */
export async function unsubscribe(req: Request, res: Response) {
  const result = await unsubscribeEmail(req.params.token);
  if (!result) {
    res.status(404).type("html").send(page("Link expired", "<h1>Link not valid</h1><p>This unsubscribe link is invalid or has expired.</p>"));
    return;
  }
  res.type("html").send(page("Unsubscribed", `<h1>You're unsubscribed</h1><p>We won't send further marketing emails to this address.</p>`));
}

/** GET /api/email-marketing/campaigns/:id/links — clicks per link. */
export async function campaignLinks(req: Request, res: Response) {
  const c = await loadCampaign(req);
  res.json({ data: await linkStats("email", c.id) });
}

const decideBody = z.object({ winner: z.enum(["A", "B"]).optional() });

/** GET …/campaigns/:id/ab — A/B settings, progress and live results. */
export async function abTest(req: Request, res: Response) {
  const c = await loadCampaign(req);
  res.json({ data: await abOverview("email", c.id) });
}

/** POST …/campaigns/:id/ab/decide — pick the winner now (optionally a specific one). */
export async function abDecide(req: Request, res: Response) {
  const c = await loadCampaign(req);
  const { winner } = parseBody(decideBody, req);
  const state = await decideTest("email", c.id, { winner, by: "manual" });
  await activityRepository.record(req, req.user!.id, "ab_test_decided", { type: `${"email"}_campaign`, id: c.id }, { winner: state.winner });
  res.json({ data: state });
}

/** POST /api/email-marketing/images (multipart "image") — returns an absolute URL for emails. */
export async function uploadImage(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  if (!req.file) throw badRequest("Choose an image to upload");
  const url = await saveImage(req.file, `email/${tenantId}`);
  res.status(201).json({ data: { url: `${publicBaseUrl()}${url}` } });
}
