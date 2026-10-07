/** A/B tests for campaigns: settings per channel, progress shape and the audience split. */
import { z } from "zod";

const common = {
  enabled: z.boolean().default(false),
  /** Share of the audience in the test (split evenly between A and B); 100 = split everyone. */
  testPercent: z.coerce.number().int().min(10).max(100).default(20),
  /** Hours to wait before picking the winner and sending it to everyone else. */
  waitHours: z.coerce.number().int().min(1).max(72).default(4),
};

export const emailAbSchema = z
  .object({
    ...common,
    metric: z.enum(["open", "click"]).default("open"),
    subjectB: z.string().trim().max(255).default(""),
    previewTextB: z.string().trim().max(255).nullish(),
    /** Different content for B (null = same content as A). */
    contentHtmlB: z.string().max(500_000).nullish(),
  })
  .refine((v) => !v.enabled || v.subjectB || v.contentHtmlB, { message: "Give variant B a different subject or content", path: ["subjectB"] });

export const smsAbSchema = z
  .object({ ...common, metric: z.literal("click").default("click"), messageB: z.string().trim().max(1600).default("") })
  .refine((v) => !v.enabled || v.messageB, { message: "Write variant B's message", path: ["messageB"] });

export const whatsappAbSchema = z
  .object({ ...common, metric: z.literal("read").default("read"), templateIdB: z.string().uuid().nullish() })
  .refine((v) => !v.enabled || v.templateIdB, { message: "Choose variant B's template", path: ["templateIdB"] });

export type AbMetric = "open" | "click" | "read";

export interface AbResults {
  A: { sent: number; hits: number; rate: number };
  B: { sent: number; hits: number; rate: number };
}

/** Progress the server adds to the stored settings. */
export interface AbProgress {
  phase: "testing" | "decided" | "skipped";
  testEndsAt?: string;
  decidedAt?: string;
  winner?: "A" | "B" | null;
  /** How the winner was chosen. */
  decidedBy?: "auto" | "manual";
  held?: number;
  results?: AbResults;
}

export const AB_METRIC_LABEL: Record<AbMetric, string> = { open: "Open rate", click: "Click rate", read: "Read rate" };

/**
 * Splits an audience: a random test slice divided evenly into A and B, the rest held for
 * the winner. Audiences under 4 aren't tested (everyone gets A).
 */
export function splitAudience<T>(items: T[], testPercent: number, random: () => number = Math.random): { A: T[]; B: T[]; held: T[] } {
  if (items.length < 4) return { A: items, B: [], held: [] };
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const testSize = Math.max(2, Math.min(items.length, Math.round((items.length * testPercent) / 100)));
  const half = Math.ceil(testSize / 2);
  return { A: shuffled.slice(0, half), B: shuffled.slice(half, testSize), held: shuffled.slice(testSize) };
}

/** Winner by rate; ties go to A (the original). */
export const pickWinner = (r: AbResults): "A" | "B" => (r.B.rate > r.A.rate ? "B" : "A");

export const rate = (hits: number, sent: number) => (sent ? Math.round((hits / sent) * 1000) / 10 : 0);
