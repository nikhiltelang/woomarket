import { randomUUID } from "node:crypto";
import type { Channel, Template } from "@shared/schema";
import { apiLogs } from "@shared/schema";
import { config } from "../../config";
import { db } from "../../db";
import { channelAccessToken } from "../../repositories/channels.repository";
import { childLogger } from "../../lib/logger";
import { countTemplateVariables } from "../../repositories/templates.repository";
import { toWaId, WhatsAppApiError, type HealthResult, type InteractiveMessage, type RemoteTemplate, type SendResult, type WhatsAppClient } from "./types";

const log = childLogger("whatsapp-meta");
const TIMEOUT_MS = 15_000;

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

/** WhatsApp Business Cloud API (Meta Graph API) client for one channel. */
export class MetaCloudClient implements WhatsAppClient {
  readonly kind = "meta" as const;
  private readonly base = `${config.WHATSAPP_GRAPH_URL}/${config.WHATSAPP_API_VERSION}`;

  constructor(private readonly channel: Channel) {}

  private async call<T>(requestType: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const url = `${this.base}/${path}`;
    const started = Date.now();
    let status: number | undefined;
    let json: unknown;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${channelAccessToken(this.channel)}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = (json as GraphError).error ?? {};
        const detail = e.error_data?.details ? ` (${e.error_data.details})` : "";
        throw new WhatsAppApiError(`${e.message ?? `Meta API error ${res.status}`}${detail}`, e.code, res.status, json);
      }
      return json as T;
    } catch (err) {
      if (err instanceof WhatsAppApiError) throw err;
      throw new WhatsAppApiError(`Could not reach the WhatsApp API: ${(err as Error).message}`);
    } finally {
      void this.logCall(requestType, method, path, body, status, json, Date.now() - started);
    }
  }

  private async logCall(
    requestType: string,
    method: string,
    endpoint: string,
    requestBody: unknown,
    responseStatus: number | undefined,
    responseBody: unknown,
    duration: number,
  ) {
    try {
      await db.insert(apiLogs).values({
        id: randomUUID(),
        channelId: this.channel.id,
        requestType,
        endpoint,
        method,
        requestBody: requestBody ?? null,
        responseStatus: responseStatus ?? null,
        responseBody: responseBody ?? null,
        duration,
      });
    } catch (err) {
      log.debug({ err: (err as Error).message }, "api_logs insert failed");
    }
  }

  private async send(payload: Record<string, unknown>): Promise<SendResult> {
    const res = await this.call<{ messages?: { id: string }[] }>("send_message", "POST", `${this.channel.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...payload,
    });
    const id = res.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError("Meta did not return a message id");
    return { messageId: id };
  }

  sendText(to: string, text: string) {
    return this.send({ to: toWaId(to), type: "text", text: { body: text, preview_url: false } });
  }

  sendInteractive(to: string, m: InteractiveMessage) {
    const interactive =
      m.kind === "buttons"
        ? { type: "button", body: { text: m.text }, action: { buttons: m.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) } }
        : {
            type: "list",
            body: { text: m.text },
            action: { button: m.button, sections: [{ rows: m.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) }] },
          };
    return this.send({ to: toWaId(to), type: "interactive", interactive });
  }

  sendTemplate(to: string, t: { name: string; language: string; params: string[] }) {
    const components = t.params.length
      ? [{ type: "body", parameters: t.params.map((p) => ({ type: "text", text: p })) }]
      : [];
    return this.send({ to: toWaId(to), type: "template", template: { name: t.name, language: { code: t.language }, components } });
  }

  private waba(): string {
    if (!this.channel.whatsappBusinessAccountId) throw new WhatsAppApiError("Channel has no WhatsApp Business Account ID");
    return this.channel.whatsappBusinessAccountId;
  }

  async submitTemplate(t: Template) {
    const components: Record<string, unknown>[] = [];
    if (t.header) components.push({ type: "HEADER", format: "TEXT", text: t.header });
    const vars = countTemplateVariables(t.body);
    components.push({
      type: "BODY",
      text: t.body,
      ...(vars ? { example: { body_text: [Array.from({ length: vars }, (_, i) => `sample${i + 1}`)] } } : {}),
    });
    if (t.footer) components.push({ type: "FOOTER", text: t.footer });
    if (t.buttons?.length) {
      components.push({
        type: "BUTTONS",
        buttons: t.buttons.map((b) =>
          b.type === "URL"
            ? { type: "URL", text: b.text, url: b.url }
            : b.type === "PHONE_NUMBER"
              ? { type: "PHONE_NUMBER", text: b.text, phone_number: b.phoneNumber }
              : { type: "QUICK_REPLY", text: b.text },
        ),
      });
    }
    const res = await this.call<{ id: string; status: string }>("create_template", "POST", `${this.waba()}/message_templates`, {
      name: t.name,
      language: t.language ?? "en_US",
      category: t.category,
      components,
    });
    return { id: res.id, status: res.status.toLowerCase() };
  }

  async listTemplates(): Promise<RemoteTemplate[]> {
    const out: RemoteTemplate[] = [];
    let path: string | null = `${this.waba()}/message_templates?limit=100`;
    for (let page = 0; path && page < 20; page++) {
      const res: { data: any[]; paging?: { next?: string; cursors?: { after?: string } } } = await this.call(
        "list_templates",
        "GET",
        path,
      );
      for (const t of res.data ?? []) {
        const comp = (type: string) => (t.components ?? []).find((c: any) => c.type === type);
        out.push({
          id: String(t.id),
          name: t.name,
          language: t.language,
          status: String(t.status ?? "").toLowerCase(),
          category: t.category,
          header: comp("HEADER")?.format === "TEXT" ? (comp("HEADER")?.text ?? null) : null,
          body: comp("BODY")?.text ?? "",
          footer: comp("FOOTER")?.text ?? null,
          buttons: (comp("BUTTONS")?.buttons ?? []).map((b: any) => ({
            type: b.type,
            text: b.text,
            url: b.url,
            phoneNumber: b.phone_number,
          })),
          rejectionReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
        });
      }
      const after = res.paging?.next ? res.paging.cursors?.after : undefined;
      path = after ? `${this.waba()}/message_templates?limit=100&after=${encodeURIComponent(after)}` : null;
    }
    return out;
  }

  async deleteTemplate(name: string) {
    await this.call("delete_template", "DELETE", `${this.waba()}/message_templates?name=${encodeURIComponent(name)}`);
  }

  async checkHealth(): Promise<HealthResult> {
    try {
      const res = await this.call<Record<string, unknown>>(
        "health_check",
        "GET",
        `${this.channel.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`,
      );
      const quality = String(res.quality_rating ?? "UNKNOWN");
      return {
        status: quality === "RED" ? "error" : quality === "YELLOW" ? "warning" : "healthy",
        details: {
          displayPhoneNumber: res.display_phone_number,
          verifiedName: res.verified_name,
          qualityRating: quality,
          messagingLimitTier: res.messaging_limit_tier,
          phoneStatus: res.status,
        },
      };
    } catch (err) {
      return { status: "error", details: { error: (err as Error).message } };
    }
  }
}
