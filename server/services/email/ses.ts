/**
 * Amazon SES (API v2): sending, account/identity checks and error classification.
 * Messages are composed as raw MIME (same headers as SMTP sends, incl. List-Unsubscribe).
 */
import crypto from "node:crypto";
import {
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import MailComposer from "nodemailer/lib/mail-composer";

export interface SesCredentials {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SesMessage {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** SES message tags (letters, digits, _ and - only), returned in event notifications. */
  tags?: Record<string, string>;
  configurationSet?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces sends so one account never exceeds its SES maximum send rate (per process). */
class RateLimiter {
  private next = 0;
  constructor(public perSecond: number) {}
  async wait() {
    const interval = 1000 / Math.max(this.perSecond, 0.1);
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + interval;
    if (at > now) await sleep(at - now);
  }
}

interface Entry {
  client: SESv2Client;
  limiter: RateLimiter;
  rateCheckedAt: number;
}
const clients = new Map<string, Entry>();
const RATE_REFRESH_MS = 10 * 60_000;

function entry(c: SesCredentials): Entry {
  const key = `${c.region}:${c.accessKeyId}:${crypto.createHash("sha256").update(c.secretAccessKey).digest("hex").slice(0, 16)}`;
  let e = clients.get(key);
  if (!e) {
    for (const [k, old] of clients) if (k.startsWith(`${c.region}:${c.accessKeyId}:`)) (old.client.destroy(), clients.delete(k));
    e = {
      client: new SESv2Client({ region: c.region, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, maxAttempts: 3 }),
      limiter: new RateLimiter(1), // the sandbox rate until the account's real rate is known
      rateCheckedAt: 0,
    };
    clients.set(key, e);
  }
  return e;
}

async function refreshRate(e: Entry) {
  if (Date.now() - e.rateCheckedAt < RATE_REFRESH_MS) return;
  e.rateCheckedAt = Date.now();
  try {
    const a = await e.client.send(new GetAccountCommand({}));
    if (a.SendQuota?.MaxSendRate) e.limiter.perSecond = a.SendQuota.MaxSendRate;
  } catch {
    /* keep the current rate; sending reports real errors */
  }
}

const tagValue = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);

/** Sends one message; returns the SES MessageId. */
export async function sendWithSes(c: SesCredentials, m: SesMessage): Promise<string> {
  const e = entry(c);
  await refreshRate(e);
  const raw = await new MailComposer({ from: m.from, to: m.to, replyTo: m.replyTo, subject: m.subject, html: m.html, text: m.text, headers: m.headers }).compile().build();
  await e.limiter.wait();
  let res;
  try {
    res = await e.client.send(
    new SendEmailCommand({
      Destination: { ToAddresses: [m.to] },
      Content: { Raw: { Data: raw } },
      ConfigurationSetName: m.configurationSet || undefined,
      EmailTags: m.tags ? Object.entries(m.tags).map(([Name, Value]) => ({ Name: tagValue(Name), Value: tagValue(Value) })) : undefined,
    }),
  );
  } catch (err) {
    // Plain-language message; keep the AWS error name and code for classification.
    throw Object.assign(new Error(sesErrorMessage(err)), { name: errName(err), code: (err as { code?: string }).code });
  }
  if (!res.MessageId) throw new Error("SES accepted the message but returned no MessageId");
  return res.MessageId;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface SesCheck {
  region: string;
  sendingEnabled: boolean;
  /** false while the account is in the SES sandbox (only verified recipients). */
  productionAccess: boolean;
  max24HourSend: number;
  maxSendRate: number;
  sentLast24Hours: number;
  enforcementStatus: string | null;
  identity: { name: string; type: "EMAIL_ADDRESS" | "DOMAIN" | string; verified: boolean } | null;
  configurationSet: string | null;
}

const errName = (err: unknown) => (err as { name?: string }).name ?? "";

/** Plain-language message for an SES/AWS error. */
export function sesErrorMessage(err: unknown): string {
  const name = errName(err);
  const msg = (err as Error).message ?? String(err);
  if (["UnrecognizedClientException", "InvalidClientTokenId"].includes(name)) return "AWS doesn't recognise this access key id.";
  if (name === "SignatureDoesNotMatch" || /signature/i.test(msg)) return "The secret access key doesn't match the access key id.";
  if (name === "AccessDeniedException") return `This access key isn't allowed to use SES (${msg}). Attach a policy with ses:SendEmail, ses:SendRawEmail and ses:GetAccount.`;
  if (name === "AccountSuspendedException") return "AWS has suspended sending for this SES account.";
  if (name === "SendingPausedException") return "Sending is paused for this SES account or configuration set.";
  if (["ENOTFOUND", "EAI_AGAIN"].includes((err as { code?: string }).code ?? "")) return "Couldn't reach Amazon SES in this region.";
  return msg;
}

/** Checks credentials and quota, the From identity's verification and the configuration set. */
export async function checkSes(c: SesCredentials, fromEmail: string, configurationSet?: string | null): Promise<SesCheck> {
  const client = new SESv2Client({ region: c.region, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, maxAttempts: 2 });
  try {
    const a = await client.send(new GetAccountCommand({}));
    let identity: SesCheck["identity"] = null;
    const domain = fromEmail.split("@")[1];
    for (const name of [fromEmail, domain]) {
      try {
        const id = await client.send(new GetEmailIdentityCommand({ EmailIdentity: name }));
        identity = { name, type: id.IdentityType ?? "", verified: Boolean(id.VerifiedForSendingStatus) };
        if (identity.verified) break;
      } catch (err) {
        if (errName(err) !== "NotFoundException") throw err;
      }
    }
    if (configurationSet) {
      try {
        await client.send(new GetConfigurationSetCommand({ ConfigurationSetName: configurationSet }));
      } catch (err) {
        if (errName(err) === "NotFoundException") throw new Error(`The configuration set "${configurationSet}" doesn't exist in ${c.region}.`);
        throw err;
      }
    }
    return {
      region: c.region,
      sendingEnabled: Boolean(a.SendingEnabled),
      productionAccess: Boolean(a.ProductionAccessEnabled),
      max24HourSend: a.SendQuota?.Max24HourSend ?? 0,
      maxSendRate: a.SendQuota?.MaxSendRate ?? 0,
      sentLast24Hours: a.SendQuota?.SentLast24Hours ?? 0,
      enforcementStatus: a.EnforcementStatus ?? null,
      identity,
      configurationSet: configurationSet || null,
    };
  } catch (err) {
    throw new Error(sesErrorMessage(err));
  } finally {
    client.destroy();
  }
}

/**
 * How the worker should treat a failed send: stop the campaign (settings problem), retry later,
 * or fail just this recipient.
 */
export function classifySesError(err: unknown, fromEmail: string): "config" | "temporary" | "permanent" {
  const name = errName(err);
  const msg = (err as Error).message ?? "";
  const code = (err as { code?: string }).code ?? "";
  if (["UnrecognizedClientException", "InvalidClientTokenId", "SignatureDoesNotMatch", "AccessDeniedException", "AccountSuspendedException", "SendingPausedException", "MailFromDomainNotVerifiedException", "NotFoundException"].includes(name)) return "config";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) return "config";
  if (["TooManyRequestsException", "ThrottlingException", "LimitExceededException", "ServiceUnavailable", "InternalFailure", "ETIMEDOUT", "ECONNRESET"].includes(name) || ["ETIMEDOUT", "ECONNRESET"].includes(code)) return "temporary";
  // "Email address is not verified": the sender is a settings problem; a recipient (sandbox) is not.
  if (name === "MessageRejected" && msg.toLowerCase().includes(fromEmail.toLowerCase())) return "config";
  return "permanent";
}
