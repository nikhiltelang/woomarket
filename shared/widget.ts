/**
 * Website chat widget: a "Chat on WhatsApp" button and/or a live chat window whose
 * conversations land in the shared inbox.
 */
import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #16a34a");
const text = (max: number) => z.string().trim().max(max);

/** Exact origins (https://shop.example.com) or wildcard subdomains (https://*.example.com). */
export const originPattern = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^https?:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/, "Use an origin like https://shop.example.com (no path)");

export const widgetSettingsSchema = z.object({
  color: color.default("#16a34a"),
  position: z.enum(["right", "left"]).default("right"),
  title: text(60).default("Chat with us"),
  subtitle: text(120).default("We usually reply within a few minutes"),
  greeting: text(500).default("Hi there! How can we help you today?"),
  /** "Chat on WhatsApp": opens wa.me with a pre-filled message. */
  whatsapp: z
    .object({
      enabled: z.boolean().default(true),
      phone: z.string().trim().regex(/^\+?[1-9]\d{6,14}$/, "Use an international number like +919812345678").or(z.literal("")).default(""),
      prefill: text(300).default("Hi! I have a question."),
      label: text(40).default("Chat on WhatsApp"),
    })
    .default({}),
  /** Live chat into the inbox. */
  liveChat: z
    .object({
      enabled: z.boolean().default(true),
      askName: z.boolean().default(true),
      askEmail: z.boolean().default(false),
      askPhone: z.boolean().default(false),
      /** Pre-chat fields must be filled before the first message. */
      requireDetails: z.boolean().default(false),
    })
    .default({}),
  /** Show the launcher only after this many seconds (0 = immediately). */
  delaySeconds: z.coerce.number().int().min(0).max(120).default(0),
});
export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

export const widgetSchema = z.object({
  name: text(100).min(1, "Name the widget"),
  channelId: z.string().uuid(),
  enabled: z.boolean().default(true),
  settings: widgetSettingsSchema,
  /** Empty = any website. */
  allowedOrigins: z.array(originPattern).max(20).default([]),
});
export type WidgetInput = z.infer<typeof widgetSchema>;

// --- Visitor API ------------------------------------------------------------

export const MAX_VISITOR_MESSAGE = 2000;

export const startChatSchema = z.object({
  name: text(100).optional(),
  email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal("")),
  phone: z.string().trim().regex(/^\+?[1-9]\d{6,14}$/, "Use an international number like +919812345678").optional().or(z.literal("")),
  message: z.string().trim().min(1, "Type a message").max(MAX_VISITOR_MESSAGE),
  /** Page the visitor was on. */
  page: z.string().trim().max(500).optional(),
  /** Spam trap: real visitors never fill this hidden field. */
  website: z.string().max(0).optional(),
});

export const visitorMessageSchema = z.object({ text: z.string().trim().min(1).max(MAX_VISITOR_MESSAGE) });

/** Settings the public widget needs (no internal ids beyond the widget's own). */
export interface PublicWidgetConfig {
  id: string;
  settings: WidgetSettings;
  liveChat: boolean;
  whatsappUrl: string | null;
}

export interface VisitorMessage {
  id: string;
  from: "visitor" | "agent";
  text: string;
  at: string;
  agentName?: string | null;
}

/** wa.me link with an optional pre-filled message. */
export function whatsappLink(phone: string, text?: string): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** Whether `origin` (scheme://host[:port]) matches one of the allowed patterns. */
export function originAllowed(origin: string | null | undefined, allowed: string[]): boolean {
  if (!allowed.length) return true;
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const value = `${o.protocol}//${o.host}`.toLowerCase();
  return allowed.some((p) => {
    if (!p.includes("*.")) return p === value;
    const [scheme, rest] = p.split("//");
    const suffix = rest.slice(1); // ".example.com[:port]"
    return o.protocol === scheme && `.${o.host}`.endsWith(suffix) && o.host !== suffix.slice(1);
  });
}
