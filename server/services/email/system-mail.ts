import { systemConfig } from "../system-config.service";
import { usersRepository } from "../../repositories/users.repository";
import { agencyOf, brandsRepository } from "../white-label.service";
import { resolveSmtp, sendEmail, type EmailAttachment } from "./mailer";
import { escapeHtml, htmlToText } from "./render";

const DEFAULT_TEMPLATE = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:8px;padding:28px;font-size:15px;line-height:1.6">
<p style="margin:0 0 16px;font-weight:bold;font-size:18px">{{site_name}}</p>
{{message}}
</div></body></html>`;

/** Turns plain text into simple paragraphs (escaped). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export interface SystemEmailOptions {
  attachments?: EmailAttachment[];
  /** The account the email is about: an agency's clients get it in the agency's name. */
  forUserId?: string | null;
}

/** White-label brand for the user's agency, if any (failures fall back to the platform name). */
async function brandFor(userId: string | null | undefined): Promise<{ name: string; replyTo: string | null } | null> {
  if (!userId) return null;
  try {
    const user = await usersRepository.findById(userId);
    const agency = user ? await agencyOf(user) : null;
    const brand = agency ? await brandsRepository.byOwner(agency) : undefined;
    return brand ? { name: brand.name, replyTo: brand.supportEmail } : null;
  } catch {
    return null;
  }
}

/**
 * Sends a platform email (verification codes, notifications, reports) through the platform
 * SMTP, wrapped in the superadmin's global email template.
 */
export async function sendSystemEmail(to: string, subject: string, bodyHtml: string, opts: SystemEmailOptions = {}): Promise<{ simulated: boolean }> {
  const [s, panel, smtp, brand] = await Promise.all([systemConfig.get(), systemConfig.panel(), resolveSmtp(null), brandFor(opts.forUserId)]);
  const site = brand?.name ?? (s.siteTitle || panel.name);
  const template = s.globalEmailTemplate?.trim() ? s.globalEmailTemplate : DEFAULT_TEMPLATE;
  const html = template.replace(/\{\{\s*site_name\s*\}\}/g, escapeHtml(site)).replace(/\{\{\s*message\s*\}\}/g, bodyHtml);
  const r = await sendEmail(smtp, { to, subject, html, text: htmlToText(bodyHtml), senderName: site, replyTo: brand?.replyTo ?? null, attachments: opts.attachments }, null);
  return { simulated: r.simulated };
}
