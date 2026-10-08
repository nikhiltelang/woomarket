/**
 * Report exports: one CSV per section, or a single PDF with every section.
 */
import fs from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";
import { formatDuration, pct, SECTION_LABELS, type FullReport, type ReportSection, type ResponseStats } from "@shared/reports";

/** Quoted CSV cell; neutralises spreadsheet formulas (=, +, -, @) in text. */
export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const isNumber = /^[+-]?[\d\s().-]+$/.test(s);
  const safe = !isNumber && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const secs = (v: number | null) => (v == null ? "" : v);

export function reportCsv(r: FullReport, section: ReportSection): string {
  if (section === "overview" && r.overview) {
    const o = r.overview;
    return csv([
      ["date", "whatsapp_sent", "whatsapp_received", "email_sent", "sms_sent"],
      ...o.daily.map((d) => [d.day, d.whatsappSent, d.whatsappReceived, d.emailSent, d.smsSent]),
      [],
      ["metric", "value"],
      ["whatsapp_conversation_messages_sent", o.whatsapp.conversationsSent],
      ["whatsapp_received", o.whatsapp.received],
      ["whatsapp_delivered", o.whatsapp.delivered],
      ["whatsapp_read", o.whatsapp.read],
      ["whatsapp_failed", o.whatsapp.failed],
      ["whatsapp_campaign_sent", o.whatsapp.campaignSent],
      ["whatsapp_campaign_delivered", o.whatsapp.campaignDelivered],
      ["whatsapp_campaign_read", o.whatsapp.campaignRead],
      ["whatsapp_campaign_replied", o.whatsapp.campaignReplied],
      ["whatsapp_campaign_failed", o.whatsapp.campaignFailed],
      ...Object.entries(o.email).map(([k, v]) => [`email_${k}`, v]),
      ...Object.entries(o.sms).map(([k, v]) => [`sms_${k}`, v]),
    ]);
  }
  if (section === "team" && r.team) {
    return csv([
      ["name", "role", "messages_sent", "conversations", "open_assigned", "resolved", "replies", "avg_response_seconds", "median_response_seconds", "p90_response_seconds"],
      ...r.team.map((t) => [t.name, t.role, t.messagesSent, t.conversations, t.openAssigned, t.resolved, t.count, secs(t.avg), secs(t.median), secs(t.p90)]),
    ]);
  }
  if (section === "response-times" && r.responseTimes) {
    const t = r.responseTimes;
    return csv([
      ["measure", "count", "avg_seconds", "median_seconds", "p90_seconds"],
      ["first_response", t.first.count, secs(t.first.avg), secs(t.first.median), secs(t.first.p90)],
      ["all_replies", t.all.count, secs(t.all.avg), secs(t.all.median), secs(t.all.p90)],
      ["awaiting_reply", t.awaiting, "", "", ""],
      [],
      ["band", "replies"],
      ...t.buckets.map((b) => [b.label, b.count]),
      [],
      ["date", "replies", "median_seconds"],
      ...t.daily.map((d) => [d.day, d.count, secs(d.median)]),
    ]);
  }
  return csv([["no data"]]);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";

// Noto Sans (SIL OFL, assets/fonts) covers Latin, Greek, Cyrillic, Devanagari and "₹". Without the
// files we fall back to the PDF standard fonts, which only know Western European characters.
const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");
export const NOTO = { regular: path.join(FONT_DIR, "NotoSans-Regular.ttf"), bold: path.join(FONT_DIR, "NotoSans-Bold.ttf") };
type CoverageFont = { hasGlyphForCodePoint(cp: number): boolean };
let coverage: CoverageFont | null | undefined;
export function unicodeFont(): CoverageFont | null {
  if (coverage === undefined) {
    try {
      coverage = fs.existsSync(NOTO.regular) && fs.existsSync(NOTO.bold) ? (fontkit.openSync(NOTO.regular) as unknown as CoverageFont) : null;
    } catch {
      coverage = null;
    }
  }
  return coverage;
}

/** Replaces characters the PDF font can't draw (they'd show as empty boxes) with "?". */
export function pdfText(s: string): string {
  const font = unicodeFont();
  if (!font) return s.replace(/[^\n\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, "?");
  // Zero-width joiners steer Devanagari shaping and need no glyph of their own.
  return Array.from(s, (ch) => {
    const cp = ch.codePointAt(0)!;
    // Line breaks are layout, not glyphs.
    return cp === 0x0a || cp === 0x200c || cp === 0x200d || font.hasGlyphForCodePoint(cp) ? ch : "?";
  }).join("");
}

export async function reportPdf(r: FullReport, meta: { title: string; tenantName: string; channelName?: string | null; brandColor?: string }): Promise<Buffer> {
  const brand = /^#[0-9a-f]{6}$/i.test(meta.brandColor ?? "") ? meta.brandColor! : "#16a34a";
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: meta.title, Author: meta.tenantName } });
  const unicode = Boolean(unicodeFont());
  if (unicode) {
    doc.registerFont("Body", NOTO.regular);
    doc.registerFont("Body-Bold", NOTO.bold);
  }
  const F = unicode ? { regular: "Body", bold: "Body-Bold" } : { regular: "Helvetica", bold: "Helvetica-Bold" };
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const width = doc.page.width - 96;

  const ensure = (h: number) => {
    if (doc.y + h > doc.page.height - 60) doc.addPage();
  };
  const heading = (t: string) => {
    ensure(60);
    doc.moveDown(0.8).font(F.bold).fontSize(13).fillColor(INK).text(pdfText(t));
    doc.moveTo(48, doc.y + 3).lineTo(48 + width, doc.y + 3).strokeColor(brand).lineWidth(1.5).stroke();
    doc.moveDown(0.6);
  };
  const table = (head: string[], rows: (string | number)[][], widths: number[]) => {
    const x0 = 48;
    const rowH = 18;
    const draw = (cells: (string | number)[], bold: boolean) => {
      ensure(rowH + 4);
      const y = doc.y;
      let x = x0;
      doc.font(bold ? F.bold : F.regular).fontSize(9).fillColor(bold ? MUTED : INK);
      cells.forEach((c, i) => {
        doc.text(pdfText(String(c)), x + 2, y + 4, { width: widths[i] - 4, align: i === 0 ? "left" : "right", lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.moveTo(x0, y + rowH).lineTo(x0 + width, y + rowH).strokeColor(RULE).lineWidth(0.5).stroke();
      doc.x = x0;
      doc.y = y + rowH;
    };
    draw(head, true);
    for (const r of rows) draw(r, false);
    doc.moveDown(0.5);
  };
  const kv = (rows: [string, string | number][]) => table(["Metric", "Value"], rows, [width - 140, 140]);
  const stat = (label: string, s: ResponseStats): (string | number)[] => [label, s.count, formatDuration(s.avg), formatDuration(s.median), formatDuration(s.p90)];

  // Cover
  doc.rect(0, 0, doc.page.width, 6).fill(brand);
  doc.font(F.bold).fontSize(20).fillColor(INK).text(pdfText(meta.title), 48, 40);
  doc.font(F.regular).fontSize(10).fillColor(MUTED).text(pdfText(`${meta.tenantName}${meta.channelName ? ` · ${meta.channelName}` : ""}`));
  doc.text(`${r.query.from} to ${r.query.to} (${r.timezone}) · generated ${new Date(r.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);

  if (r.overview) {
    const o = r.overview;
    heading(SECTION_LABELS.overview);
    // Daily volume: one bar per day for all messages sent, with a light baseline grid.
    const days = o.daily;
    const totals = days.map((d) => d.whatsappSent + d.emailSent + d.smsSent);
    const max = Math.max(1, ...totals);
    const chartH = 90;
    ensure(chartH + 40);
    const top = doc.y;
    doc.font(F.regular).fontSize(8).fillColor(MUTED).text(`Messages sent per day (all channels) · peak ${max}`, 48, top);
    const baseY = top + 14 + chartH;
    doc.moveTo(48, baseY).lineTo(48 + width, baseY).strokeColor(RULE).lineWidth(0.5).stroke();
    const slot = width / Math.max(1, days.length);
    const barW = Math.max(1, Math.min(18, slot - 2));
    totals.forEach((t, i) => {
      const h = (t / max) * chartH;
      if (h > 0) doc.rect(48 + i * slot + (slot - barW) / 2, baseY - h, barW, h).fill(brand);
    });
    if (days.length) {
      doc.font(F.regular).fontSize(7).fillColor(MUTED).text(days[0].day, 48, baseY + 3, { lineBreak: false });
      doc.text(days[days.length - 1].day, 48 + width - 60, baseY + 3, { width: 60, align: "right", lineBreak: false });
    }
    doc.x = 48;
    doc.y = baseY + 16;

    const w = o.whatsapp;
    table(
      ["WhatsApp", "Sent", "Delivered", "Read", "Replied", "Failed"],
      [
        ["Campaigns", w.campaignSent, `${w.campaignDelivered} (${pct(w.campaignDelivered, w.campaignSent)}%)`, `${w.campaignRead} (${pct(w.campaignRead, w.campaignSent)}%)`, `${w.campaignReplied} (${pct(w.campaignReplied, w.campaignSent)}%)`, w.campaignFailed],
        ["Inbox messages", w.conversationsSent, w.delivered, w.read, "—", w.failed],
      ],
      [width - 400, 80, 90, 80, 80, 70],
    );
    kv([
      ["WhatsApp messages received", w.received],
      ["Emails sent", o.email.sent],
      ["Email open rate", `${pct(o.email.opened, o.email.sent)}% (${o.email.opened})`],
      ["Email click rate", `${pct(o.email.clicked, o.email.sent)}% (${o.email.clicked})`],
      ["Emails bounced / failed", `${o.email.bounced} / ${o.email.failed}`],
      ["Unsubscribes", o.email.unsubscribed],
      ["SMS sent", o.sms.sent],
      ["SMS delivered", `${pct(o.sms.delivered, o.sms.sent)}% (${o.sms.delivered})`],
      ["SMS link clicks", o.sms.clicked],
      ["SMS failed", o.sms.failed],
    ]);
  }

  if (r.responseTimes) {
    const t = r.responseTimes;
    heading(SECTION_LABELS["response-times"]);
    table(["Measure", "Replies", "Average", "Median", "90% within"], [stat("First response", t.first), stat("All replies", t.all)], [width - 320, 80, 80, 80, 80]);
    table(["Reply time", "Replies", "Share"], t.buckets.map((b) => [b.label, b.count, `${pct(b.count, t.all.count)}%`]), [width - 160, 80, 80]);
    doc.font(F.regular).fontSize(9).fillColor(MUTED).text(`Customers still waiting for a reply: ${t.awaiting}.${t.truncated ? " Very busy period: only the first 200,000 messages were analysed." : ""}`);
  }

  if (r.team) {
    heading(SECTION_LABELS.team);
    table(
      ["Agent", "Messages", "Conversations", "Resolved", "Open", "Median reply", "90% within"],
      r.team.map((m) => [m.name, m.messagesSent, m.conversations, m.resolved, m.openAssigned, formatDuration(m.median), formatDuration(m.p90)]),
      [width - 390, 60, 80, 60, 50, 70, 70],
    );
  }

  doc.end();
  return done;
}
