import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useAuth } from "@/contexts/auth";
import { cn, formatNumber } from "@/lib/utils";
import { ChannelIcon, channelMeta, OVERVIEW_KEY, type MarketingChannel, type MarketingOverview } from "@/lib/channels";
import { PageContainer } from "@/components/layout/app-layout";
import { StatCard } from "@/components/ui/display";

interface ShellTab {
  href: string;
  label: string;
  permission?: string;
  badge?: number;
}

/** The sections of each channel, in the same order: activity, content, setup. */
export const CHANNEL_TABS: Record<MarketingChannel, ShellTab[]> = {
  whatsapp: [
    { href: "/campaigns", label: "Campaigns", permission: "campaigns:view" },
    { href: "/templates", label: "Templates", permission: "templates:view" },
    { href: "/inbox", label: "Inbox", permission: "inbox:view" },
    { href: "/settings", label: "Settings", permission: "settings:view" },
  ],
  email: [
    { href: "/email-marketing/campaigns", label: "Campaigns", permission: "email:view" },
    { href: "/email-marketing/templates", label: "Templates", permission: "email:view" },
    { href: "/email-marketing/settings", label: "Settings", permission: "email:view" },
  ],
  sms: [
    { href: "/sms-marketing/campaigns", label: "Campaigns", permission: "sms:view" },
    { href: "/sms-marketing/settings", label: "Settings", permission: "sms:view" },
  ],
};

export function useMarketingOverview(enabled = true) {
  return useQuery<{ data: MarketingOverview }>({ queryKey: [OVERVIEW_KEY], refetchInterval: 15_000, enabled });
}

/**
 * Common frame for WhatsApp, email and SMS pages: the same header, status, four
 * headline numbers and section tabs, so no channel looks secondary to another.
 */
export function ChannelShell({ channel, description, actions, children }: { channel: MarketingChannel; description: string; actions?: ReactNode; children: ReactNode }) {
  const meta = channelMeta(channel);
  const { can } = useAuth();
  const [location] = useLocation();
  const { data } = useMarketingOverview();
  const s = data?.data.channels[channel];
  const days = data?.data.days ?? 30;
  const tabs = CHANNEL_TABS[channel].filter((t) => !t.permission || can(t.permission));

  return (
    <PageContainer wide>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <ChannelIcon channel={channel} size="lg" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{meta.title}</h1>
            <p className="mt-0.5 text-sm text-fg-muted">{description}</p>
            {s && (
              <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-fg-muted">
                {s.ready ? <CircleCheck className="h-3.5 w-3.5 text-success" /> : <CircleAlert className="h-3.5 w-3.5 text-warning" />}
                {s.detail}
                {!s.ready && can("settings:view") && (
                  <Link href={meta.setupHref} className="font-medium text-primary hover:underline">Set up</Link>
                )}
              </p>
            )}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={`Campaigns (${days} days)`} value={formatNumber(s?.campaigns)} hint={`${formatNumber(s?.recipients)} recipients`} />
        <StatCard label={meta.sentLabel} value={formatNumber(s?.sent)} hint={s?.failed ? `${formatNumber(s.failed)} failed` : "No failures"} />
        <StatCard label="Delivery rate" value={`${s?.deliveryRate ?? 0}%`} hint={`${formatNumber(s?.delivered)} delivered`} />
        {meta.engagementLabel ? (
          <StatCard label={meta.engagementLabel} value={`${s?.engagementRate ?? 0}%`} hint={`${formatNumber(s?.engaged)} ${channel === "email" ? "unique opens" : "read"}`} />
        ) : (
          <StatCard label="Credits used" value={formatNumber(s?.credits)} hint="Message segments billed" />
        )}
      </div>

      {tabs.length > 1 && (
        <nav aria-label={`${meta.title} sections`} className="mb-4 overflow-x-auto">
          <ul className="inline-flex rounded-md border border-border bg-subtle p-0.5">
            {tabs.map((t) => {
              const active = location === t.href || location.startsWith(`${t.href}/`);
              return (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    aria-current={active ? "page" : undefined}
                    className={cn("inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors", active ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}
                  >
                    {t.label}
                    {t.href === "/inbox" && s?.unreadMessages ? <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-fg tabular-nums">{s.unreadMessages}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      {children}
    </PageContainer>
  );
}
