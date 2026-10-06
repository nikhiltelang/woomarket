import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { FileText, Inbox, Megaphone, Users } from "lucide-react";
import type { Campaign } from "@shared/schema";
import { useChannel } from "@/contexts/channel";
import { useAuth } from "@/contexts/auth";
import { PageContainer } from "@/components/layout/app-layout";
import { Card, CardHeader, EmptyState, ErrorState, PageHeader, PageLoader, ProgressBar, StatCard, StatusBadge } from "@/components/ui/display";
import { cn, displayName, formatDay, formatNumber } from "@/lib/utils";

interface DayPoint {
  day: string;
  inbound: number;
  outbound: number;
}

interface Stats {
  contacts: number;
  openConversations: number;
  unreadMessages: number;
  templates: { total: number; approved: number; pending: number };
  messages: { sent7d: number; received7d: number; daily: DayPoint[] };
  recentCampaigns: Campaign[];
}

const SERIES = [
  { key: "inbound" as const, label: "Received", color: "bg-series-1" },
  { key: "outbound" as const, label: "Sent", color: "bg-series-2" },
];

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** Grouped bars: received vs sent per day. One axis, legend + per-day tooltip, table for screen readers. */
function MessagesChart({ data }: { data: DayPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.flatMap((d) => [d.inbound, d.outbound]));
  const ticks = [max, Math.round(max / 2), 0];
  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-xs text-fg-muted" aria-hidden>
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={cn("h-2.5 w-2.5 rounded-sm", s.color)} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="flex gap-2" aria-hidden>
        <div className="flex h-44 flex-col justify-between pb-5 text-right text-[11px] text-fg-muted tabular-nums">
          {ticks.map((t, i) => (
            <span key={i}>{formatNumber(t)}</span>
          ))}
        </div>
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 bottom-5 flex flex-col justify-between">
            {ticks.map((_, i) => (
              <div key={i} className="border-t border-border/70" />
            ))}
          </div>
          <div className="relative flex h-44 items-stretch">
            {data.map((d, i) => (
              <div
                key={d.day}
                className="relative flex flex-1 flex-col"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <div className={cn("flex flex-1 items-end justify-center gap-[2px] rounded-t-sm pb-0", hover === i && "bg-subtle/70")}>
                  {SERIES.map((s) => (
                    <div
                      key={s.key}
                      className={cn("w-3 rounded-t-[4px] sm:w-4", s.color)}
                      style={{ height: `${(d[s.key] / max) * 100}%`, minHeight: d[s.key] ? 2 : 0 }}
                    />
                  ))}
                </div>
                <span className="h-5 pt-1 text-center text-[11px] text-fg-muted">{weekday.format(new Date(`${d.day}T00:00:00Z`))}</span>
                {hover === i && (
                  <div className="absolute bottom-full left-1/2 z-10 mb-1 w-36 -translate-x-1/2 rounded-md border border-border bg-surface p-2 text-xs shadow-lg">
                    <p className="mb-1 font-medium">{formatDay(`${d.day}T12:00:00Z`)}</p>
                    {SERIES.map((s) => (
                      <p key={s.key} className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-fg-muted">
                          <span className={cn("h-2 w-2 rounded-sm", s.color)} />
                          {s.label}
                        </span>
                        <span className="font-medium tabular-nums">{formatNumber(d[s.key])}</span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>Messages per day, last 7 days</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Received</th>
            <th>Sent</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.inbound}</td>
              <td>{d.outbound}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const { activeChannel } = useChannel();
  const { user, can } = useAuth();
  const { data, isLoading, error, refetch } = useQuery<{ data: Stats }>({
    queryKey: ["/api/dashboard/stats", { channelId: activeChannel!.id }],
    refetchInterval: 60_000,
  });

  if (isLoading) return <PageLoader />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const s = data.data;

  return (
    <PageContainer>
      <PageHeader title={`Welcome back, ${displayName(user!)}`} description={`${activeChannel!.name}${activeChannel!.phoneNumber ? ` · ${activeChannel!.phoneNumber}` : ""}`} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Contacts" value={formatNumber(s.contacts)} icon={<Users className="h-4 w-4" />} />
        <StatCard label="Open conversations" value={formatNumber(s.openConversations)} hint={`${formatNumber(s.unreadMessages)} unread messages`} icon={<Inbox className="h-4 w-4" />} />
        <StatCard label="Messages (7 days)" value={formatNumber(s.messages.sent7d + s.messages.received7d)} hint={`${formatNumber(s.messages.sent7d)} sent · ${formatNumber(s.messages.received7d)} received`} icon={<Megaphone className="h-4 w-4" />} />
        <StatCard label="Approved templates" value={formatNumber(s.templates.approved)} hint={s.templates.pending ? `${s.templates.pending} awaiting approval` : `${s.templates.total} total`} icon={<FileText className="h-4 w-4" />} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Message volume" description="Last 7 days" />
          <div className="p-5">
            {s.messages.sent7d + s.messages.received7d === 0 ? (
              <EmptyState title="No messages yet" description="Messages you send and receive will show up here." />
            ) : (
              <MessagesChart data={s.messages.daily} />
            )}
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent campaigns"
            actions={
              can("campaigns:view") && (
                <Link href="/campaigns" className="text-xs font-medium text-primary hover:underline">
                  View all
                </Link>
              )
            }
          />
          {s.recentCampaigns.length === 0 ? (
            <EmptyState title="No campaigns yet" description="Broadcast an approved template to your contacts." />
          ) : (
            <ul className="divide-y divide-border">
              {s.recentCampaigns.map((c) => {
                const pct = c.recipientCount ? ((c.sentCount ?? 0) + (c.failedCount ?? 0)) / c.recipientCount * 100 : 0;
                return (
                  <li key={c.id} className="px-5 py-3">
                    <Link href={`/analytics/campaign/${c.id}`} className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium">{c.name}</span>
                      <StatusBadge status={c.status} />
                    </Link>
                    <div className="mt-2 flex items-center gap-3">
                      <ProgressBar value={pct} />
                      <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                        {formatNumber(c.deliveredCount)} / {formatNumber(c.recipientCount)} delivered
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
