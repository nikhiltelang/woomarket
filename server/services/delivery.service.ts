/**
 * Per-recipient send times: local-time and best-time delivery, and quiet hours, in each
 * contact's own time zone. The result is stored as send_after (email/SMS) or scheduled_for
 * (WhatsApp queue); workers skip rows until then.
 */
import { inArray, sql } from "drizzle-orm";
import { applyQuietHours, contactTimeZone, DEFAULT_SENDING_PREFERENCES, nextLocalTime, sendingPreferencesSchema, type SendChannel, type SendingPreferences } from "@shared/sending";
import { contacts, tenantSettings } from "@shared/schema";
import { db } from "../db";

export interface DeliverySetting {
  mode?: string;
  localTime?: string;
  /** Transactional sends (public API) skip quiet hours unless asked not to. */
  ignoreQuietHours?: boolean;
}

export interface DeliveryTarget {
  contactId: string | null;
  phone?: string | null;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export const tenantSettingsRepository = {
  async getSending(userId: string): Promise<SendingPreferences> {
    const [row] = await db.select().from(tenantSettings).where(sql`${tenantSettings.userId} = ${userId}`).limit(1);
    const parsed = sendingPreferencesSchema.safeParse({ ...DEFAULT_SENDING_PREFERENCES, ...(row?.sending ?? {}) });
    return parsed.success ? parsed.data : DEFAULT_SENDING_PREFERENCES;
  },
  async saveSending(userId: string, prefs: SendingPreferences): Promise<void> {
    await db
      .insert(tenantSettings)
      .values({ userId, sending: prefs as unknown as Record<string, unknown> })
      .onDuplicateKeyUpdate({ set: { sending: prefs as unknown as Record<string, unknown> } });
  },
};

// ---------------------------------------------------------------------------
// Engagement history
// ---------------------------------------------------------------------------

/**
 * Each contact's most common engagement hour (UTC): email opens and clicks, SMS clicks,
 * WhatsApp reads and inbound replies.
 */
export async function bestHoursUtc(contactIds: string[]): Promise<Map<string, number>> {
  const best = new Map<string, number>();
  const ids = [...new Set(contactIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const [rows] = (await db.execute(sql`
      SELECT contact_id, h, COUNT(*) AS n FROM (
        SELECT contact_id, HOUR(opened_at) AS h FROM email_campaign_recipients WHERE opened_at IS NOT NULL AND contact_id IN (${sql.join(chunk.map((c) => sql`${c}`), sql`, `)})
        UNION ALL SELECT contact_id, HOUR(clicked_at) FROM email_campaign_recipients WHERE clicked_at IS NOT NULL AND contact_id IN (${sql.join(chunk.map((c) => sql`${c}`), sql`, `)})
        UNION ALL SELECT contact_id, HOUR(clicked_at) FROM sms_campaign_recipients WHERE clicked_at IS NOT NULL AND contact_id IN (${sql.join(chunk.map((c) => sql`${c}`), sql`, `)})
        UNION ALL SELECT c.contact_id, HOUR(m.read_at) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.read_at IS NOT NULL AND c.contact_id IN (${sql.join(chunk.map((c) => sql`${c}`), sql`, `)})
        UNION ALL SELECT c.contact_id, HOUR(m.created_at) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.direction = 'inbound' AND c.contact_id IN (${sql.join(chunk.map((c) => sql`${c}`), sql`, `)})
      ) e GROUP BY contact_id, h`)) as unknown as [{ contact_id: string; h: number; n: number }[]];
    const top = new Map<string, { h: number; n: number }>();
    for (const r of rows) {
      const cur = top.get(r.contact_id);
      if (!cur || Number(r.n) > cur.n) top.set(r.contact_id, { h: Number(r.h), n: Number(r.n) });
    }
    for (const [id, v] of top) best.set(id, v.h);
  }
  return best;
}

/** Stable 0–29 minute offset per contact, so best-time sends don't all fire on the hour. */
const jitterMinutes = (key: string) => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 30;
};

/** Next instant at or after `from` whose UTC hour is `hour`. */
function nextUtcHour(from: Date, hour: number, minute: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, minute));
  if (d.getTime() < from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Send-after time per target (null = now). Uses the tenant's preferences; a contact's zone comes
 * from its "timezone" custom field, else its phone's country, else the tenant's zone.
 */
export async function scheduleRecipients(tenantId: string, channel: SendChannel, delivery: DeliverySetting | null | undefined, targets: DeliveryTarget[], start = new Date()): Promise<(Date | null)[]> {
  const mode = delivery?.mode ?? "immediate";
  const prefs = await tenantSettingsRepository.getSending(tenantId);
  const quiet = prefs.quietHours.enabled && prefs.quietHours.channels.includes(channel) && !delivery?.ignoreQuietHours ? prefs.quietHours : null;
  if (mode === "immediate" && !quiet) return targets.map(() => null);

  // Contact phone and timezone field.
  const ids = [...new Set(targets.map((t) => t.contactId).filter((x): x is string => Boolean(x)))];
  const info = new Map<string, { phone: string; tz: string | null }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db.select({ id: contacts.id, phone: contacts.phone, metadata: contacts.metadata }).from(contacts).where(inArray(contacts.id, ids.slice(i, i + 1000)));
    for (const r of rows) info.set(r.id, { phone: r.phone, tz: (r.metadata as Record<string, string> | null)?.timezone ?? null });
  }
  const best = mode === "best_time" ? await bestHoursUtc(ids) : new Map<string, number>();

  return targets.map((t) => {
    const c = t.contactId ? info.get(t.contactId) : undefined;
    const tz = contactTimeZone({ phone: c?.phone ?? t.phone, timezone: c?.tz }, prefs.timezone);
    let at = start;
    if (mode === "local_time" && delivery?.localTime) {
      at = nextLocalTime(start, tz, delivery.localTime);
    } else if (mode === "best_time") {
      const key = t.contactId ?? t.phone ?? "";
      const hour = t.contactId ? best.get(t.contactId) : undefined;
      at = hour !== undefined ? nextUtcHour(start, hour, jitterMinutes(key)) : nextLocalTime(start, tz, `${String(prefs.defaultBestHour).padStart(2, "0")}:${String(jitterMinutes(key)).padStart(2, "0")}`);
    }
    if (quiet) at = applyQuietHours(at, tz, quiet);
    return at.getTime() - start.getTime() > 30_000 ? at : null;
  });
}
