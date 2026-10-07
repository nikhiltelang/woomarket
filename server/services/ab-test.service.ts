/**
 * A/B tests: results per variant, picking a winner (automatically when the wait is over, or
 * manually) and releasing the held recipients with the winning variant.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { pickWinner, rate, type AbProgress, type AbResults } from "@shared/ab-test";
export type { AbProgress };
import { campaignRecipients, campaigns, emailCampaignRecipients, emailCampaigns, smsCampaignRecipients, smsCampaigns, type AbTestState } from "@shared/schema";
import { db } from "../db";
import { conflict, notFound } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { templatesRepository } from "../repositories/templates.repository";
import { completeCampaignIfDone, queueRepository } from "./message-queue";
import { completeEmailCampaignIfDone, completeSmsCampaignIfDone } from "./marketing.service";

const log = childLogger("ab-test");
export type AbKind = "email" | "sms" | "whatsapp";

type Settings = AbTestState & { metric?: string; templateIdB?: string | null } & Partial<Omit<AbProgress, "phase" | "winner">>;

const TABLES = {
  email: { campaign: emailCampaigns, recipients: emailCampaignRecipients },
  sms: { campaign: smsCampaigns, recipients: smsCampaignRecipients },
  whatsapp: { campaign: campaigns, recipients: campaignRecipients },
} as const;

/** Progress fields after the test is set up at campaign start. */
export function testingState(settings: Settings, held: number): Settings {
  return { ...settings, phase: "testing", held, winner: null, testEndsAt: new Date(Date.now() + Number(settings.waitHours ?? 4) * 3600_000).toISOString() };
}

async function loadState(kind: AbKind, id: string): Promise<Settings | null> {
  const t = TABLES[kind].campaign;
  const [row] = await db.select({ ab: t.abTest }).from(t).where(eq(t.id, id)).limit(1);
  if (!row) throw notFound("Campaign");
  return (row.ab as Settings | null) ?? null;
}

async function saveState(kind: AbKind, id: string, state: Settings) {
  const t = TABLES[kind].campaign;
  await db.update(t).set({ abTest: state }).where(eq(t.id, id));
}

/** Sent and "hit" counts per variant, from the recipients' rows. */
export async function abResults(kind: AbKind, id: string, metric: string): Promise<AbResults> {
  let query;
  if (kind === "email") {
    const r = emailCampaignRecipients;
    const hit = metric === "click" ? sql`${r.clickedAt} IS NOT NULL` : sql`${r.openedAt} IS NOT NULL`;
    query = db.select({ variant: r.variant, sent: sql<number>`SUM(${r.status} IN ('sent','bounced'))`, hits: sql<number>`SUM(${hit})` }).from(r).where(eq(r.campaignId, id)).groupBy(r.variant);
  } else if (kind === "sms") {
    const r = smsCampaignRecipients;
    query = db.select({ variant: r.variant, sent: sql<number>`SUM(${r.status} IN ('sent','delivered'))`, hits: sql<number>`SUM(${r.clickedAt} IS NOT NULL)` }).from(r).where(eq(r.campaignId, id)).groupBy(r.variant);
  } else {
    const r = campaignRecipients;
    query = db.select({ variant: r.variant, sent: sql<number>`SUM(${r.whatsappMessageId} IS NOT NULL)`, hits: sql<number>`SUM(${r.readAt} IS NOT NULL)` }).from(r).where(eq(r.campaignId, id)).groupBy(r.variant);
  }
  const rows = await query;
  const get = (v: "A" | "B") => {
    const row = rows.find((x) => x.variant === v);
    const sent = Number(row?.sent ?? 0);
    const hits = Number(row?.hits ?? 0);
    return { sent, hits, rate: rate(hits, sent) };
  };
  return { A: get("A"), B: get("B") };
}

/** Sends the winner to everyone held back. */
async function release(kind: AbKind, id: string, winner: "A" | "B", state: Settings): Promise<number> {
  if (kind !== "whatsapp") {
    const r = TABLES[kind].recipients;
    const [res] = await db.update(r).set({ status: "pending", variant: winner }).where(and(eq(r.campaignId, id), eq(r.status, "held")));
    return res.affectedRows;
  }
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  const templateId = winner === "B" ? state.templateIdB : campaign?.templateId;
  const template = templateId ? await templatesRepository.findById(templateId) : undefined;
  if (!campaign || !template) throw conflict("The winning template is no longer available");
  const held = await db.select().from(campaignRecipients).where(and(eq(campaignRecipients.campaignId, id), eq(campaignRecipients.status, "held")));
  if (!held.length) return 0;
  await queueRepository.enqueue(
    held.map((r) => ({
      campaignId: id,
      channelId: campaign.channelId,
      recipientPhone: r.phone,
      templateName: template.name,
      templateLanguage: template.language ?? "en_US",
      templateParams: Object.keys(r.templateParams ?? {}).sort((a, b) => Number(a) - Number(b)).map((k) => r.templateParams![k]),
      messageType: "template",
      status: campaign.status === "paused" ? "paused" : "queued",
    })),
  );
  await db.update(campaignRecipients).set({ status: "pending", variant: winner }).where(inArray(campaignRecipients.id, held.map((r) => r.id)));
  await templatesRepository.incrementUsage(template.id, held.length);
  return held.length;
}

/**
 * Picks the winner (or uses `forced`) and releases held recipients. Returns the new state;
 * a test already decided is left alone.
 */
export async function decideTest(kind: AbKind, id: string, opts: { winner?: "A" | "B"; by: "auto" | "manual" }): Promise<Settings> {
  const state = await loadState(kind, id);
  if (!state || state.phase !== "testing") throw conflict("This campaign has no A/B test in progress");
  const results = await abResults(kind, id, String(state.metric ?? (kind === "email" ? "open" : kind === "sms" ? "click" : "read")));
  const winner = opts.winner ?? pickWinner(results);
  const next: Settings = { ...state, phase: "decided", winner, decidedBy: opts.by, decidedAt: new Date().toISOString(), results };
  // Claim the decision first, so two deciders can't both release.
  const t = TABLES[kind].campaign;
  const [claimed] = await db
    .update(t)
    .set({ abTest: next })
    .where(and(eq(t.id, id), sql`JSON_UNQUOTE(JSON_EXTRACT(${t.abTest}, '$.phase')) = 'testing'`));
  if (!claimed.affectedRows) throw conflict("This test was just decided");
  const released = await release(kind, id, winner, state);
  log.info({ kind, campaignId: id, winner, released, by: opts.by, results }, "A/B test decided");
  if (kind === "email") await completeEmailCampaignIfDone(id);
  else if (kind === "sms") await completeSmsCampaignIfDone(id);
  else await completeCampaignIfDone(id);
  return next;
}

/** Cron: decides tests whose waiting time is over. */
export async function decideDueTests(now = new Date()): Promise<number> {
  let decided = 0;
  for (const kind of ["email", "sms", "whatsapp"] as AbKind[]) {
    const t = TABLES[kind].campaign;
    const due = await db
      .select({ id: t.id })
      .from(t)
      .where(sql`JSON_UNQUOTE(JSON_EXTRACT(${t.abTest}, '$.phase')) = 'testing' AND JSON_UNQUOTE(JSON_EXTRACT(${t.abTest}, '$.testEndsAt')) <= ${now.toISOString()} AND ${t.status} NOT IN ('cancelled','failed')`);
    for (const c of due) {
      try {
        await decideTest(kind, c.id, { by: "auto" });
        decided++;
      } catch (err) {
        log.warn({ kind, campaignId: c.id, err: (err as Error).message }, "A/B decision failed");
      }
    }
  }
  return decided;
}

/** Stored settings and progress, plus live results while testing. */
export async function abOverview(kind: AbKind, id: string) {
  const state = await loadState(kind, id);
  if (!state?.enabled) return null;
  const live = state.phase === "testing" || state.phase === "decided" ? await abResults(kind, id, String(state.metric ?? "open")) : null;
  const templateNameB = kind === "whatsapp" && state.templateIdB ? (await templatesRepository.findById(state.templateIdB))?.name ?? null : undefined;
  return { ...state, live, ...(templateNameB !== undefined ? { templateNameB } : {}) };
}

export { saveState as saveAbState };
