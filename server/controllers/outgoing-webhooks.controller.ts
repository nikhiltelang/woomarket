import type { Request, Response } from "express";
import { z } from "zod";
import { isWebhookEvent, restHookSchema, WEBHOOK_EVENT_NAMES, WEBHOOK_EVENTS, WEBHOOK_SAMPLES, webhookEndpointSchema, type WebhookEvent } from "@shared/webhooks";
import type { WebhookEndpoint } from "@shared/schema";
import { parseBody, parseQuery } from "../lib/http";
import { conflict, notFound, unprocessable } from "../lib/errors";
import { decryptStoredSecret, encryptStoredSecret } from "../lib/crypto";
import { requireTenantId } from "../middlewares/tenant";
import { activityRepository } from "../repositories/activity.repository";
import { assertSafeUrl, generateWebhookSecret, redeliver, sendTest, webhooksRepository } from "../services/webhooks.service";

const MAX_ENDPOINTS = 20;

/** Endpoint as shown to the tenant: never includes the secret. */
function view(e: WebhookEndpoint, stats?: { succeeded: number; failed: number; pending: number }) {
  const { secret: _secret, ...rest } = e;
  return { ...rest, stats: stats ?? { succeeded: 0, failed: 0, pending: 0 } };
}

async function own(req: Request, id: string): Promise<WebhookEndpoint> {
  const e = await webhooksRepository.findEndpoint(id);
  if (!e || e.userId !== requireTenantId(req.user)) throw notFound("Webhook");
  return e;
}

async function assertRoom(tenantId: string) {
  if ((await webhooksRepository.listEndpoints(tenantId)).length >= MAX_ENDPOINTS) throw conflict(`You can have up to ${MAX_ENDPOINTS} webhooks. Delete one you no longer use.`, "LIMIT_REACHED");
}

// --- Dashboard ---------------------------------------------------------------------------

export async function list(req: Request, res: Response) {
  const rows = await webhooksRepository.listEndpoints(requireTenantId(req.user));
  const stats = await webhooksRepository.stats(rows.map((r) => r.id));
  res.json({ data: rows.map((r) => view(r, stats.get(r.id))), events: WEBHOOK_EVENTS });
}

export async function create(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(webhookEndpointSchema, req);
  await assertSafeUrl(input.url);
  await assertRoom(tenantId);
  const { endpoint, secret } = await webhooksRepository.createEndpoint({ userId: tenantId, url: input.url, description: input.description ?? null, events: input.events, enabled: input.enabled, source: "dashboard", createdBy: req.user!.id });
  await activityRepository.record(req, req.user!.id, "webhook_created", { type: "webhook", id: endpoint.id });
  res.status(201).json({ data: view(endpoint), secret });
}

export async function update(req: Request, res: Response) {
  const e = await own(req, req.params.id);
  const input = parseBody(webhookEndpointSchema.partial(), req);
  if (input.url && input.url !== e.url) await assertSafeUrl(input.url);
  const reenable = input.enabled === true && !e.enabled;
  const updated = await webhooksRepository.updateEndpoint(e.id, {
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.description !== undefined ? { description: input.description ?? null } : {}),
    ...(input.events !== undefined ? { events: input.events } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(reenable ? { consecutiveFailures: 0, disabledReason: null } : {}),
  });
  res.json({ data: view(updated!) });
}

export async function remove(req: Request, res: Response) {
  const e = await own(req, req.params.id);
  await webhooksRepository.deleteEndpoint(e.id);
  await activityRepository.record(req, req.user!.id, "webhook_deleted", { type: "webhook", id: e.id });
  res.json({ success: true });
}

/** The signing secret, for copying into the receiving app. */
export async function revealSecret(req: Request, res: Response) {
  const e = await own(req, req.params.id);
  res.json({ secret: decryptStoredSecret(e.secret) });
}

export async function rotateSecret(req: Request, res: Response) {
  const e = await own(req, req.params.id);
  const secret = generateWebhookSecret();
  await webhooksRepository.updateEndpoint(e.id, { secret: encryptStoredSecret(secret) });
  await activityRepository.record(req, req.user!.id, "webhook_secret_rotated", { type: "webhook", id: e.id });
  res.json({ secret });
}

export async function test(req: Request, res: Response) {
  const e = await own(req, req.params.id);
  const { event } = parseBody(z.object({ event: z.string().refine(isWebhookEvent, "Unknown event") }), req);
  await assertSafeUrl(e.url);
  const result = await sendTest(e, event as WebhookEvent, WEBHOOK_SAMPLES[event as WebhookEvent]);
  res.json({ data: result });
}

export async function deliveries(req: Request, res: Response) {
  const e = await own(req, req.params.id);
  const q = parseQuery(z.object({ status: z.enum(["pending", "sending", "succeeded", "failed"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req);
  res.json({ data: await webhooksRepository.listDeliveries(e.id, q) });
}

export async function retry(req: Request, res: Response) {
  const d = await webhooksRepository.findDelivery(Number(req.params.deliveryId));
  if (!d) throw notFound("Delivery");
  const e = await own(req, d.endpointId);
  if (!e.enabled) throw conflict("Turn the webhook on before retrying.");
  if (d.status === "pending" || d.status === "sending") throw conflict("This delivery is already queued.");
  if ((d.payload as { test?: boolean }).test) throw unprocessable("Test deliveries can't be retried; send a new test.");
  await redeliver(d);
  res.json({ success: true });
}

// --- Public API: REST hooks for Zapier / Make (/api/v1, access-key auth) ------------------

function sourceOf(req: Request): string {
  const ua = (req.get("user-agent") ?? "").toLowerCase();
  return ua.includes("zapier") ? "zapier" : ua.includes("make") || ua.includes("integromat") ? "make" : "api";
}

/** GET /api/v1/me — lets Zapier/Make test the connection. */
export function me(req: Request, res: Response) {
  const t = req.apiTenant!;
  res.json({ id: t.id, username: t.username, email: t.email, name: [t.firstName, t.lastName].filter(Boolean).join(" ") || t.username, accessKey: req.apiKey!.accessKeyId });
}

/** POST /api/v1/webhooks { url, event | events } */
export async function subscribe(req: Request, res: Response) {
  const tenantId = req.apiTenant!.id;
  const input = parseBody(restHookSchema, req);
  const events = input.events ?? (input.event ? [input.event] : null);
  if (!events?.length) throw unprocessable(`Send "event" (one of ${WEBHOOK_EVENT_NAMES.join(", ")}) or "events".`, "EVENT_REQUIRED");
  for (const ev of events) if (ev !== "*" && !isWebhookEvent(ev)) throw unprocessable(`Unknown event "${ev}".`, "UNKNOWN_EVENT");
  await assertSafeUrl(input.url);
  await assertRoom(tenantId);
  const source = sourceOf(req);
  const { endpoint, secret } = await webhooksRepository.createEndpoint({
    userId: tenantId,
    url: input.url,
    description: input.description ?? `${source === "zapier" ? "Zapier" : source === "make" ? "Make" : "API"} subscription`,
    events,
    enabled: true,
    source,
    apiKeyId: req.apiKey!.id,
  });
  res.status(201).json({ id: endpoint.id, url: endpoint.url, events: endpoint.events, secret, createdAt: endpoint.createdAt });
}

/** DELETE /api/v1/webhooks/:id */
export async function unsubscribe(req: Request, res: Response) {
  const e = await webhooksRepository.findEndpoint(req.params.id);
  if (!e || e.userId !== req.apiTenant!.id) throw notFound("Webhook");
  await webhooksRepository.deleteEndpoint(e.id);
  res.json({ success: true });
}

/** GET /api/v1/webhooks */
export async function listSubscriptions(req: Request, res: Response) {
  const rows = await webhooksRepository.listEndpoints(req.apiTenant!.id);
  res.json({ data: rows.map((e) => ({ id: e.id, url: e.url, events: e.events, enabled: e.enabled, source: e.source, createdAt: e.createdAt })) });
}

/** GET /api/v1/webhooks/samples/:event — an array, as Zapier's "perform list" expects. */
export function sample(req: Request, res: Response) {
  const ev = req.params.event;
  if (!isWebhookEvent(ev)) throw notFound("Event");
  res.json([{ id: "00000000-0000-4000-8000-000000000000", event: ev, createdAt: new Date().toISOString(), data: WEBHOOK_SAMPLES[ev] }]);
}

/** GET /api/v1/webhooks/events */
export function events(_req: Request, res: Response) {
  res.json({ data: WEBHOOK_EVENT_NAMES.map((name) => ({ name, ...WEBHOOK_EVENTS[name] })) });
}
