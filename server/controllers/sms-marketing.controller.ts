import type { Request, Response } from "express";
import { z } from "zod";
import { marketingStatusSchema, paginationQuery, segmentsSchema, smsCampaignSchema, smsGatewaySchema, testSmsSchema } from "@shared/validation";
import type { SmsCampaign, SmsGateway } from "@shared/schema";
import { calculateSegments } from "@shared/sms";
import { paginated, parse, parseBody, parseQuery } from "../lib/http";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors";
import { maskSecret, decryptSecret } from "../lib/crypto";
import { childLogger } from "../lib/logger";
import { publicBaseUrl } from "../lib/tokens";
import { smsCampaignsRepository, smsGatewayRepository } from "../repositories/sms.repository";
import { groupsRepository } from "../repositories/groups.repository";
import { activityRepository } from "../repositories/activity.repository";
import { assertChannelAccess, requireTenantId } from "../middlewares/tenant";
import { assertWithinPlan } from "../middlewares/subscription";
import { getSmsProvider, SmsProviderError, verifyTwilioSignature } from "../services/sms/providers";
import { changeSmsCampaignStatus, handleSmsStatus, resolveSmsAudience, startSmsCampaign } from "../services/marketing.service";

const log = childLogger("sms-webhook");

async function loadCampaign(req: Request): Promise<SmsCampaign> {
  const c = await smsCampaignsRepository.find(req.params.id);
  if (!c || c.userId !== requireTenantId(req.user)) throw notFound("Campaign");
  return c;
}

async function campaignValues(req: Request, input: z.infer<typeof smsCampaignSchema>, channelId: string) {
  let targetGroupName: string | null = null;
  if (input.targetAudience === "group") {
    const group = await groupsRepository.findById(input.targetGroupId!);
    if (!group || group.createdBy !== req.user!.tenantId) throw notFound("Group");
    targetGroupName = group.name;
  }
  const seg = calculateSegments(input.message);
  return {
    channelId,
    name: input.name,
    message: input.message,
    targetAudience: input.targetAudience,
    targetGroupId: input.targetAudience === "group" ? input.targetGroupId! : null,
    targetGroupName,
    csvData: input.targetAudience === "csv" ? input.csvData : [],
    scheduledAt: input.scheduledAt ?? null,
    status: input.scheduledAt ? "scheduled" : "draft",
    smsSegmentsPerRecipient: seg.segments,
  };
}

const publicGateway = (g: SmsGateway | undefined) =>
  g
    ? {
        id: g.id,
        provider: g.provider,
        accountSid: g.accountSid,
        hasAuthToken: Boolean(g.authToken),
        authTokenPreview: g.authToken ? maskSecret(decryptSecret(g.authToken)) : null,
        fromNumber: g.fromNumber,
        senderId: g.senderId,
        isActive: g.isActive,
        updatedAt: g.updatedAt,
        statusWebhookUrl: g.provider === "simulator" ? null : `${publicBaseUrl()}/webhooks/sms/${g.provider}/${g.id}`,
      }
    : null;

export async function listCampaigns(req: Request, res: Response) {
  const q = parseQuery(paginationQuery.extend({ status: z.string().max(20).optional() }), req);
  const { rows, total } = await smsCampaignsRepository.list(requireTenantId(req.user), q);
  res.json(paginated(rows.map(({ csvData, ...c }) => ({ ...c, csvCount: csvData?.length ?? 0 })), total, q.page, q.limit));
}

export async function getCampaign(req: Request, res: Response) {
  const { csvData, ...c } = await loadCampaign(req);
  res.json({ data: { ...c, csvCount: csvData?.length ?? 0 } });
}

export async function createCampaign(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  await assertWithinPlan(tenantId, "sms");
  const input = parseBody(smsCampaignSchema, req);
  const gateway = await smsGatewayRepository.get(tenantId);
  const campaign = await smsCampaignsRepository.create({
    userId: tenantId,
    gateway: gateway?.provider ?? "simulator",
    senderId: gateway?.senderId ?? "CORTESYS",
    fromNumber: gateway?.fromNumber ?? null,
    ...(await campaignValues(req, input, req.channel!.id)),
  });
  await activityRepository.record(req, req.user!.id, "sms_campaign_created", { type: "sms_campaign", id: campaign.id });
  res.status(201).json({ data: campaign });
}

export async function updateCampaign(req: Request, res: Response) {
  const c = await loadCampaign(req);
  if (!["draft", "scheduled"].includes(c.status ?? "")) throw conflict("Only draft or scheduled campaigns can be edited");
  // An edit that doesn't re-upload the CSV keeps the stored list.
  if (req.body?.targetAudience === "csv" && !req.body.csvData?.length && c.csvData?.length) req.body.csvData = c.csvData;
  const input = parseBody(smsCampaignSchema, req);
  res.json({ data: await smsCampaignsRepository.update(c.id, await campaignValues(req, input, c.channelId ?? req.body.channelId)) });
}

export async function deleteCampaign(req: Request, res: Response) {
  const c = await loadCampaign(req);
  if (["sending", "paused"].includes(c.status ?? "")) throw conflict("Cancel the campaign before deleting it", "CAMPAIGN_ACTIVE");
  await smsCampaignsRepository.delete(c.id);
  await activityRepository.record(req, req.user!.id, "sms_campaign_deleted", { type: "sms_campaign", id: c.id });
  res.json({ success: true });
}

export async function sendCampaign(req: Request, res: Response) {
  const c = await loadCampaign(req);
  const started = await startSmsCampaign(c.id);
  await activityRepository.record(req, req.user!.id, "sms_campaign_sent", { type: "sms_campaign", id: c.id }, { recipients: started.totalRecipients });
  res.json({ data: started });
}

export async function updateStatus(req: Request, res: Response) {
  const c = await loadCampaign(req);
  const { status } = parseBody(marketingStatusSchema, req);
  res.json({ data: await changeSmsCampaignStatus(c, status) });
}

export async function recipients(req: Request, res: Response) {
  const c = await loadCampaign(req);
  const q = parseQuery(paginationQuery.extend({ status: z.string().max(20).optional() }), req);
  const { rows, total } = await smsCampaignsRepository.listRecipients(c.id, q);
  res.json(paginated(rows, total, q.page, q.limit));
}

export async function audienceCount(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const q = parse(z.object({ channelId: z.string().uuid(), targetAudience: z.enum(["all_contacts", "group"]), targetGroupId: z.string().uuid().optional() }), req.query);
  await assertChannelAccess(req.user!, q.channelId);
  const rows = await resolveSmsAudience({ userId: tenantId, channelId: q.channelId, targetAudience: q.targetAudience, targetGroupId: q.targetGroupId ?? null, csvData: [] } as never);
  res.json({ count: rows.length });
}

export async function testSms(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const { to, message } = parseBody(testSmsSchema, req);
  const gateway = await smsGatewayRepository.get(tenantId);
  const provider = getSmsProvider(gateway);
  try {
    const r = await provider.send(to, message);
    res.json({ success: true, provider: provider.kind, messageId: r.messageId, segments: calculateSegments(message).segments });
  } catch (err) {
    if (err instanceof SmsProviderError) throw unprocessable(`The SMS gateway rejected the message: ${err.message}`, "SMS_FAILED");
    throw err;
  }
}

export function calculate(req: Request, res: Response) {
  const { message } = parseBody(segmentsSchema, req);
  res.json(calculateSegments(message));
}

const SMS_TEMPLATES = [
  { id: "flash-sale", category: "promotional", name: "Flash sale", message: "Hi {{first_name}}! Flash sale: 25% off everything until midnight. Shop now: https://example.com/sale Reply STOP to opt out." },
  { id: "appointment", category: "transactional", name: "Appointment reminder", message: "Hi {{first_name}}, a reminder of your appointment tomorrow. Reply C to confirm or R to reschedule." },
  { id: "order-shipped", category: "transactional", name: "Order shipped", message: "Good news {{first_name}} - your order is on its way! Track it here: https://example.com/track" },
  { id: "feedback", category: "engagement", name: "Feedback request", message: "Thanks for choosing us, {{first_name}}! How did we do? Rate us 1-5 by replying to this message." },
  { id: "event", category: "announcement", name: "Event invite", message: "{{first_name}}, you're invited to our customer evening next Friday at 6pm. RSVP: https://example.com/rsvp" },
];

export function templates(_req: Request, res: Response) {
  res.json({ data: SMS_TEMPLATES.map((t) => ({ ...t, ...calculateSegments(t.message) })) });
}

export async function getGateway(req: Request, res: Response) {
  res.json({ data: publicGateway(await smsGatewayRepository.get(requireTenantId(req.user))) });
}

export async function saveGateway(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(smsGatewaySchema, req);
  const existing = await smsGatewayRepository.get(tenantId);
  if (input.provider !== "simulator" && !input.authToken && !(existing?.provider === input.provider && existing.authToken)) {
    throw badRequest(input.provider === "twilio" ? "Auth token is required" : "API secret is required");
  }
  if (input.provider === "twilio" && !input.fromNumber && !input.senderId) throw badRequest("Set a sending number or an alphanumeric sender ID");
  const g = await smsGatewayRepository.upsert(tenantId, {
    provider: input.provider,
    accountSid: input.provider === "simulator" ? null : input.accountSid,
    authToken: input.provider === "simulator" ? undefined : input.authToken,
    fromNumber: input.fromNumber,
    senderId: input.senderId,
  });
  await activityRepository.record(req, req.user!.id, "sms_gateway_saved", { type: "sms_gateway", id: g.id }, { provider: g.provider });
  res.json({ data: publicGateway(g) });
}

export async function analytics(req: Request, res: Response) {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const t = await smsCampaignsRepository.totals(requireTenantId(req.user), new Date(Date.now() - days * 86_400_000));
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  res.json({ data: { days, ...t, deliveryRate: pct(t.delivered, t.sent) } });
}

// --- Delivery receipts (public, provider-authenticated) ----------------------------

async function gatewayFor(req: Request, provider: string): Promise<SmsGateway | null> {
  const g = await smsGatewayRepository.find(req.params.gatewayId);
  return g && g.provider === provider ? g : null;
}

/** Twilio StatusCallback (form-encoded, X-Twilio-Signature). */
export async function twilioStatus(req: Request, res: Response) {
  const g = await gatewayFor(req, "twilio");
  if (!g?.authToken) return res.sendStatus(404);
  const url = `${publicBaseUrl()}${req.originalUrl}`;
  if (!verifyTwilioSignature(decryptSecret(g.authToken), url, req.body ?? {}, req.get("x-twilio-signature"))) {
    log.warn({ gatewayId: g.id }, "Twilio signature invalid");
    return res.sendStatus(403);
  }
  const { MessageSid, MessageStatus, ErrorCode } = req.body as Record<string, string>;
  if (MessageSid && MessageStatus === "delivered") await handleSmsStatus(MessageSid, "delivered");
  else if (MessageSid && ["failed", "undelivered"].includes(MessageStatus)) await handleSmsStatus(MessageSid, "failed", `Twilio ${MessageStatus}${ErrorCode ? ` (error ${ErrorCode})` : ""}`);
  res.sendStatus(204);
}

/** Vonage delivery receipt (GET or POST). Only receipts for this gateway's own messages are applied. */
export async function vonageStatus(req: Request, res: Response) {
  const g = await gatewayFor(req, "vonage");
  if (!g) return res.sendStatus(404);
  const p = { ...(req.query as Record<string, string>), ...((req.body ?? {}) as Record<string, string>) };
  const messageId = p.messageId;
  if (!messageId || (p["api-key"] && p["api-key"] !== g.accountSid)) return res.sendStatus(204);
  const recipient = await smsCampaignsRepository.findRecipientByMessageId(messageId);
  const campaign = recipient ? await smsCampaignsRepository.find(recipient.campaignId) : undefined;
  if (!campaign || campaign.userId !== g.userId) return res.sendStatus(204);
  if (p.status === "delivered") await handleSmsStatus(messageId, "delivered");
  else if (["failed", "rejected", "expired"].includes(p.status)) await handleSmsStatus(messageId, "failed", `Vonage ${p.status}${p["err-code"] ? ` (error ${p["err-code"]})` : ""}`);
  res.sendStatus(204);
}
