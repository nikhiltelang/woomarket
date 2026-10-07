import { systemConfig } from "../system-config.service";
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

/**
 * Sends a platform email (verification codes, notifications) through the platform SMTP,
 * wrapped in the superadmin's global email template.
 */
export async function sendSystemEmail(to: string, subject: string, bodyHtml: string, attachments?: EmailAttachment[]): Promise<{ simulated: boolean }> {
  const [s, panel, smtp] = await Promise.all([systemConfig.get(), systemConfig.panel(), resolveSmtp(null)]);
  const site = s.siteTitle || panel.name;
  const template = s.globalEmailTemplate?.trim() ? s.globalEmailTemplate : DEFAULT_TEMPLATE;
  const html = template.replace(/\{\{\s*site_name\s*\}\}/g, escapeHtml(site)).replace(/\{\{\s*message\s*\}\}/g, bodyHtml);
  const r = await sendEmail(smtp, { to, subject, html, text: htmlToText(bodyHtml), senderName: site, attachments }, null);
  return { simulated: r.simulated };
}
