/**
 * Public API v1: request schemas and the request-signing format, shared by the
 * server and the in-app API documentation.
 */
import { z } from "zod";

export const API_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type ApiChannel = (typeof API_CHANNELS)[number];
export const MAX_API_RECIPIENTS = 1000;
/** Groups per request, and the total audience a request may reach once groups are expanded. */
export const MAX_API_GROUPS = 20;
export const MAX_API_AUDIENCE = 50_000;
/** Signed requests must be within this many seconds of the server clock. */
export const SIGNATURE_WINDOW_SECONDS = 300;

export const API_HEADERS = {
  keyId: "x-wm-access-key-id",
  timestamp: "x-wm-timestamp",
  signature: "x-wm-signature",
  idempotency: "idempotency-key",
} as const;

/**
 * The exact text that is HMAC-SHA256 signed with the Secret Access Key:
 * unix timestamp, HTTP method, path (with query string) and the hex SHA-256 of the raw body,
 * separated by newlines.
 */
export const stringToSign = (timestamp: string, method: string, path: string, bodySha256Hex: string) => `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodySha256Hex}`;

const e164 = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s().-]/g, ""))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, "Use international format with +, e.g. +14155550123"));
const name = z.string().trim().max(255).optional();

// A recipient is a plain string ("ada@example.com" / "+14155550123") or an object with extras.
const asObject = (field: "email" | "phone") => (v: unknown) => (typeof v === "string" ? { [field]: v } : v);
const emailRecipient = z.preprocess(asObject("email"), z.object({ email: z.string().trim().toLowerCase().email("Invalid email address"), name }));
const phoneRecipient = z.preprocess(
  asObject("phone"),
  z.object({ phone: e164, name, variables: z.array(z.string().max(1024)).max(20).optional() }),
);

const common = {
  /** Contact groups to send to, by group id or exact name; combined with `recipients`. */
  groups: z.array(z.string().trim().min(1).max(255)).max(MAX_API_GROUPS).default([]),
  /** Shown as the campaign name in the app; defaults to "API · <channel> · <time>". */
  name: z.string().trim().min(1).max(255).optional(),
  /** Send later instead of now (ISO 8601). */
  scheduleAt: z.coerce.date().optional(),
  /** Hold messages that would arrive during the account's quiet hours (off: API sends are often transactional). */
  respectQuietHours: z.boolean().default(false),
};

export const apiSendSchema = z
  .discriminatedUnion("channel", [
    z.object({
      channel: z.literal("email"),
      ...common,
      recipients: z.array(emailRecipient).max(MAX_API_RECIPIENTS).default([]),
      subject: z.string().trim().min(1).max(255),
      html: z.string().min(1).max(500_000).optional(),
      text: z.string().min(1).max(200_000).optional(),
      previewText: z.string().trim().max(255).optional(),
      senderName: z.string().trim().min(1).max(100).optional(),
      replyTo: z.string().trim().toLowerCase().email().optional(),
    }),
    z.object({
      channel: z.literal("sms"),
      ...common,
      recipients: z.array(phoneRecipient).max(MAX_API_RECIPIENTS).default([]),
      message: z.string().trim().min(1).max(1600),
    }),
    z.object({
      channel: z.literal("whatsapp"),
      ...common,
      recipients: z.array(phoneRecipient).max(MAX_API_RECIPIENTS).default([]),
      template: z.object({
        name: z.string().trim().min(1).max(512),
        language: z.string().trim().min(2).max(15).optional(),
        /**
         * Values for {{1}}, {{2}}… used for every recipient without its own `variables`
         * (e.g. group members). May contain {{name}}, {{first_name}}, {{phone}}, {{email}}.
         */
        variables: z.array(z.string().max(1024)).max(20).optional(),
      }),
      /** WhatsApp number to send from: its id or phone number. Optional when the key has a default or the account has one number. */
      from: z.string().trim().max(64).optional(),
    }),
  ])
  .superRefine((v, ctx) => {
    if (!v.recipients.length && !v.groups.length) ctx.addIssue({ code: "custom", path: ["recipients"], message: "Provide recipients, groups, or both" });
    if (v.channel === "email" && !v.html && !v.text) ctx.addIssue({ code: "custom", path: ["html"], message: "Provide html or text" });
    if (v.scheduleAt && v.scheduleAt.getTime() < Date.now() - 60_000) ctx.addIssue({ code: "custom", path: ["scheduleAt"], message: "Must be in the future" });
    if (v.scheduleAt && v.scheduleAt.getTime() > Date.now() + 366 * 86_400_000) ctx.addIssue({ code: "custom", path: ["scheduleAt"], message: "At most a year ahead" });
  });
export type ApiSendInput = z.infer<typeof apiSendSchema>;

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(100),
  channels: z.array(z.enum(API_CHANNELS)).min(1, "Allow at least one channel"),
  defaultChannelId: z.string().uuid().nullish(),
  expiresAt: z.coerce.date().nullish(),
});
