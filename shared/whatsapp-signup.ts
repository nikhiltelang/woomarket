/**
 * WhatsApp Embedded Signup (Meta's "Connect with Facebook" popup) and Coexistence (a number that
 * stays on the WhatsApp Business app while also using the Cloud API).
 */
import { z } from "zod";

/** Superadmin settings (Meta app used for the signup popup). */
export const signupSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().trim().regex(/^\d{5,25}$/, "The App ID is a number").or(z.literal("")).default(""),
  /** Write-only: blank keeps the saved secret. */
  appSecret: z.string().trim().max(200).optional(),
  configId: z.string().trim().regex(/^\d{5,25}$/, "The configuration ID is a number").or(z.literal("")).default(""),
  /** Offer "Connect your WhatsApp Business app number" (Coexistence). */
  coexistence: z.boolean().default(true),
});
export type SignupSettingsInput = z.infer<typeof signupSettingsSchema>;

/** What the tenant's browser needs to open the popup. */
export interface PublicSignupConfig {
  enabled: boolean;
  appId: string | null;
  configId: string | null;
  graphVersion: string;
  coexistence: boolean;
  /** No Meta app set up on a development server: the flow is simulated. */
  simulated: boolean;
}

export const SIGNUP_MODES = ["cloud", "coexistence"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** Sent by the browser once the popup finishes. */
export const completeSignupSchema = z.object({
  code: z.string().trim().min(1).max(2000),
  wabaId: z.string().trim().regex(/^\d{5,25}$/, "Invalid WhatsApp Business Account id"),
  phoneNumberId: z.string().trim().regex(/^\d{5,25}$/, "Invalid phone number id"),
  businessId: z.string().trim().regex(/^\d{5,25}$/).optional(),
  mode: z.enum(SIGNUP_MODES),
  name: z.string().trim().max(100).optional(),
});
export type CompleteSignupInput = z.infer<typeof completeSignupSchema>;

/** Session events Meta posts to the page (`type: "WA_EMBEDDED_SIGNUP"`). */
export const SIGNUP_FINISH_EVENTS = ["FINISH", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_ONLY_WABA"] as const;

/** Onboarding progress stored on the channel (Coexistence syncs). */
export interface ChannelOnboarding {
  mode: SignupMode;
  onboardedAt: string;
  businessId?: string | null;
  contacts?: { requestedAt: string; requestId?: string | null; imported: number; error?: string | null };
  history?: { requestedAt: string; requestId?: string | null; imported: number; phase?: number | null; progress?: number | null; declined?: boolean; error?: string | null };
}

/** Meta only accepts the contact / history sync within 24 hours of onboarding. */
export const COEXISTENCE_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Coexistence numbers have a fixed throughput (messages per second). */
export const COEXISTENCE_MPS = 20;

/** Webhook fields the Meta app must be subscribed to. */
export const WEBHOOK_FIELDS = ["messages", "message_template_status_update", "history", "smb_app_state_sync", "smb_message_echoes"] as const;
