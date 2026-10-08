/**
 * Instagram Direct and Facebook Messenger, alongside WhatsApp in the shared inbox.
 */
import { z } from "zod";

export const SOCIAL_PLATFORMS = ["messenger", "instagram"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const isSocialType = (t: string | null | undefined): t is SocialPlatform => t === "messenger" || t === "instagram";

export const SOCIAL_LABELS: Record<SocialPlatform, string> = { messenger: "Messenger", instagram: "Instagram" };

/** Both platforms only allow free-form replies within 24 hours of the customer's last message. */
export const SOCIAL_WINDOW_MS = 24 * 3600_000;
/** With Meta's Human Agent permission, a person may reply for up to 7 days. */
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 3600_000;

export const connectPageSchema = z.object({
  channelId: z.string().uuid(),
  pageId: z.string().trim().regex(/^\d{5,30}$/, "The Page ID is a number (Page → About → Page transparency, or Meta Business Suite settings)"),
  /** Page access token, or "simulator" for a test connection without Meta. */
  accessToken: z.string().trim().min(8, "Paste the Page access token").max(1000),
  messenger: z.boolean().default(true),
  instagram: z.boolean().default(true),
  /** The app has Meta's Human Agent permission: replies allowed for 7 days. */
  humanAgentTag: z.boolean().default(false),
});

export const updateSocialAccountSchema = z.object({
  channelId: z.string().uuid().optional(),
  enabled: z.boolean().optional(),
  humanAgentTag: z.boolean().optional(),
  accessToken: z.string().trim().min(8).max(1000).optional(),
});

export const simulateInboundSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  /** Simulated sender id; the same id continues the same conversation. */
  senderId: z.string().trim().regex(/^\d{5,30}$/).optional(),
  name: z.string().trim().max(60).optional(),
});

export interface PublicSocialAccount {
  id: string;
  platform: SocialPlatform;
  channelId: string;
  pageId: string;
  externalId: string;
  name: string;
  username: string | null;
  pictureUrl: string | null;
  simulated: boolean;
  humanAgentTag: boolean;
  enabled: boolean;
  status: string;
  lastError: string | null;
  connectedAt: string | null;
}
