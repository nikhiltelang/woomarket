/**
 * Outgoing webhooks: the events tenants can subscribe to, with sample payloads (used by the
 * "Send test" button and by Zapier/Make to show fields before a real event happens).
 */
import { z } from "zod";

export const WEBHOOK_EVENTS = {
  "message.received": { group: "WhatsApp", label: "Message received", description: "A contact sent a WhatsApp message (including replies to campaigns)." },
  "message.sent": { group: "WhatsApp", label: "Message sent", description: "A WhatsApp message was accepted by WhatsApp." },
  "message.delivered": { group: "WhatsApp", label: "Message delivered", description: "A WhatsApp message reached the contact's phone." },
  "message.read": { group: "WhatsApp", label: "Message read", description: "The contact opened a WhatsApp message." },
  "message.failed": { group: "WhatsApp", label: "Message failed", description: "WhatsApp couldn't deliver a message." },
  "contact.created": { group: "Contacts", label: "Contact created", description: "A contact was added manually, by import, by the API or by an incoming message." },
  "contact.updated": { group: "Contacts", label: "Contact updated", description: "A contact's details, tags or groups changed." },
  "contact.unsubscribed": { group: "Contacts", label: "Contact unsubscribed", description: "A contact unsubscribed from emails." },
  "campaign.completed": { group: "Campaigns", label: "Campaign completed", description: "A WhatsApp, email or SMS campaign finished sending." },
  "email.opened": { group: "Email", label: "Email opened", description: "A contact opened a campaign email (first open)." },
  "email.clicked": { group: "Email", label: "Email link clicked", description: "A contact clicked a tracked link in an email." },
  "email.bounced": { group: "Email", label: "Email bounced", description: "An email couldn't be delivered." },
  "sms.delivered": { group: "SMS", label: "SMS delivered", description: "The gateway confirmed an SMS was delivered." },
  "sms.clicked": { group: "SMS", label: "SMS link clicked", description: "A contact clicked a tracked link in an SMS." },
} as const;

export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;
export const WEBHOOK_EVENT_NAMES = Object.keys(WEBHOOK_EVENTS) as WebhookEvent[];
export const isWebhookEvent = (e: string): e is WebhookEvent => e in WEBHOOK_EVENTS;

/** Delivery headers. */
export const WEBHOOK_HEADERS = {
  event: "X-WM-Event",
  delivery: "X-WM-Delivery",
  timestamp: "X-WM-Timestamp",
  /** "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>" */
  signature: "X-WM-Signature",
} as const;

/** Retry delays after each failed attempt (the first try is immediate). */
export const WEBHOOK_RETRY_DELAYS_S = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600, 12 * 3600];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_S.length + 1;

const eventList = z.array(z.union([z.literal("*"), z.enum(WEBHOOK_EVENT_NAMES as [WebhookEvent, ...WebhookEvent[]])])).min(1, "Choose at least one event").max(WEBHOOK_EVENT_NAMES.length + 1);

export const webhookEndpointSchema = z.object({
  url: z.string().trim().url("Enter a full URL").max(2000),
  description: z.string().trim().max(200).nullish(),
  events: eventList,
  enabled: z.boolean().default(true),
});

/** Zapier / Make "REST hook" subscription through the public API. */
export const restHookSchema = z.object({
  url: z.string().trim().url().max(2000),
  event: z.string().optional(),
  events: eventList.optional(),
  description: z.string().trim().max(200).optional(),
});

const now = "2026-10-08T09:30:00.000Z";
const contact = { id: "c7a1e0de-0000-4000-8000-000000000001", name: "Priya Sharma", phone: "+919812345678", email: "priya@example.com", tags: ["vip"], groups: [], fields: { city: "Pune" }, status: "active", source: "import", channelId: "47e038a4-0000-4000-8000-000000000002", createdAt: now };

export const WEBHOOK_SAMPLES: Record<WebhookEvent, Record<string, unknown>> = {
  "message.received": { messageId: "wamid.HBgMOTE5ODEyMzQ1Njc4FQIAEhgg", channelId: contact.channelId, conversationId: "0b8c7a4e-0000-4000-8000-000000000003", contact: { id: contact.id, name: contact.name, phone: contact.phone }, type: "text", text: "Hi, is the sale still on?", inReplyTo: null, campaignId: null, receivedAt: now },
  "message.sent": { messageId: "wamid.HBgMOTE5ODEyMzQ1Njc4FQIAERgS", channelId: contact.channelId, to: contact.phone, status: "sent", campaignId: null, at: now },
  "message.delivered": { messageId: "wamid.HBgMOTE5ODEyMzQ1Njc4FQIAERgS", channelId: contact.channelId, to: contact.phone, status: "delivered", campaignId: "5d1f0c2a-0000-4000-8000-000000000004", at: now },
  "message.read": { messageId: "wamid.HBgMOTE5ODEyMzQ1Njc4FQIAERgS", channelId: contact.channelId, to: contact.phone, status: "read", campaignId: "5d1f0c2a-0000-4000-8000-000000000004", at: now },
  "message.failed": { messageId: "wamid.HBgMOTE5ODEyMzQ1Njc4FQIAERgS", channelId: contact.channelId, to: contact.phone, status: "failed", error: { code: "131026", message: "Message undeliverable" }, campaignId: null, at: now },
  "contact.created": { contact },
  "contact.updated": { contact, changed: ["tags"] },
  "contact.unsubscribed": { channel: "email", email: contact.email, contactId: contact.id, campaignId: "9a2b3c4d-0000-4000-8000-000000000005", at: now },
  "campaign.completed": { channel: "email", campaignId: "9a2b3c4d-0000-4000-8000-000000000005", name: "Diwali sale", recipients: 1200, sent: 1188, delivered: 1180, failed: 12, opened: 640, clicked: 210, completedAt: now },
  "email.opened": { campaignId: "9a2b3c4d-0000-4000-8000-000000000005", email: contact.email, contactId: contact.id, at: now },
  "email.clicked": { campaignId: "9a2b3c4d-0000-4000-8000-000000000005", email: contact.email, contactId: contact.id, url: "https://shop.example.com/sale", at: now },
  "email.bounced": { campaignId: "9a2b3c4d-0000-4000-8000-000000000005", email: contact.email, contactId: contact.id, reason: "550 Mailbox does not exist", permanent: true, at: now },
  "sms.delivered": { campaignId: "1e2f3a4b-0000-4000-8000-000000000006", phone: contact.phone, contactId: contact.id, at: now },
  "sms.clicked": { campaignId: "1e2f3a4b-0000-4000-8000-000000000006", phone: contact.phone, contactId: contact.id, url: "https://shop.example.com/sale", at: now },
};

/** The JSON body of every delivery. */
export interface WebhookEnvelope {
  id: string;
  event: WebhookEvent;
  createdAt: string;
  test?: boolean;
  data: Record<string, unknown>;
}
