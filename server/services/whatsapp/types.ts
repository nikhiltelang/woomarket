import type { Template } from "@shared/schema";

export interface SendResult {
  messageId: string;
}

export interface RemoteTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  header: string | null;
  body: string;
  footer: string | null;
  buttons: { type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER"; text: string; url?: string; phoneNumber?: string }[];
  rejectionReason: string | null;
}

export interface HealthResult {
  status: "healthy" | "warning" | "error";
  details: Record<string, unknown>;
}

/** Interactive reply message: up to 3 reply buttons, or a list of up to 10 rows. */
export type InteractiveMessage =
  | { kind: "buttons"; text: string; buttons: { id: string; title: string }[] }
  | { kind: "list"; text: string; button: string; rows: { id: string; title: string; description?: string }[] };

/** Provider-agnostic WhatsApp Business operations for one channel. */
export interface WhatsAppClient {
  readonly kind: "meta" | "simulator";
  sendText(to: string, text: string): Promise<SendResult>;
  sendTemplate(to: string, t: { name: string; language: string; params: string[] }): Promise<SendResult>;
  /** Buttons / list message (only inside the 24-hour customer service window). */
  sendInteractive(to: string, m: InteractiveMessage): Promise<SendResult>;
  submitTemplate(t: Template): Promise<{ id: string; status: string }>;
  listTemplates(): Promise<RemoteTemplate[]>;
  deleteTemplate(name: string): Promise<void>;
  checkHealth(): Promise<HealthResult>;
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number | string,
    public readonly httpStatus?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }

  /** Errors worth retrying: rate limits, Meta-side throttling and server errors. */
  get retryable(): boolean {
    const throttling = [4, 80007, 130429, 131048, 131056];
    return (this.httpStatus ?? 0) >= 500 || throttling.includes(Number(this.code)) || this.httpStatus === undefined;
  }
}

/** Meta expects the recipient as digits only (country code included). */
export const toWaId = (phone: string) => phone.replace(/\D/g, "");
