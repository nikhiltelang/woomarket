/**
 * Redaction for stored request logs: credentials, tokens and verification codes never
 * reach the database, whatever endpoint they were sent to.
 */
export const REDACTED = "[REDACTED]";
export const MAX_BODY_CHARS = 64 * 1024;

// Matched against object keys, header names and query parameters (case-insensitive).
const SENSITIVE_KEY = /pass(word|wd)?$|passphrase|secret|token|api[-_]?key|authorization|^(set-)?cookie$|^otp|private[-_]?key|signature|^pin$|cvv|card[-_]?number|encryption[-_]?key/i;
// On sign-in, verification and OAuth paths, "code" and "state" are one-time secrets too.
const CODE_PATHS = /verify|otp|oauth|google|callback|reset|login|2fa/i;
const CODE_KEY = /^(code|state)$/i;

export const isSensitiveKey = (key: string, path = "") => SENSITIVE_KEY.test(key) || (CODE_PATHS.test(path) && CODE_KEY.test(key));

/** Deep copy with sensitive values replaced. */
export function redactValue(value: unknown, path = "", depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, path, depth + 1));
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k, path) && v !== null && v !== "" ? REDACTED : redactValue(v, path, depth + 1);
  }
  return out;
}

/**
 * Best-effort redaction of text that can't be parsed (truncated JSON, form bodies):
 * `"password": "…"`, `password=…` and `Bearer …`.
 */
export function redactText(text: string, path = ""): string {
  const key = (k: string) => isSensitiveKey(k, path);
  return text
    .replace(/"([^"\\]{1,100})"\s*:\s*"(?:[^"\\]|\\.)*"/g, (m, k: string) => (key(k) ? `"${k}":"${REDACTED}"` : m))
    .replace(/([?&]|^)([^=&\s]{1,100})=([^&\s]*)/g, (m, sep: string, k: string) => (key(k) ? `${sep}${k}=${REDACTED}` : m))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${REDACTED}`);
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const value = Array.isArray(v) ? v.join(", ") : String(v);
    out[k.toLowerCase()] = isSensitiveKey(k) ? REDACTED : value.slice(0, 2000);
  }
  return out;
}

export function truncate(text: string, totalBytes?: number): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n…[truncated; ${totalBytes ?? text.length} bytes in total]`;
}
