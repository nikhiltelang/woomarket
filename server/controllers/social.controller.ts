import type { Request, Response } from "express";
import { connectPageSchema, simulateInboundSchema, updateSocialAccountSchema } from "@shared/social";
import type { SocialAccount } from "@shared/schema";
import { parseBody } from "../lib/http";
import { notFound, unprocessable } from "../lib/errors";
import { encryptStoredSecret } from "../lib/crypto";
import { assertChannelAccess, requireTenantId } from "../middlewares/tenant";
import { activityRepository } from "../repositories/activity.repository";
import { connectPage, fetchPage, publicAccount, simulateInbound, socialAccountsRepository } from "../services/social.service";

async function own(req: Request): Promise<SocialAccount> {
  const a = await socialAccountsRepository.find(req.params.id);
  if (!a || a.userId !== requireTenantId(req.user)) throw notFound("Account");
  return a;
}

export async function list(req: Request, res: Response) {
  res.json({ data: (await socialAccountsRepository.list(requireTenantId(req.user))).map(publicAccount) });
}

/** POST /api/social-accounts { channelId, pageId, accessToken, messenger, instagram, humanAgentTag } */
export async function connect(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(connectPageSchema, req);
  await assertChannelAccess(req.user!, input.channelId);
  const saved = await connectPage(tenantId, input);
  await activityRepository.record(req, req.user!.id, "social_connected", { type: "social_account" }, { pageId: input.pageId, platforms: saved.map((a) => a.platform) });
  res.status(201).json({ data: saved.map(publicAccount) });
}

export async function update(req: Request, res: Response) {
  const a = await own(req);
  const input = parseBody(updateSocialAccountSchema, req);
  if (input.channelId) await assertChannelAccess(req.user!, input.channelId);
  const patch: Partial<SocialAccount> = {};
  if (input.channelId) patch.channelId = input.channelId;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.humanAgentTag !== undefined) patch.humanAgentTag = input.humanAgentTag;
  if (input.accessToken) {
    // A new token (they expire or get revoked): check it before saving.
    try {
      await fetchPage(a.pageId, input.accessToken);
    } catch (err) {
      throw unprocessable(`Meta didn't accept the token: ${(err as Error).message}`, "META_REJECTED");
    }
    Object.assign(patch, { accessToken: encryptStoredSecret(input.accessToken), status: "connected", lastError: null, simulated: input.accessToken === "simulator" });
  }
  res.json({ data: publicAccount((await socialAccountsRepository.update(a.id, patch))!) });
}

export async function remove(req: Request, res: Response) {
  const a = await own(req);
  await socialAccountsRepository.delete(a.id);
  await activityRepository.record(req, req.user!.id, "social_disconnected", { type: "social_account", id: a.id });
  res.json({ success: true });
}

/** POST /api/social-accounts/:id/simulate { text, senderId? } — test connections only. */
export async function simulate(req: Request, res: Response) {
  const a = await own(req);
  if (!a.simulated) throw unprocessable("Only test (simulator) connections can receive simulated messages.", "NOT_SIMULATED");
  const input = parseBody(simulateInboundSchema, req);
  res.json({ data: await simulateInbound(a, input) });
}
