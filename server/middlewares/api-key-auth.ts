import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { API_HEADERS, SIGNATURE_WINDOW_SECONDS, stringToSign } from "@shared/public-api";
import type { ApiKey, User } from "@shared/schema";
import { AppError } from "../lib/errors";
import { decryptApiSecret, timingSafeEqualStr } from "../lib/crypto";
import { apiKeysRepository } from "../repositories/api-keys.repository";
import { usersRepository } from "../repositories/users.repository";

declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKey;
      apiTenant?: User;
    }
  }
}

const denied = (message: string, code = "INVALID_CREDENTIALS") => new AppError(401, message, code);
export const sha256Hex = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/** Credentials from either `Authorization: Basic` or the signed-request headers. */
function readCredentials(req: Request): { mode: "basic"; keyId: string; secret: string } | { mode: "signed"; keyId: string; timestamp: string; signature: string } | null {
  const auth = req.get("authorization") ?? "";
  if (/^basic\s+/i.test(auth)) {
    const decoded = Buffer.from(auth.replace(/^basic\s+/i, ""), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i <= 0) return null;
    return { mode: "basic", keyId: decoded.slice(0, i), secret: decoded.slice(i + 1) };
  }
  const keyId = req.get(API_HEADERS.keyId);
  const timestamp = req.get(API_HEADERS.timestamp);
  const signature = req.get(API_HEADERS.signature);
  if (keyId && timestamp && signature) return { mode: "signed", keyId, timestamp, signature: signature.toLowerCase() };
  return null;
}

/**
 * Authenticates /api/v1 requests with an Access Key ID and Secret Access Key:
 * - Basic: `Authorization: Basic base64(ACCESS_KEY_ID:SECRET_ACCESS_KEY)` over HTTPS, or
 * - Signed: X-WM-Access-Key-Id, X-WM-Timestamp and X-WM-Signature = hex HMAC-SHA256(secret, stringToSign).
 * Unknown keys, wrong secrets and bad signatures all get the same 401.
 */
export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const cred = readCredentials(req);
    if (!cred) throw denied("Missing credentials. Send your Access Key ID and Secret Access Key (Basic auth) or a signed request.", "MISSING_CREDENTIALS");
    const key = /^AKWM[A-Z0-9]{16}$/.test(cred.keyId) ? await apiKeysRepository.findByAccessKeyId(cred.keyId) : undefined;
    if (!key) throw denied("Invalid Access Key ID or secret.");

    if (cred.mode === "basic") {
      if (!timingSafeEqualStr(sha256Hex(cred.secret), key.secretHash)) throw denied("Invalid Access Key ID or secret.");
    } else {
      const ts = Number(cred.timestamp);
      if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_WINDOW_SECONDS) {
        throw denied(`X-WM-Timestamp must be the current unix time in seconds (±${SIGNATURE_WINDOW_SECONDS}s).`, "TIMESTAMP_OUT_OF_RANGE");
      }
      const body = req.rawBody ?? Buffer.alloc(0);
      const expected = crypto.createHmac("sha256", decryptApiSecret(key.secretEncrypted)).update(stringToSign(cred.timestamp, req.method, req.originalUrl, sha256Hex(body))).digest("hex");
      if (!timingSafeEqualStr(expected, cred.signature)) throw denied("Signature does not match. Check the string to sign and your secret.", "INVALID_SIGNATURE");
      if (!(await apiKeysRepository.claimSignature(cred.signature, new Date((ts + SIGNATURE_WINDOW_SECONDS) * 1000)))) {
        throw denied("This signed request was already used. Sign every request afresh.", "REPLAYED_REQUEST");
      }
    }

    if (key.status !== "active") throw denied("This access key has been revoked.", "KEY_REVOKED");
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) throw denied("This access key has expired.", "KEY_EXPIRED");
    const tenant = await usersRepository.findById(key.userId);
    if (!tenant || tenant.status !== "active") throw new AppError(403, "The account that owns this key is not active.", "ACCOUNT_INACTIVE");

    req.apiKey = key;
    req.apiTenant = tenant;
    void apiKeysRepository.touch(key.id, req.ip ?? null).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}
