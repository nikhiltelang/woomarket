import express, { type Request, type Response } from "express";
import { z } from "zod";
import { paginationQuery, smtpConfigSchema } from "@shared/validation";
import type { SmtpConfig } from "@shared/schema";
import { parseBody, parseQuery } from "../lib/http";
import { badRequest, notFound, unprocessable } from "../lib/errors";
import { decryptStoredSecret } from "../lib/crypto";
import { publicBaseUrl } from "../lib/tokens";
import { smtpRepository, suppressionsRepository } from "../repositories/email.repository";
import { activityRepository } from "../repositories/activity.repository";
import { resolveSmtp, sendEmail, verifySmtpSettings } from "../services/email/mailer";
import { checkSes } from "../services/email/ses";
import { handleSnsMessage, type SnsMessage } from "../services/email/ses-feedback";

/** Superadmins manage the platform default (owner = null); tenants manage their own. */
const ownerOf = (req: Request) => (req.user!.role === "superadmin" ? null : req.user!.tenantId);

/** Settings as shown in the form: never the password or secret key. */
const publicConfig = (c: SmtpConfig | undefined) => {
  if (!c) return null;
  const common = { provider: c.provider === "ses" ? "ses" : "smtp", fromName: c.fromName, fromEmail: c.fromEmail, hasPassword: Boolean(c.password), updatedAt: c.updatedAt };
  if (c.provider === "ses") {
    return {
      ...common,
      region: c.region,
      accessKeyId: c.user,
      configurationSet: c.configurationSet ?? "",
      // Point an SNS topic (bounces, complaints, deliveries) at this URL.
      feedbackUrl: `${publicBaseUrl()}/webhooks/ses/${c.id}`,
      snsTopicArn: c.snsTopicArn,
    };
  }
  return { ...common, host: c.host, port: c.port, secure: Boolean(c.secure), user: c.user };
};

export async function getConfig(req: Request, res: Response) {
  const owner = ownerOf(req);
  const own = await smtpRepository.get(owner);
  let effective: { source: string; provider?: string; fromEmail?: string; fromName?: string; error?: string };
  try {
    const s = await resolveSmtp(owner);
    effective = { source: s.source, provider: s.provider, fromEmail: s.fromEmail, fromName: s.fromName };
  } catch (err) {
    effective = { source: "none", error: (err as Error).message };
  }
  res.json({ data: publicConfig(own), effective });
}

export async function saveConfig(req: Request, res: Response) {
  const owner = ownerOf(req);
  const input = parseBody(smtpConfigSchema, req);
  const existing = await smtpRepository.get(owner);
  const sameProvider = existing?.provider === input.provider;
  const secret = input.provider === "ses" ? input.secretAccessKey : input.password;
  if (!secret && !(sameProvider && existing?.password)) throw badRequest(input.provider === "ses" ? "Secret access key is required" : "Password is required");
  const saved = await smtpRepository.upsert(owner, input);
  await activityRepository.record(req, req.user!.id, "smtp_config_saved", { type: "smtp_config", id: saved.id }, { provider: input.provider, ...(input.provider === "ses" ? { region: input.region } : { host: input.host }) });
  res.json({ data: publicConfig(saved) });
}

export async function deleteConfig(req: Request, res: Response) {
  await smtpRepository.delete(ownerOf(req));
  res.json({ success: true });
}

/** The stored secret, when the form left it blank and the provider hasn't changed. */
async function storedSecret(owner: string | null, provider: string): Promise<string | undefined> {
  const stored = await smtpRepository.get(owner);
  return stored?.password && stored.provider === provider ? decryptStoredSecret(stored.password) : undefined;
}

/**
 * Checks the submitted settings (SMTP: connect and authenticate; SES: credentials, quota,
 * sandbox, From identity and configuration set) and/or sends a test message through the
 * effective configuration.
 */
export async function testConfig(req: Request, res: Response) {
  const owner = ownerOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { sendTo } = parseBody(z.object({ sendTo: z.string().trim().toLowerCase().email().optional() }).passthrough(), req);
  let ses: Awaited<ReturnType<typeof checkSes>> | undefined;

  if (body.provider === "ses" && body.accessKeyId) {
    const input = smtpConfigSchema.parse(body);
    if (input.provider !== "ses") throw badRequest("Invalid SES settings");
    const secret = input.secretAccessKey || (await storedSecret(owner, "ses"));
    if (!secret) throw badRequest("Secret access key is required to test");
    try {
      ses = await checkSes({ region: input.region, accessKeyId: input.accessKeyId, secretAccessKey: secret }, input.fromEmail, input.configurationSet);
    } catch (err) {
      throw unprocessable(`Amazon SES check failed: ${(err as Error).message}`, "SMTP_TEST_FAILED");
    }
  } else if (body.host) {
    const p = z.object({ host: z.string().trim().min(1), port: z.coerce.number().int(), secure: z.boolean().default(false), user: z.string().trim().min(1), password: z.string().optional() }).parse(body);
    const pass = p.password || (await storedSecret(owner, "smtp"));
    try {
      await verifySmtpSettings({ host: p.host, port: p.port, secure: p.secure, user: p.user, pass });
    } catch (err) {
      throw unprocessable(`Connection failed: ${(err as Error).message}`, "SMTP_TEST_FAILED");
    }
  }

  if (sendTo) {
    const smtp = await resolveSmtp(owner);
    try {
      const r = await sendEmail(
        smtp,
        {
          to: sendTo,
          subject: "Email test from WooMarket360",
          html: `<p>Your email settings work. This is a test message sent through ${smtp.provider === "ses" ? "Amazon SES" : "SMTP"}.</p>`,
          text: `Your email settings work. This is a test message sent through ${smtp.provider === "ses" ? "Amazon SES" : "SMTP"}.`,
        },
        owner,
      );
      return res.json({ success: true, sent: true, simulated: r.simulated, via: smtp.source, provider: smtp.provider, messageId: r.messageId });
    } catch (err) {
      throw unprocessable(`Sending failed: ${(err as Error).message}`, "SMTP_TEST_FAILED");
    }
  }
  res.json({ success: true, sent: false, ses });
}

// ---------------------------------------------------------------------------
// Suppression list (/api/smtp/suppressions)
// ---------------------------------------------------------------------------

export async function listSuppressions(req: Request, res: Response) {
  const q = parseQuery(paginationQuery, req);
  const { rows, total } = await suppressionsRepository.list(ownerOf(req), q);
  res.json({ data: rows, total, page: q.page, limit: q.limit });
}

export async function addSuppression(req: Request, res: Response) {
  const { email } = parseBody(z.object({ email: z.string().trim().toLowerCase().email() }), req);
  const added = await suppressionsRepository.add(ownerOf(req), email, "manual", `Added by ${req.user!.username}`);
  res.status(added ? 201 : 200).json({ success: true, added });
}

export async function removeSuppression(req: Request, res: Response) {
  if (!(await suppressionsRepository.remove(ownerOf(req), Number(req.params.id)))) throw notFound("Suppressed address");
  await activityRepository.record(req, req.user!.id, "email_suppression_removed", { type: "email_suppression", id: req.params.id });
  res.json({ success: true });
}

// ---------------------------------------------------------------------------
// SES feedback (public): POST /webhooks/ses/:configId from Amazon SNS
// ---------------------------------------------------------------------------

/** SNS posts JSON with Content-Type text/plain, so read the body as text. */
export const snsBody = express.text({ type: () => true, limit: "256kb" });

export async function sesFeedback(req: Request, res: Response) {
  let message: SnsMessage;
  try {
    message = JSON.parse(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
  } catch {
    return res.status(400).json({ success: false, message: "Body must be an SNS message" });
  }
  if (!message?.Type || !message.Signature) return res.status(400).json({ success: false, message: "Body must be an SNS message" });
  const { status, result } = await handleSnsMessage(req.params.configId, message);
  res.status(status).json({ success: status < 400, result });
}
