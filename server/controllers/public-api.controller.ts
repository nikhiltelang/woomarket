import crypto from "node:crypto";
import type { Request, Response } from "express";
import { API_HEADERS, apiSendSchema, createApiKeySchema } from "@shared/public-api";
import type { ApiKey } from "@shared/schema";
import { parseBody } from "../lib/http";
import { AppError, conflict, notFound } from "../lib/errors";
import { encryptApiSecret } from "../lib/crypto";
import { activityRepository } from "../repositories/activity.repository";
import { apiKeysRepository } from "../repositories/api-keys.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { requireTenantId } from "../middlewares/tenant";
import { sha256Hex } from "../middlewares/api-key-auth";
import { tenantLevel } from "../services/levels.service";
import { sendViaApi } from "../services/public-api.service";

// ---------------------------------------------------------------------------
// POST /api/v1/send
// ---------------------------------------------------------------------------

/**
 * Sends email, SMS or WhatsApp to up to 1,000 recipients. Each call becomes a campaign
 * (visible in the app with its delivery stats). With an Idempotency-Key, a retried
 * request returns the first response instead of sending twice.
 */
export async function send(req: Request, res: Response) {
  const key = req.apiKey!;
  const idemKey = req.get(API_HEADERS.idempotency)?.trim();
  let reservation: number | null = null;

  if (idemKey) {
    if (idemKey.length > 255) throw new AppError(400, "Idempotency-Key must be at most 255 characters.", "BAD_IDEMPOTENCY_KEY");
    const requestHash = sha256Hex(req.rawBody ?? JSON.stringify(req.body ?? {}));
    if (!(await apiKeysRepository.saveIdempotent({ apiKeyId: key.id, idempotencyKey: idemKey, requestHash, statusCode: 0, response: null }))) {
      const prior = await apiKeysRepository.findIdempotent(key.id, idemKey);
      if (prior && prior.requestHash !== requestHash) throw conflict("This Idempotency-Key was already used with a different request body.", "IDEMPOTENCY_KEY_REUSED");
      if (!prior || prior.statusCode === 0) throw conflict("A request with this Idempotency-Key is still being processed.", "REQUEST_IN_PROGRESS");
      res.setHeader("Idempotent-Replayed", "true");
      return res.status(prior.statusCode).json(prior.response);
    }
    reservation = (await apiKeysRepository.findIdempotent(key.id, idemKey))!.id;
  }

  try {
    const input = parseBody(apiSendSchema, req);
    const result = await sendViaApi(key, req.apiTenant!, input);
    const body = { data: result };
    if (reservation !== null) await apiKeysRepository.completeIdempotent(reservation, 202, body);
    await activityRepository.record(req, key.createdBy ?? key.userId, "api_send", { type: `${input.channel}_campaign`, id: result.id }, { key: key.accessKeyId, recipients: result.recipients.accepted });
    res.status(202).json(body);
  } catch (err) {
    // Failed requests can be retried with the same key.
    if (reservation !== null) await apiKeysRepository.releaseIdempotent(reservation).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Key management (tenant admins): /api/api-keys
// ---------------------------------------------------------------------------

const MAX_ACTIVE_KEYS = 20;
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function newAccessKeyId(): string {
  const bytes = crypto.randomBytes(16);
  return `AKWM${Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("")}`;
}

export const publicKey = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  accessKeyId: k.accessKeyId,
  secretLast4: k.secretLast4,
  channels: k.channels,
  defaultChannelId: k.defaultChannelId,
  status: k.status === "active" && k.expiresAt && k.expiresAt.getTime() <= Date.now() ? "expired" : k.status,
  expiresAt: k.expiresAt,
  lastUsedAt: k.lastUsedAt,
  lastUsedIp: k.lastUsedIp,
  requestCount: k.requestCount,
  createdAt: k.createdAt,
  revokedAt: k.revokedAt,
});

export async function listKeys(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const [keys, level] = await Promise.all([apiKeysRepository.listByTenant(tenantId), tenantLevel(tenantId)]);
  res.json({ data: keys.map(publicKey), access: { allowed: !level || Boolean(level.apiAccess), levelName: level?.name ?? null } });
}

export async function createKey(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(createApiKeySchema, req);
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new AppError(400, "Expiry must be in the future", "BAD_REQUEST", { expiresAt: ["Must be in the future"] });
  if (input.defaultChannelId) {
    const ch = await channelsRepository.findById(input.defaultChannelId);
    if (!ch || ch.createdBy !== tenantId) throw notFound("WhatsApp number");
  }
  const active = (await apiKeysRepository.listByTenant(tenantId)).filter((k) => k.status === "active").length;
  if (active >= MAX_ACTIVE_KEYS) throw conflict(`You can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use.`, "TOO_MANY_KEYS");

  const secret = crypto.randomBytes(30).toString("base64url"); // 40 characters
  const key = await apiKeysRepository.create({
    id: crypto.randomUUID(),
    userId: tenantId,
    createdBy: req.user!.id,
    name: input.name,
    accessKeyId: newAccessKeyId(),
    secretHash: sha256Hex(secret),
    secretEncrypted: encryptApiSecret(secret),
    secretLast4: secret.slice(-4),
    channels: [...new Set(input.channels)],
    defaultChannelId: input.defaultChannelId ?? null,
    status: "active",
    expiresAt: input.expiresAt ?? null,
  });
  await activityRepository.record(req, req.user!.id, "api_key_created", { type: "api_key", id: key.id }, { accessKeyId: key.accessKeyId });
  // The secret is returned this once and can't be retrieved later.
  res.status(201).json({ data: publicKey(key), secretAccessKey: secret });
}

async function ownKey(req: Request): Promise<ApiKey> {
  const key = await apiKeysRepository.find(req.params.id);
  if (!key || key.userId !== requireTenantId(req.user)) throw notFound("Access key");
  return key;
}

export async function revokeKey(req: Request, res: Response) {
  const key = await ownKey(req);
  if (key.status !== "revoked") await apiKeysRepository.revoke(key.id);
  await activityRepository.record(req, req.user!.id, "api_key_revoked", { type: "api_key", id: key.id });
  res.json({ data: publicKey((await apiKeysRepository.find(key.id))!) });
}

export async function deleteKey(req: Request, res: Response) {
  const key = await ownKey(req);
  if (key.status === "active") throw conflict("Revoke the key before deleting it.", "KEY_ACTIVE");
  await apiKeysRepository.delete(key.id);
  res.json({ success: true });
}
