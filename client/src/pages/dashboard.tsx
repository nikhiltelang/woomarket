import { Link } from "wouter";
import { ArrowRight, CircleAlert, CircleCheck, Inbox, Plus } from "lucide-react";
import { useAuth } from "@/contexts/auth";
import { cn, displayName, formatDay, formatNumber, relativeTime } from "@/lib/utils";
import { CHANNELS, ChannelIcon, channelMeta, type ChannelMeta, type ChannelStats, type MarketingChannel, type MarketingOverview } from "@/lib/channels";
import { useMarketingOverview } from "@/components/channel-shell";
import { BarChart } from "@/components/charts";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, ErrorState, PageHeader, PageLoader, ProgressBar, StatusBadge } from "@/components/ui/display";

const SEND_PERMISSION: Record<MarketingChannel, string> = { whatsapp: "campaigns:create", email: "email:send", sms: "sms:send" };
const CAMPAIGNS_HREF: Record<MarketingChannel, string> = { whatsapp: "/campaigns", email: "/email-marketing/campaigns", sms: "/sms-marketing/campaigns" };

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="text-right">
        <span className="font-medium tabular-nums">{value}</span>
        {hint && <span className="ml-1.5 text-xs text-fg-muted tabular-nums">{hint}</span>}
      </dd>
    </div>
  );
}

/** One card per channel, identical layout, so no channel reads as the main one. */
function ChannelCard({ meta, s, days }: { meta: ChannelMeta; s: ChannelStats; days: number }) {
  const { can } = useAuth();
  const canSend = can(SEND_PERMISSION[meta.key]);
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <ChannelIcon channel={meta.key} />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{meta.title}</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-muted">
            {s.ready ? <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" /> : <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />}
            <span className="truncate">{s.detail}</span>
          </p>
        </div>
      </div>
      <div className="px-5 pt-4">
        <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">{meta.sentLabel} · {days} days</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{formatNumber(s.sent)}</p>
      </div>
      <dl className="divide-y divide-border px-5 pt-2 pb-3">
        <Metric label="Campaigns" value={formatNumber(s.campaigns)} hint={`${formatNumber(s.recipients)} recipients`} />
        <Metric label="Delivery rate" value={`${s.deliveryRate}%`} hint={`${formatNumber(s.delivered)} delivered`} />
        {meta.engagementLabel ? (
          <Metric label={meta.engagementLabel} value={`${s.engagementRate ?? 0}%`} hint={`${formatNumber(s.engaged)} ${meta.key === "email" ? "opens" : "read"}`} />
        ) : (
          <Metric label="Credits used" value={formatNumber(s.credits)} />
        )}
        <Metric label="Failed" value={formatNumber(s.failed)} />
      </dl>
      {meta.key === "whatsapp" && can("inbox:view") && s.ready && (
        <Link href="/inbox" className="mx-5 mb-3 flex items-center gap-2 rounded-md bg-subtle px-3 py-2 text-xs hover:bg-border/60">
          <Inbox className="h-3.5 w-3.5 text-fg-muted" />
          <span>
            {formatNumber(s.openConversations)} open conversation{s.openConversations === 1 ? "" : "s"}
            {s.unreadMessages ? ` · ${formatNumber(s.unreadMessages)} unread` : ""}
          </span>
        </Link>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
        {s.ready ? (
          canSend ? (
            <Link href={meta.newCampaignHref}>
              <Button size="sm"><Plus className="h-3.5 w-3.5" /> New campaign</Button>
            </Link>
          ) : (
            <span />
          )
        ) : can("settings:view") ? (
          <Link href={meta.setupHref}>
            <Button size="sm" variant="outline">Set up {meta.label}</Button>
          </Link>
        ) : (
          <span className="text-xs text-fg-muted">Ask your administrator to set this up.</span>
        )}
        <Link href={CAMPAIGNS_HREF[meta.key]} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          Open {meta.label} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </Card>
  );
}

function AudienceCard({ audience }: { audience: NonNullable<MarketingOverview["audience"]> }) {
  const rows = [
    { key: "phone", label: "Have a phone number", reach: "WhatsApp & SMS", value: audience.withPhone, bars: ["whatsapp", "sms"] as MarketingChannel[] },
    { key: "email", label: "Have an email address", reach: "Email", value: audience.withEmail, bars: ["email"] as MarketingChannel[] },
  ];
  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Audience"
        description="Who each channel can reach"
        actions={<Link href="/contacts" className="text-xs font-medium text-primary hover:underline">Contacts</Link>}
      />
      <div className="p-5">
        <p className="text-3xl font-semibold tabular-nums">{formatNumber(audience.total)}</p>
        <p className="text-xs text-fg-muted">contacts in total</p>
        <ul className="mt-5 space-y-4">
          {rows.map((r) => {
            const pct = audience.total ? Math.round((r.value / audience.total) * 100) : 0;
            return (
              <li key={r.key}>
                <div className="mb-1.5 flex items-end justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="block">{r.label}</span>
                    <span className="block text-xs text-fg-muted">Reachable on {r.reach}</span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap tabular-nums">
                    {formatNumber(r.value)} <span className="text-xs text-fg-muted">({pct}%)</span>
                  </span>
                </div>
                <div className="flex h-2 gap-[2px] overflow-hidden rounded-full bg-subtle" aria-hidden>
                  <div className="flex h-full" style={{ width: `${pct}%` }}>
                    {r.bars.map((b) => (
                      <div key={b} className={cn("h-full flex-1", channelMeta(b).color)} />
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

const dayLabel = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export default function Dashboard() {
  const { user, can } = useAuth();
  const { data, isLoading, error, refetch } = useMarketingOverview();
  if (isLoading) return <PageLoader />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const o = data.data;
  const visible = CHANNELS.filter((c) => o.channels[c.key]);
  const totalSent = o.daily.reduce((a, d) => a + visible.reduce((b, c) => b + (d[c.key] ?? 0), 0), 0);
  const cols = visible.length === 3 ? "lg:grid-cols-3" : visible.length === 2 ? "md:grid-cols-2" : "";

  return (
    <PageContainer wide>
      <PageHeader title={`Welcome back, ${displayName(user!)}`} description={`WhatsApp, email and SMS side by side · last ${o.days} days`} />

      {visible.length === 0 ? (
        <Card>
          <EmptyState title="No marketing channels available" description="Ask your administrator for access to WhatsApp, email or SMS marketing." />
        </Card>
      ) : (
        <div className={cn("grid gap-4", cols)}>
          {visible.map((meta) => (
            <ChannelCard key={meta.key} meta={meta} s={o.channels[meta.key]!} days={o.days} />
          ))}
        </div>
      )}

      <div className={cn("mt-6 grid gap-6", o.audience && "lg:grid-cols-3")}>
        <Card className={cn(o.audience && "lg:col-span-2")}>
          <CardHeader title="Messages sent by channel" description={`Last ${o.chartDays} days`} />
          <div className="p-5">
            {totalSent === 0 ? (
              <EmptyState title="Nothing sent yet" description="Messages sent on any channel show up here." />
            ) : (
              <BarChart
                data={o.daily as Record<string, number | string>[]}
                labelKey="day"
                series={visible.map((c) => ({ key: c.key, label: c.label, color: c.color }))}
                formatLabel={(d) => dayLabel.format(new Date(`${d}T12:00:00Z`))}
                formatTooltipLabel={(d) => formatDay(`${d}T12:00:00Z`)}
                caption="Messages sent per day by channel"
              />
            )}
          </div>
        </Card>
        {o.audience && <AudienceCard audience={o.audience} />}
      </div>

      <Card className="mt-6">
        <CardHeader title="Recent campaigns" description="Across every channel" />
        {o.recentCampaigns.length === 0 ? (
          <EmptyState title="No campaigns yet" description="Start one on WhatsApp, email or SMS." />
        ) : (
          <ul className="divide-y divide-border">
            {o.recentCampaigns.map((c) => {
              const meta = channelMeta(c.channel);
              const pct = c.recipients ? (c.delivered / c.recipients) * 100 : 0;
              const href = c.channel === "whatsapp" && can("campaigns:view") ? `/analytics/campaign/${c.id}` : CAMPAIGNS_HREF[c.channel];
              return (
                <li key={`${c.channel}-${c.id}`}>
                  <Link href={href} className="grid items-center gap-3 px-5 py-3 hover:bg-subtle/50 sm:grid-cols-[minmax(0,1fr)_10rem_minmax(0,14rem)]">
                    <span className="flex min-w-0 items-center gap-3">
                      <ChannelIcon channel={c.channel} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        <span className="block text-xs text-fg-muted">{meta.label} · {relativeTime(c.createdAt)}</span>
                      </span>
                    </span>
                    <span><StatusBadge status={c.status} /></span>
                    <span className="flex items-center gap-3">
                      <ProgressBar value={pct} />
                      <span className="shrink-0 text-xs text-fg-muted tabular-nums">{formatNumber(c.delivered)} / {formatNumber(c.recipients)}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
