import type { Request, Response } from "express";
import { z } from "zod";
import { smtpConfigSchema } from "@shared/validation";
import type { SmtpConfig } from "@shared/schema";
import { parseBody } from "../lib/http";
import { badRequest, unprocessable } from "../lib/errors";
import { decryptSecret } from "../lib/crypto";
import { smtpRepository } from "../repositories/email.repository";
import { activityRepository } from "../repositories/activity.repository";
import { resolveSmtp, sendEmail, verifySmtpSettings } from "../services/email/mailer";

/** Superadmins manage the platform default (owner = null); tenants manage their own. */
const ownerOf = (req: Request) => (req.user!.role === "superadmin" ? null : req.user!.tenantId);

const publicConfig = (c: SmtpConfig | undefined) =>
  c
    ? { host: c.host, port: c.port, secure: Boolean(c.secure), user: c.user, fromName: c.fromName, fromEmail: c.fromEmail, hasPassword: Boolean(c.password), updatedAt: c.updatedAt }
    : null;

export async function getConfig(req: Request, res: Response) {
  const owner = ownerOf(req);
  const own = await smtpRepository.get(owner);
  let effective: { source: string; fromEmail?: string; fromName?: string; error?: string };
  try {
    const s = await resolveSmtp(owner);
    effective = { source: s.source, fromEmail: s.fromEmail, fromName: s.fromName };
  } catch (err) {
    effective = { source: "none", error: (err as Error).message };
  }
  res.json({ data: publicConfig(own), effective });
}

export async function saveConfig(req: Request, res: Response) {
  const owner = ownerOf(req);
  const input = parseBody(smtpConfigSchema, req);
  const existing = await smtpRepository.get(owner);
  if (!input.password && !existing?.password) throw badRequest("Password is required");
  const saved = await smtpRepository.upsert(owner, input);
  await activityRepository.record(req, req.user!.id, "smtp_config_saved", { type: "smtp_config", id: saved.id }, { host: input.host });
  res.json({ data: publicConfig(saved) });
}

export async function deleteConfig(req: Request, res: Response) {
  await smtpRepository.delete(ownerOf(req));
  res.json({ success: true });
}

/**
 * Verifies a connection with the submitted settings (falling back to the stored password),
 * and optionally sends a test message through the effective configuration.
 */
export async function testConfig(req: Request, res: Response) {
  const owner = ownerOf(req);
  const body = parseBody(smtpConfigSchema.partial().extend({ sendTo: z.string().trim().toLowerCase().email().optional() }), req);
  const stored = await smtpRepository.get(owner);
  if (body.host) {
    const pass = body.password || (stored?.password ? decryptSecret(stored.password) : undefined);
    if (!body.port || !body.user) throw badRequest("Host, port and username are required to test");
    try {
      await verifySmtpSettings({ host: body.host, port: body.port, secure: Boolean(body.secure), user: body.user, pass });
    } catch (err) {
      throw unprocessable(`Connection failed: ${(err as Error).message}`, "SMTP_TEST_FAILED");
    }
  }
  if (body.sendTo) {
    const smtp = await resolveSmtp(owner);
    try {
      const r = await sendEmail(
        smtp,
        {
          to: body.sendTo,
          subject: "SMTP test from WooMarket360",
          html: "<p>Your SMTP settings work. This is a test message from WooMarket360.</p>",
          text: "Your SMTP settings work. This is a test message from WooMarket360.",
        },
        owner,
      );
      return res.json({ success: true, sent: true, simulated: r.simulated, via: smtp.source });
    } catch (err) {
      throw unprocessable(`Sending failed: ${(err as Error).message}`, "SMTP_TEST_FAILED");
    }
  }
  res.json({ success: true, sent: false });
}
