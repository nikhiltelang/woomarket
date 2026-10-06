import crypto from "node:crypto";
import { config, sessionSecret } from "../config";
import { timingSafeEqualStr } from "./crypto";

// Signed, non-expiring tokens for links embedded in outgoing messages
// (email open pixel, one-click unsubscribe). Format: <id>.<hmac>

const mac = (purpose: string, id: string) =>
  crypto.createHmac("sha256", sessionSecret()).update(`${purpose}:${id}`).digest("base64url").slice(0, 32);

export function signToken(purpose: "open" | "unsubscribe", id: string): string {
  return `${id}.${mac(purpose, id)}`;
}

export function verifyToken(purpose: "open" | "unsubscribe", token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  return timingSafeEqualStr(token.slice(dot + 1), mac(purpose, id)) ? id : null;
}

/** Absolute base URL for links in outgoing messages. */
export function publicBaseUrl(): string {
  return (config.APP_URL ?? `http://localhost:${config.PORT}`).replace(/\/$/, "");
}
