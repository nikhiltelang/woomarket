import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import type { SmsGateway } from "@shared/schema";
import { config } from "../../config";
import { decryptSecret, timingSafeEqualStr } from "../../lib/crypto";
import { childLogger } from "../../lib/logger";

const log = childLogger("sms");
const TIMEOUT_MS = 15_000;

export class SmsProviderError extends Error {
  constructor(
    message: string,
    /** Permanent errors fail the recipient; others are retried. */
    public readonly permanent: boolean,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export interface SmsSendResult {
  messageId: string;
}

export interface SmsProvider {
  readonly kind: "simulator" | "twilio" | "vonage";
  send(to: string, body: string, opts?: { statusCallbackUrl?: string }): Promise<SmsSendResult>;
}

/** Delivery receipts flow into this sink (registered by the marketing service). */
type StatusSink = (messageId: string, status: "delivered" | "failed", error?: string) => Promise<void>;
let statusSink: StatusSink | null = null;
export function setSmsStatusSink(fn: StatusSink) {
  statusSink = fn;
}

/** Accepts every send, then reports delivered (or failed for numbers ending in 0000). */
class SimulatorSms implements SmsProvider {
  readonly kind = "simulator" as const;
  async send(to: string) {
    const messageId = `SMSIM${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const fail = to.replace(/\D/g, "").endsWith("0000");
    const t = setTimeout(() => {
      statusSink?.(messageId, fail ? "failed" : "delivered", fail ? "Unreachable destination (simulated)" : undefined).catch((err) =>
        log.warn({ err: (err as Error).message }, "Simulated SMS receipt failed"),
      );
    }, 1200);
    t.unref();
    return { messageId };
  }
}

class TwilioSms implements SmsProvider {
  readonly kind = "twilio" as const;
  constructor(private readonly gw: SmsGateway) {}
  async send(to: string, body: string, opts: { statusCallbackUrl?: string } = {}) {
    const sid = this.gw.accountSid ?? "";
    const token = this.gw.authToken ? decryptSecret(this.gw.authToken) : "";
    const form = new URLSearchParams({ To: to, Body: body, From: this.gw.fromNumber || this.gw.senderId || "" });
    if (opts.statusCallbackUrl) form.set("StatusCallback", opts.statusCallbackUrl);
    let res: Response;
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SmsProviderError(`Could not reach Twilio: ${(err as Error).message}`, false);
    }
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok || !json.sid) {
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw new SmsProviderError(json.message ?? `Twilio error ${res.status}`, permanent, String(json.code ?? res.status));
    }
    return { messageId: json.sid };
  }
}

class VonageSms implements SmsProvider {
  readonly kind = "vonage" as const;
  constructor(private readonly gw: SmsGateway) {}
  async send(to: string, body: string, opts: { statusCallbackUrl?: string } = {}) {
    const unicode = /[^\u0000-\u007f£¥èéùìòÇØøÅåÆæßÉÄÖÑÜ§¿äöñüà€]/.test(body);
    let res: Response;
    try {
      res = await fetch("https://rest.nexmo.com/sms/json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.gw.accountSid,
          api_secret: this.gw.authToken ? decryptSecret(this.gw.authToken) : "",
          from: this.gw.senderId || this.gw.fromNumber?.replace(/\D/g, ""),
          to: to.replace(/\D/g, ""),
          text: body,
          ...(unicode ? { type: "unicode" } : {}),
          ...(opts.statusCallbackUrl ? { callback: opts.statusCallbackUrl } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SmsProviderError(`Could not reach Vonage: ${(err as Error).message}`, false);
    }
    const json = (await res.json().catch(() => ({}))) as { messages?: { status: string; "message-id"?: string; "error-text"?: string }[] };
    const m = json.messages?.[0];
    if (!res.ok || !m || m.status !== "0" || !m["message-id"]) {
      // Status 1 = throttled; everything else is a request/account problem.
      throw new SmsProviderError(m?.["error-text"] ?? `Vonage error ${res.status}`, m?.status !== "1", m?.status);
    }
    return { messageId: m["message-id"] };
  }
}

/** Provider for a tenant's gateway; no gateway (or SMS_SIMULATE) uses the simulator. */
export function getSmsProvider(gw: SmsGateway | undefined): SmsProvider {
  if (config.SMS_SIMULATE || !gw || gw.provider === "simulator" || !gw.isActive) return new SimulatorSms();
  if (gw.provider === "twilio") return new TwilioSms(gw);
  if (gw.provider === "vonage") return new VonageSms(gw);
  throw new SmsProviderError(`Unsupported SMS provider "${gw.provider}"`, true);
}

/** Twilio request validation: HMAC-SHA1 over the URL plus sorted POST params, base64. */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  return timingSafeEqualStr(signature, expected);
}
