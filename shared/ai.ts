/**
 * AI assistant: request schemas and result shapes shared by the server and the client.
 */
import { z } from "zod";

export const AI_MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Recommended: fast, high quality" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Most capable, slower and pricier" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", hint: "Fastest and cheapest" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", hint: "" },
] as const;
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";
export const DEFAULT_AI_MONTHLY_LIMIT = 1000;

export const AI_TONES = ["friendly", "professional", "playful", "urgent", "luxury"] as const;
export type AiTone = (typeof AI_TONES)[number];

export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Omit to keep the stored key. */
  apiKey: z.string().trim().max(300).optional(),
  model: z.string().trim().min(3).max(80).regex(/^[a-z0-9.-]+$/, "Use a model id like claude-sonnet-5-5"),
  monthlyLimit: z.coerce.number().int().min(-1).max(1_000_000),
});

const brief = z.string().trim().min(3, "Describe what the message is about").max(1500);
const tone = z.enum(AI_TONES).default("friendly");
const language = z.string().trim().max(40).default("the same language as the brief");

export const campaignDraftSchema = z.object({
  channel: z.enum(["sms", "whatsapp", "email_subject", "email_body"]),
  brief,
  tone,
  language,
  /** Business or brand name, for sign-offs. */
  brand: z.string().trim().max(100).optional(),
  /** Current text to improve instead of starting fresh. */
  current: z.string().max(5000).optional(),
});
export type CampaignDraftInput = z.infer<typeof campaignDraftSchema>;

export interface DraftVariant {
  text: string;
  /** Preview text (email subjects only). */
  preview?: string;
  note?: string;
}

/** Email body draft, turned into builder blocks by the client. */
export interface EmailDraft {
  heading: string;
  paragraphs: string[];
  buttonLabel: string | null;
}

export const SENTIMENTS = ["positive", "neutral", "negative", "mixed"] as const;
export const INTENTS = ["purchase", "pricing", "order_status", "support", "complaint", "refund", "cancellation", "feedback", "question", "spam", "other"] as const;
export const URGENCIES = ["low", "medium", "high"] as const;

export interface ConversationInsights {
  summary: string;
  keyPoints: string[];
  nextSteps: string[];
  sentiment: (typeof SENTIMENTS)[number];
  intent: (typeof INTENTS)[number];
  urgency: (typeof URGENCIES)[number];
  language: string;
  /** Messages the analysis covered. */
  messageCount: number;
}

export const INTENT_LABELS: Record<(typeof INTENTS)[number], string> = {
  purchase: "Wants to buy",
  pricing: "Pricing",
  order_status: "Order status",
  support: "Needs help",
  complaint: "Complaint",
  refund: "Refund",
  cancellation: "Cancellation",
  feedback: "Feedback",
  question: "Question",
  spam: "Spam",
  other: "Other",
};

export interface AiStatus {
  available: boolean;
  /** Why it's unavailable: "disabled" | "no_key" | "level" | "limit". */
  reason: string | null;
  simulated: boolean;
  used: number;
  limit: number;
  model: string;
}
