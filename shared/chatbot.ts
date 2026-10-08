/**
 * Chatbot and auto-replies: rules that answer incoming messages on WhatsApp, Messenger,
 * Instagram and the website widget. Matching is pure so the server and the test console agree.
 */
import { z } from "zod";
import { zonedParts } from "./sending";

export const BOT_CHANNELS = ["whatsapp", "messenger", "instagram", "web"] as const;
export type BotChannel = (typeof BOT_CHANNELS)[number];
export const BOT_CHANNEL_LABELS: Record<BotChannel, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", web: "Website chat" };

export const TRIGGER_TYPES = ["keyword", "button", "first_message", "outside_hours", "fallback"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const TRIGGER_LABELS: Record<TriggerType, string> = {
  keyword: "Message contains a keyword",
  button: "Customer taps a button or list item",
  first_message: "First message of a new conversation",
  outside_hours: "Message outside business hours",
  fallback: "Nothing else matched",
};

/** Ids customers' button taps come back with (letters, digits, - and _). */
const buttonId = z.string().trim().min(1).max(64).regex(/^[a-z0-9_-]+$/i, "Use letters, digits, - and _");

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("keyword"),
    keywords: z.array(z.string().trim().min(1).max(100)).min(1, "Add at least one keyword").max(30),
    match: z.enum(["contains", "exact", "starts_with"]).default("contains"),
  }),
  z.object({ type: z.literal("button"), buttonId }),
  z.object({ type: z.literal("first_message") }),
  z.object({ type: z.literal("outside_hours") }),
  z.object({ type: z.literal("fallback") }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

const optionTitle = z.string().trim().min(1).max(20, "Button titles are limited to 20 characters by WhatsApp");
export const responseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(4096) }),
  z.object({
    type: z.literal("buttons"),
    text: z.string().trim().min(1).max(1024),
    buttons: z.array(z.object({ id: buttonId, title: optionTitle })).min(1).max(3, "WhatsApp allows up to 3 buttons"),
  }),
  z.object({
    type: z.literal("list"),
    text: z.string().trim().min(1).max(1024),
    /** Label of the button that opens the list. */
    button: z.string().trim().min(1).max(20),
    rows: z.array(z.object({ id: buttonId, title: z.string().trim().min(1).max(24), description: z.string().trim().max(72).optional() })).min(1).max(10, "WhatsApp lists hold up to 10 rows"),
  }),
  z.object({
    type: z.literal("ai"),
    /** Facts the AI may answer from (opening times, prices, policies…). */
    knowledge: z.string().trim().min(10, "Add the facts the AI can answer from").max(8000),
    /** Sent when the AI can't answer from the knowledge (the chat is handed to a person). */
    unsureText: z.string().trim().min(1).max(1024).default("Let me get a teammate to help you with that."),
  }),
]);
export type BotResponse = z.infer<typeof responseSchema>;

export const actionsSchema = z.object({
  addTags: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
  /** Team member id to assign the conversation to. */
  assignTo: z.string().uuid().nullish(),
  /** Stop the bot in this conversation so a person takes over. */
  handoff: z.boolean().default(false),
});

export const ruleSchema = z
  .object({
    name: z.string().trim().min(1, "Name the rule").max(100),
    enabled: z.boolean().default(true),
    channels: z.array(z.enum(BOT_CHANNELS)).min(1, "Pick at least one channel"),
    trigger: triggerSchema,
    response: responseSchema,
    actions: actionsSchema.default({}),
    /** Don't fire this rule again in the same conversation within this many minutes. */
    cooldownMinutes: z.coerce.number().int().min(0).max(10_080).default(0),
  })
  .superRefine((r, ctx) => {
    if (r.response.type === "buttons" || r.response.type === "list") {
      const ids = r.response.type === "buttons" ? r.response.buttons.map((b) => b.id) : r.response.rows.map((b) => b.id);
      if (new Set(ids.map((i) => i.toLowerCase())).size !== ids.length) ctx.addIssue({ code: "custom", path: ["response"], message: "Each button needs a different id" });
    }
  });
export type RuleInput = z.infer<typeof ruleSchema>;

// ---------------------------------------------------------------------------
// Business hours and bot settings
// ---------------------------------------------------------------------------

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const range = z.object({ start: hm, end: hm }).refine((r) => r.start < r.end, "The end must be after the start");

export const botSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Empty = the tenant's sending time zone. */
  timezone: z.string().trim().max(64).default(""),
  hours: z.record(z.enum(WEEKDAYS), z.array(range).max(3)).default({ mon: [{ start: "09:00", end: "18:00" }], tue: [{ start: "09:00", end: "18:00" }], wed: [{ start: "09:00", end: "18:00" }], thu: [{ start: "09:00", end: "18:00" }], fri: [{ start: "09:00", end: "18:00" }] }),
  /** After a person replies, the bot stays quiet in that conversation for this long. */
  pauseAfterAgentMinutes: z.coerce.number().int().min(0).max(10_080).default(60),
  /** How long a hand-off keeps the bot quiet (until a person resumes it, at most this long). */
  handoffHours: z.coerce.number().int().min(1).max(720).default(24),
});
export type BotSettings = z.infer<typeof botSettingsSchema>;

/** Whether `at` falls inside the business hours, in `tz`. */
export function isWithinHours(hours: BotSettings["hours"], at: Date, tz: string): boolean {
  const p = zonedParts(at, tz);
  const day = WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  const now = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return (hours[day] ?? []).some((r) => now >= r.start && now < r.end);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface MatchableRule {
  id: string;
  enabled: boolean;
  channels: string[];
  trigger: Trigger;
  priority: number;
}

export interface Incoming {
  channel: BotChannel;
  text: string;
  /** Id of a tapped button / list row, if any. */
  buttonId?: string | null;
  /** First inbound message of the conversation. */
  firstMessage: boolean;
  /** Outside business hours right now. */
  outsideHours: boolean;
}

const normalise = (s: string) => s.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();

/** Whole-word "contains", so "hi" doesn't match "this". */
function containsWord(text: string, word: string): boolean {
  const w = normalise(word);
  if (!w) return false;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

export function keywordMatches(trigger: Extract<Trigger, { type: "keyword" }>, rawText: string): boolean {
  const text = normalise(rawText);
  return trigger.keywords.some((k) => {
    const key = normalise(k);
    if (trigger.match === "exact") return text === key;
    if (trigger.match === "starts_with") return text.startsWith(key);
    return containsWord(text, key);
  });
}

/**
 * Picks the one rule to run, in this order: a tapped button, keywords, the welcome for a first
 * message, the away message outside business hours, then the fallback. Within each kind, rules
 * are tried by priority (lower first).
 */
export function pickRule<R extends MatchableRule>(rules: R[], m: Incoming): { rule: R; reason: TriggerType } | null {
  const usable = rules.filter((r) => r.enabled && r.channels.includes(m.channel)).sort((a, b) => a.priority - b.priority);
  const of = <T extends TriggerType>(t: T) => usable.filter((r) => r.trigger.type === t);
  if (m.buttonId) {
    const hit = of("button").find((r) => (r.trigger as { buttonId: string }).buttonId.toLowerCase() === m.buttonId!.toLowerCase());
    if (hit) return { rule: hit, reason: "button" };
  }
  if (m.text.trim()) {
    const hit = of("keyword").find((r) => keywordMatches(r.trigger as Extract<Trigger, { type: "keyword" }>, m.text));
    if (hit) return { rule: hit, reason: "keyword" };
  }
  if (m.firstMessage && of("first_message")[0]) return { rule: of("first_message")[0], reason: "first_message" };
  if (m.outsideHours && of("outside_hours")[0]) return { rule: of("outside_hours")[0], reason: "outside_hours" };
  if (of("fallback")[0]) return { rule: of("fallback")[0], reason: "fallback" };
  return null;
}

/** Plain-text version of a reply, for channels without buttons (website chat). */
export function responseAsText(r: Exclude<BotResponse, { type: "ai" }>): string {
  if (r.type === "text") return r.text;
  const options = r.type === "buttons" ? r.buttons.map((b) => b.title) : r.rows.map((x) => x.title + (x.description ? ` (${x.description})` : ""));
  return `${r.text}\n\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
}
