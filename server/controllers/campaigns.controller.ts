import type { Request, Response } from "express";
import { z } from "zod";
import { campaignStatusSchema, createCampaignSchema, paginationQuery } from "@shared/validation";
import type { Campaign } from "@shared/schema";
import { paginated, parseBody, parseQuery } from "../lib/http";
import { conflict, notFound } from "../lib/errors";
import { campaignsRepository } from "../repositories/campaigns.repository";
import { activityRepository } from "../repositories/activity.repository";
import { assertChannelAccess } from "../middlewares/tenant";
import { assertWithinPlan } from "../middlewares/subscription";
import { changeCampaignStatus, createCampaign, startCampaign } from "../services/campaign.service";

async function loadCampaign(req: Request): Promise<Campaign> {
  const campaign = await campaignsRepository.findById(req.params.id ?? req.params.campaignId);
  if (!campaign) throw notFound("Campaign");
  await assertChannelAccess(req.user!, campaign.channelId).catch(() => {
    throw notFound("Campaign");
  });
  return campaign;
}

export async function listCampaigns(req: Request, res: Response) {
  const q = parseQuery(paginationQuery.extend({ status: z.string().max(20).optional() }), req);
  const { rows, total } = await campaignsRepository.list(req.channel!.id, q);
  res.json(paginated(rows, total, q.page, q.limit));
}

export async function getCampaign(req: Request, res: Response) {
  res.json({ data: await loadCampaign(req) });
}

export async function create(req: Request, res: Response) {
  const input = parseBody(createCampaignSchema, req);
  if (req.user!.tenantId) await assertWithinPlan(req.user!.tenantId, "campaign");
  const campaign = await createCampaign(req.user!, req.channel!, input);
  await activityRepository.record(req, req.user!.id, "campaign_created", { type: "campaign", id: campaign.id });
  res.status(201).json({ data: campaign });
}

export async function start(req: Request, res: Response) {
  const campaign = await loadCampaign(req);
  const started = await startCampaign(campaign.id);
  await activityRepository.record(req, req.user!.id, "campaign_started", { type: "campaign", id: campaign.id }, { recipients: started.recipientCount });
  res.json({ data: started });
}

export async function updateStatus(req: Request, res: Response) {
  const campaign = await loadCampaign(req);
  const { status } = parseBody(campaignStatusSchema, req);
  const updated = await changeCampaignStatus(campaign, status);
  await activityRepository.record(req, req.user!.id, `campaign_${status}`, { type: "campaign", id: campaign.id });
  res.json({ data: updated });
}

export async function remove(req: Request, res: Response) {
  const campaign = await loadCampaign(req);
  if (["running", "paused"].includes(campaign.status ?? "")) {
    throw conflict("Cancel the campaign before deleting it", "CAMPAIGN_ACTIVE");
  }
  await campaignsRepository.delete(campaign.id);
  await activityRepository.record(req, req.user!.id, "campaign_deleted", { type: "campaign", id: campaign.id });
  res.json({ success: true });
}

export async function analytics(req: Request, res: Response) {
  const campaign = await loadCampaign(req);
  const breakdown = await campaignsRepository.recipientStatusBreakdown(campaign.id);
  const total = campaign.recipientCount || 0;
  const rate = (n: number | null) => (total ? Math.round(((n ?? 0) / total) * 1000) / 10 : 0);
  res.json({
    data: {
      campaign,
      breakdown,
      rates: {
        sent: rate(campaign.sentCount),
        delivered: rate(campaign.deliveredCount),
        read: rate(campaign.readCount),
        replied: rate(campaign.repliedCount),
        failed: rate(campaign.failedCount),
      },
    },
  });
}

export async function recipients(req: Request, res: Response) {
  const campaign = await loadCampaign(req);
  const q = parseQuery(paginationQuery.extend({ status: z.string().max(20).optional() }), req);
  const { rows, total } = await campaignsRepository.listRecipients(campaign.id, q);
  res.json(paginated(rows, total, q.page, q.limit));
}
