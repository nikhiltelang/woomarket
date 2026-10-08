import { randomUUID } from "node:crypto";
import type { Channel, Template } from "@shared/schema";
import { childLogger } from "../../lib/logger";
import { toWaId, type HealthResult, type RemoteTemplate, type SendResult, type WhatsAppClient } from "./types";

const log = childLogger("whatsapp-simulator");

type PayloadSink = (payload: unknown) => Promise<void>;
let sink: PayloadSink | null = null;

/** The webhook handler registers itself so simulated events take the same path as Meta's. */
export function setSimulatorSink(fn: PayloadSink) {
  sink = fn;
}

/** Builds a Meta-shaped webhook payload for a channel. */
export function buildWebhookPayload(channel: Channel, value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: channel.whatsappBusinessAccountId ?? "simulator",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: channel.phoneNumber ?? "", phone_number_id: channel.phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

/** Delivers a webhook payload to the handler after a delay (simulated Meta callbacks). */
export function emitSimulated(delayMs: number, payload: unknown) {
  emitLater(delayMs, payload);
}

function emitLater(delayMs: number, payload: unknown) {
  const t = setTimeout(() => {
    sink?.(payload).catch((err) => log.warn({ err: (err as Error).message }, "Simulated webhook failed"));
  }, delayMs);
  t.unref();
}

/**
 * Local stand-in for the Cloud API: accepts sends, returns message ids and plays back
 * sent → delivered → read status webhooks. Recipients whose number ends in 0000 fail,
 * which exercises the failure / retry paths.
 */
export class SimulatorClient implements WhatsAppClient {
  readonly kind = "simulator" as const;
  constructor(private readonly channel: Channel) {}

  private accept(to: string): SendResult {
    const messageId = `wamid.SIM.${randomUUID().replace(/-/g, "")}`;
    const recipient = toWaId(to);
    const status = (s: string, extra: Record<string, unknown> = {}) =>
      buildWebhookPayload(this.channel, {
        statuses: [{ id: messageId, status: s, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: recipient, ...extra }],
      });
    if (recipient.endsWith("0000")) {
      emitLater(800, status("failed", { errors: [{ code: 131026, title: "Message undeliverable (simulated)" }] }));
    } else {
      emitLater(300, status("sent"));
      emitLater(1500, status("delivered"));
      emitLater(4000, status("read"));
    }
    return { messageId };
  }

  async sendText(to: string) {
    return this.accept(to);
  }

  async sendInteractive(to: string) {
    return this.accept(to);
  }

  async sendTemplate(to: string) {
    return this.accept(to);
  }

  async submitTemplate(t: Template) {
    const id = `sim_${randomUUID().slice(0, 8)}`;
    emitLater(1500, {
      object: "whatsapp_business_account",
      entry: [
        {
          id: this.channel.whatsappBusinessAccountId ?? "simulator",
          changes: [
            {
              field: "message_template_status_update",
              value: { event: "APPROVED", message_template_id: id, message_template_name: t.name, reason: "NONE" },
            },
          ],
        },
      ],
    });
    return { id, status: "pending" };
  }

  async listTemplates(): Promise<RemoteTemplate[]> {
    return [];
  }

  async deleteTemplate() {}

  async checkHealth(): Promise<HealthResult> {
    return {
      status: "healthy",
      details: { qualityRating: "GREEN", messagingLimitTier: "TIER_1K", displayPhoneNumber: this.channel.phoneNumber, simulator: true },
    };
  }
}
