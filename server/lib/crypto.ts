import crypto from "node:crypto";
import { config, sessionSecret } from "../config";

// AES-256-GCM encryption for secrets at rest (WhatsApp access tokens).
// Enabled when ENCRYPTION_KEY is set; values without the prefix are treated
// as legacy plaintext so existing rows keep working.

const PREFIX = "enc:v1:";

function key(): Buffer | null {
  if (!config.ENCRYPTION_KEY) return null;
  return crypto.createHash("sha256").update(config.ENCRYPTION_KEY).digest();
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const k = key();
  if (!k) throw new Error("ENCRYPTION_KEY is required to decrypt stored secrets");
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export function maskSecret(stored: string): string {
  const plain = stored.startsWith(PREFIX) ? "" : stored;
  return plain.length > 8 ? `••••${plain.slice(-4)}` : "••••";
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// API access-key secrets are always encrypted, even when ENCRYPTION_KEY isn't set: the key then
// comes from the session secret (required in production). Basic authentication only compares
// hashes, so it keeps working if that secret ever changes; signed requests would need a new key.
const API_PREFIX = "enc:api:";

function apiSecretKey(): Buffer {
  return crypto.createHash("sha256").update(`api-access-keys:${config.ENCRYPTION_KEY || sessionSecret()}`).digest();
}

export function encryptApiSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", apiSecretKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return API_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decryptApiSecret(stored: string): string {
  if (!stored.startsWith(API_PREFIX)) return decryptSecret(stored);
  const raw = Buffer.from(stored.slice(API_PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", apiSecretKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
