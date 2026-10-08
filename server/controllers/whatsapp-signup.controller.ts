import type { Request, Response } from "express";
import { completeSignupSchema } from "@shared/whatsapp-signup";
import { parseBody } from "../lib/http";
import { notFound } from "../lib/errors";
import { decryptStoredSecret } from "../lib/crypto";
import { requireTenantId } from "../middlewares/tenant";
import { activityRepository } from "../repositories/activity.repository";
import { toPublicChannel } from "../repositories/channels.repository";
import { completeSignup, publicSignupConfig, requestCoexistenceSync } from "../services/whatsapp-signup.service";

/** GET /api/whatsapp-signup/config — what the browser needs to open Meta's popup. */
export async function getConfig(_req: Request, res: Response) {
  res.json({ data: await publicSignupConfig() });
}

/** POST /api/whatsapp-signup/complete — the popup finished: connect the number. */
export async function complete(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(completeSignupSchema, req);
  const r = await completeSignup(tenantId, input);
  await activityRepository.record(req, req.user!.id, r.created ? "channel_created" : "channel_reconnected", { type: "channel", id: r.channel.id }, { method: "embedded_signup", mode: input.mode });
  res.status(r.created ? 201 : 200).json({ data: toPublicChannel(r.channel), warnings: r.warnings, pin: r.pin });
}

/** POST /api/channels/:id/coexistence/sync — ask Meta again for contacts and history (24 hours after connecting). */
export async function sync(req: Request, res: Response) {
  const channel = await requestCoexistenceSync(req.channel!);
  await activityRepository.record(req, req.user!.id, "coexistence_sync_requested", { type: "channel", id: channel.id });
  res.json({ data: toPublicChannel(channel) });
}

/** GET /api/channels/:id/pin — the two-step verification PIN we set when registering the number. */
export async function revealPin(req: Request, res: Response) {
  const channel = req.channel!;
  if (!channel.twoStepPin) throw notFound("PIN");
  await activityRepository.record(req, req.user!.id, "channel_pin_revealed", { type: "channel", id: channel.id });
  res.json({ data: { pin: decryptStoredSecret(channel.twoStepPin) } });
}
