import type { Request, Response } from "express";
import { config } from "../config";
import { childLogger } from "../lib/logger";
import { timingSafeEqualStr } from "../lib/crypto";
import { channelsRepository } from "../repositories/channels.repository";
import { processWebhookPayload, verifySignature } from "../services/webhook-handler";
import { signupSettings } from "../services/whatsapp-signup.service";

const log = childLogger("webhook");

/** GET: Meta subscription verification (hub.challenge echo). */
export function verifyWebhook(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] ?? "");
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && config.WEBHOOK_VERIFY_TOKEN && timingSafeEqualStr(token, config.WEBHOOK_VERIFY_TOKEN)) {
    return res.status(200).type("text/plain").send(String(challenge ?? ""));
  }
  log.warn({ mode }, "Webhook verification failed");
  res.sendStatus(403);
}

/** POST: events. Signature-checked, idempotent (dedup by message id); 5xx makes Meta retry. */
export async function receiveWebhook(req: Request, res: Response) {
  // The app secret saved for Embedded Signup (or WHATSAPP_APP_SECRET) signs Meta's webhooks.
  const secret = (await signupSettings()).appSecret ?? undefined;
  if (!verifySignature(req.rawBody, req.get("x-hub-signature-256"), secret)) {
    log.warn({ ip: req.ip }, "Webhook signature invalid");
    return res.sendStatus(401);
  }
  let onlyChannelId: string | undefined;
  if (req.params.id) {
    const channel = await channelsRepository.findById(req.params.id);
    if (!channel) return res.sendStatus(404);
    onlyChannelId = channel.id;
  }
  try {
    await processWebhookPayload(req.body, onlyChannelId);
    res.sendStatus(200);
  } catch (err) {
    log.error({ err }, "Webhook processing failed");
    res.sendStatus(500);
  }
}

export function globalWebhookUrl(req: Request, res: Response) {
  const base = config.APP_URL ?? `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base.replace(/\/$/, "")}/webhook/global`, verifyTokenConfigured: Boolean(config.WEBHOOK_VERIFY_TOKEN) });
}
