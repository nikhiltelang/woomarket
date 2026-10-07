import { Mail, MessageCircle, MessageSquareText, type LucideIcon } from "lucide-react";

export type MarketingChannel = "whatsapp" | "email" | "sms";

export interface ChannelMeta {
  key: MarketingChannel;
  label: string;
  /** Full name used in page titles and the sidebar. */
  title: string;
  icon: LucideIcon;
  /** Chart/legend colour; fixed per channel so it never changes with filters. */
  color: string;
  /** Tinted background for the channel's icon tile. */
  tint: string;
  /** What "engagement" means for this channel, or null when there's no signal. */
  engagementLabel: string | null;
  sentLabel: string;
  setupHref: string;
  newCampaignHref: string;
}

/** Listed in the same order everywhere (sidebar, dashboard, charts). */
export const CHANNELS: ChannelMeta[] = [
  {
    key: "whatsapp",
    label: "WhatsApp",
    title: "WhatsApp marketing",
    icon: MessageCircle,
    color: "bg-series-3",
    tint: "bg-series-3/15",
    engagementLabel: "Read rate",
    sentLabel: "Messages sent",
    setupHref: "/settings",
    newCampaignHref: "/campaigns?new=1",
  },
  {
    key: "email",
    label: "Email",
    title: "Email marketing",
    icon: Mail,
    color: "bg-series-1",
    tint: "bg-series-1/15",
    engagementLabel: "Open rate",
    sentLabel: "Emails sent",
    setupHref: "/email-marketing/settings",
    newCampaignHref: "/email-marketing/campaigns?new=1",
  },
  {
    key: "sms",
    label: "SMS",
    title: "SMS marketing",
    icon: MessageSquareText,
    color: "bg-series-2",
    tint: "bg-series-2/15",
    engagementLabel: null,
    sentLabel: "Texts sent",
    setupHref: "/sms-marketing/settings",
    newCampaignHref: "/sms-marketing/campaigns?new=1",
  },
];

export const channelMeta = (key: MarketingChannel) => CHANNELS.find((c) => c.key === key)!;

/** Same view permission the server applies to the overview. */
export const CHANNEL_PERMISSIONS: Record<MarketingChannel, string[]> = {
  whatsapp: ["campaigns:view", "inbox:view"],
  email: ["email:view"],
  sms: ["sms:view"],
};

export interface ChannelStats {
  ready: boolean;
  detail: string;
  campaigns: number;
  recipients: number;
  sent: number;
  delivered: number;
  engaged: number;
  failed: number;
  deliveryRate: number;
  engagementRate: number | null;
  credits?: number;
  openConversations?: number;
  unreadMessages?: number;
}

export interface MarketingOverview {
  days: number;
  chartDays: number;
  audience: { total: number; withPhone: number; withEmail: number } | null;
  channels: Partial<Record<MarketingChannel, ChannelStats>>;
  daily: ({ day: string } & Partial<Record<MarketingChannel, number>>)[];
  recentCampaigns: { id: string; channel: MarketingChannel; name: string; status: string; recipients: number; delivered: number; createdAt: string }[];
}

export const OVERVIEW_KEY = "/api/dashboard/overview";

export function ChannelIcon({ channel, size = "md" }: { channel: MarketingChannel; size?: "sm" | "md" | "lg" }) {
  const m = channelMeta(channel);
  const Icon = m.icon;
  const box = size === "lg" ? "h-10 w-10" : size === "sm" ? "h-6 w-6" : "h-8 w-8";
  const glyph = size === "lg" ? "h-5 w-5" : size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-lg ${box} ${m.tint}`} aria-hidden>
      <Icon className={glyph} />
    </span>
  );
}
