import type { Request, Response } from "express";
import { randomInt } from "node:crypto";
import { createChannelSchema, paginationQuery, simulateInboundSchema, updateChannelSchema } from "@shared/validation";
import { paginated, parseBody, parseQuery } from "../lib/http";
import { badRequest, unprocessable } from "../lib/errors";
import { channelsRepository, toPublicChannel } from "../repositories/channels.repository";
import { activityRepository } from "../repositories/activity.repository";
import { requireTenantId } from "../middlewares/tenant";
import { whatsappFactory } from "../services/whatsapp";
import { buildWebhookPayload } from "../services/whatsapp/simulator-client";
import { processWebhookPayload } from "../services/webhook-handler";

export async function listChannels(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const rows = await channelsRepository.listByTenant(tenantId);
  res.json({ data: rows.map(toPublicChannel) });
}

export async function listAllChannels(req: Request, res: Response) {
  const q = parseQuery(paginationQuery, req);
  const { rows, total } = await channelsRepository.listAll(q.page, q.limit);
  res.json(paginated(rows.map(toPublicChannel), total, q.page, q.limit));
}

export async function activeChannel(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const rows = await channelsRepository.listByTenant(tenantId);
  const active = rows.find((c) => c.isActive) ?? null;
  res.json({ data: active ? toPublicChannel(active) : null });
}

export async function createChannel(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(createChannelSchema, req);
  const channel =
    input.connectionMethod === "manual"
      ? await channelsRepository.create({
          name: input.name,
          phoneNumberId: input.phoneNumberId,
          whatsappBusinessAccountId: input.whatsappBusinessAccountId,
          accessToken: input.accessToken,
          phoneNumber: input.phoneNumber ?? null,
          appId: input.appId ?? null,
          connectionMethod: "manual",
          createdBy: tenantId,
        })
      : await channelsRepository.create({
          name: input.name,
          // Simulator channels get a synthetic numeric id that never collides with Meta's.
          phoneNumberId: `9${Date.now()}${randomInt(1000, 9999)}`,
          whatsappBusinessAccountId: `sim${randomInt(100000, 999999)}`,
          accessToken: "simulator",
          phoneNumber: input.phoneNumber ?? "+15550000000",
          connectionMethod: "simulator",
          createdBy: tenantId,
        });

  const health = await whatsappFactory.create(channel).checkHealth();
  await channelsRepository.recordHealth(channel.id, health.status, health.details);
  await activityRepository.record(req, req.user!.id, "channel_created", { type: "channel", id: channel.id }, { method: input.connectionMethod });
  const fresh = (await channelsRepository.findById(channel.id))!;
  res.status(201).json({ data: toPublicChannel(fresh), health });
}

export async function updateChannel(req: Request, res: Response) {
  const input = parseBody(updateChannelSchema, req);
  const channel = req.channel!;
  if (input.accessToken && channel.connectionMethod === "simulator") throw badRequest("Simulator channels have no access token");
  const updated = await channelsRepository.update(channel.id, input);
  await activityRepository.record(req, req.user!.id, "channel_updated", { type: "channel", id: channel.id }, { fields: Object.keys(input) });
  res.json({ data: toPublicChannel(updated!) });
}

export async function deleteChannel(req: Request, res: Response) {
  const channel = req.channel!;
  await channelsRepository.delete(channel.id);
  await activityRepository.record(req, req.user!.id, "channel_deleted", { type: "channel", id: channel.id }, { name: channel.name });
  res.json({ success: true });
}

export async function checkHealth(req: Request, res: Response) {
  const channel = req.channel!;
  const health = await whatsappFactory.create(channel).checkHealth();
  await channelsRepository.recordHealth(channel.id, health.status, health.details);
  const fresh = (await channelsRepository.findById(channel.id))!;
  res.json({ data: toPublicChannel(fresh), health });
}

/** Injects an inbound customer message into a simulator channel (demo / QA). */
export async function simulateInbound(req: Request, res: Response) {
  const channel = req.channel!;
  if (channel.connectionMethod !== "simulator") throw unprocessable("Only simulator channels accept simulated messages");
  const input = parseBody(simulateInboundSchema, req);
  const waId = input.from.replace(/\D/g, "");
  const payload = buildWebhookPayload(channel, {
    contacts: [{ wa_id: waId, profile: { name: input.name ?? input.from } }],
    messages: [
      {
        id: `wamid.SIM.IN.${Date.now()}${randomInt(1000, 9999)}`,
        from: waId,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "text",
        text: { body: input.text },
      },
    ],
  });
  await processWebhookPayload(payload, channel.id);
  res.status(202).json({ success: true });
}
