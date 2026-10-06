import type { NextFunction, Request, Response } from "express";
import type { Channel } from "@shared/schema";
import { channelsRepository } from "../repositories/channels.repository";
import { asyncHandler } from "../lib/http";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors";
import type { AuthUser } from "../types";

/** Returns the tenant id a tenant-scoped request acts for; superadmins have none. */
export function requireTenantId(user: AuthUser | undefined): string {
  if (!user) throw unauthorized();
  if (!user.tenantId) throw forbidden("This action is only available inside a tenant account");
  return user.tenantId;
}

/** Loads the channel and verifies it belongs to the caller's tenant (404 otherwise). */
export async function assertChannelAccess(user: AuthUser, channelId: string | null | undefined): Promise<Channel> {
  if (!channelId) throw notFound("Channel");
  const channel = await channelsRepository.findById(channelId);
  if (!channel) throw notFound("Channel");
  if (user.role === "superadmin") return channel;
  if (!user.tenantId || channel.createdBy !== user.tenantId) throw notFound("Channel");
  return channel;
}

function channelIdFrom(req: Request): string | undefined {
  const fromQuery = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
  const fromBody = req.body && typeof req.body.channelId === "string" ? req.body.channelId : undefined;
  return req.params.channelId ?? fromQuery ?? fromBody ?? req.get("x-channel-id") ?? undefined;
}

/**
 * Channel-scoped routes: the channel in the URL / query / body / X-Channel-Id header
 * must belong to the caller's tenant. Sets `req.channel`.
 * @param paramName route param holding the channel id (e.g. "id" for /api/channels/:id)
 */
export function requireChannelAccess(paramName?: string) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    const channelId = paramName ? req.params[paramName] : channelIdFrom(req);
    if (!channelId) throw badRequest("channelId is required");
    req.channel = await assertChannelAccess(req.user, channelId);
    next();
  });
}
