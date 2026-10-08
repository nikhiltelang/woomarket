/** Unified contact timeline: everything that happened with one contact, newest first. */
import { z } from "zod";

export const TIMELINE_KINDS = ["message", "email", "sms", "automation", "note", "activity"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export const KIND_LABELS: Record<TimelineKind, string> = { message: "Conversations", email: "Email", sms: "SMS", automation: "Flows", note: "Notes", activity: "Changes" };

export interface TimelineItem {
  /** Unique across kinds ("<kind>:<row id>"). */
  id: string;
  kind: TimelineKind;
  at: string;
  title: string;
  body?: string | null;
  /** whatsapp, web, messenger, instagram (messages). */
  channel?: string | null;
  direction?: "inbound" | "outbound" | null;
  status?: string | null;
  /** Who: a teammate, the chatbot, a campaign or flow. */
  actor?: string | null;
  /** Engagement chips: delivered, read, opened, clicked… */
  tags?: string[];
  /** Where to go for more (inbox conversation, campaign, flow). */
  link?: string | null;
  /** Notes: id of the author (to allow deleting their own). */
  authorId?: string | null;
}

export interface TimelinePage {
  items: TimelineItem[];
  /** Pass as `before` to get the next page (null when there's nothing older). */
  nextBefore: string | null;
}

export interface ContactSummary {
  messages: { inbound: number; outbound: number; lastInboundAt: string | null };
  conversations: { open: number; total: number; latestId: string | null };
  email: { sent: number; opened: number; clicked: number };
  sms: { sent: number; clicked: number };
  flows: { active: number; total: number };
  notes: number;
}

export const timelineQuery = z.object({
  before: z.coerce.date().optional(),
  kinds: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter((k): k is TimelineKind => (TIMELINE_KINDS as readonly string[]).includes(k)) : [...TIMELINE_KINDS])),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

export const noteSchema = z.object({ body: z.string().trim().min(1, "Write something").max(5000) });
