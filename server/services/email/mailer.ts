import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../../config";
import { decryptSecret } from "../../lib/crypto";
import { unprocessable } from "../../lib/errors";
import { childLogger } from "../../lib/logger";
import { smtpRepository } from "../../repositories/email.repository";

const log = childLogger("mailer");

export interface ResolvedSmtp {
  source: "tenant" | "platform" | "env" | "simulator";
  key: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  fromName: string;
  fromEmail: string;
}

export interface OutgoingEmail {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  senderName?: string | null;
  replyTo?: string | null;
  headers?: Record<string, string>;
}

export interface SimulatedEmail extends OutgoingEmail {
  tenantId: string | null;
  from: string;
  messageId: string;
  at: string;
}

/** Last simulated emails, for local inspection (never persisted). */
const outbox: SimulatedEmail[] = [];
export const simulatedOutbox = (tenantId: string | null) => outbox.filter((m) => m.tenantId === tenantId).slice(-20).reverse();

function simulateMode(): "force" | "fallback" | "off" {
  const v = config.EMAIL_SIMULATE;
  if (v === "true" || v === "1") return "force";
  if (v === "false" || v === "0") return "off";
  return config.isProduction ? "off" : "fallback";
}

const simulator = (): ResolvedSmtp => ({
  source: "simulator",
  key: "simulator",
  fromName: config.APP_NAME,
  fromEmail: "no-reply@simulator.local",
});

/** SMTP for a tenant: tenant settings → superadmin default → SMTP_* env → simulator (outside production). */
export async function resolveSmtp(tenantId: string | null): Promise<ResolvedSmtp> {
  if (simulateMode() === "force") return simulator();
  const row = (tenantId ? await smtpRepository.get(tenantId) : undefined) ?? (await smtpRepository.get(null));
  if (row) {
    return {
      source: row.userId ? "tenant" : "platform",
      key: `${row.id}:${row.updatedAt?.getTime()}`,
      host: row.host,
      port: row.port,
      secure: Boolean(row.secure),
      user: row.user,
      pass: row.password ? decryptSecret(row.password) : undefined,
      fromName: row.fromName,
      fromEmail: row.fromEmail,
    };
  }
  const envFrom = config.SMTP_FROM_EMAIL ?? config.SMTP_FROM;
  if (config.SMTP_HOST && envFrom) {
    return {
      source: "env",
      key: "env",
      host: config.SMTP_HOST,
      port: config.SMTP_PORT ?? 587,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
      fromName: config.SMTP_FROM_NAME ?? config.APP_NAME,
      fromEmail: envFrom,
    };
  }
  if (simulateMode() === "fallback") return simulator();
  throw unprocessable("No SMTP server is configured. Add your SMTP settings under Email marketing → Settings.", "SMTP_NOT_CONFIGURED");
}

const transports = new Map<string, Transporter>();

function transportFor(smtp: ResolvedSmtp): Transporter {
  if (smtp.source === "simulator") return nodemailer.createTransport({ jsonTransport: true });
  let t = transports.get(smtp.key);
  if (!t) {
    for (const [k, old] of transports) if (k.split(":")[0] === smtp.key.split(":")[0]) (old.close(), transports.delete(k));
    t = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      pool: true,
      maxConnections: 3,
      rateDelta: 1000,
      rateLimit: 10,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    transports.set(smtp.key, t);
  }
  return t;
}

const formatAddress = (name: string | null | undefined, email: string) => (name ? `"${name.replace(/["\\\r\n]/g, "")}" <${email}>` : email);

export async function sendEmail(smtp: ResolvedSmtp, msg: OutgoingEmail, tenantId: string | null): Promise<{ messageId: string; simulated: boolean }> {
  const from = formatAddress(msg.senderName || smtp.fromName, smtp.fromEmail);
  const info = await transportFor(smtp).sendMail({
    from,
    to: formatAddress(msg.toName, msg.to),
    replyTo: msg.replyTo || undefined,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    headers: msg.headers,
  });
  if (smtp.source === "simulator") {
    outbox.push({ ...msg, tenantId, from, messageId: info.messageId, at: new Date().toISOString() });
    if (outbox.length > 200) outbox.splice(0, outbox.length - 200);
    log.debug({ to: msg.to, subject: msg.subject }, "Simulated email captured");
  }
  return { messageId: info.messageId, simulated: smtp.source === "simulator" };
}

/** Opens a connection and authenticates, without sending anything. */
export async function verifySmtpSettings(s: { host: string; port: number; secure: boolean; user: string; pass?: string }): Promise<void> {
  const t = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: { user: s.user, pass: s.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

export type SmtpErrorKind = "config" | "temporary" | "permanent";

/** Connection/auth problems stop the campaign; 4xx retries; 5xx fails the recipient. */
export function classifySmtpError(err: unknown): SmtpErrorKind {
  const e = err as { code?: string; responseCode?: number };
  if (["EAUTH", "ECONNECTION", "ETIMEDOUT", "EDNS", "ESOCKET", "ECONNREFUSED", "ENOTFOUND", "ETLS"].includes(e.code ?? "")) return "config";
  if (e.responseCode && e.responseCode >= 400 && e.responseCode < 500) return "temporary";
  return "permanent";
}
