import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Ban,
  Building2,
  ChevronRight,
  CreditCard,
  FileCheck2,
  FileText,
  Gauge,
  Mail,
  MailWarning,
  Megaphone,
  MessageSquare,
  MessageSquareText,
  PhoneOff,
  RefreshCw,
  Server,
  ShieldCheck,
  UserCheck,
  Users,
  UsersRound,
  Wifi,
} from "lucide-react";
import { formatDate, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Card, CardHeader, ErrorState, PageHeader, PageLoader, StatusBadge } from "@/components/ui/display";
import { Input, Select } from "@/components/ui/form";
import { BarChart, RankedBars } from "@/components/charts";
import { cn } from "@/lib/utils";

interface Overview {
  version: string;
  users: Record<string, number>;
  totalUsers: number;
  segments: Record<"all" | "active" | "banned" | "email-unverified" | "mobile-unverified" | "with-subscription", number>;
  channels: number;
  messages24h: number;
  activeCampaigns: number;
  onlineAgents: number;
  contacts: number;
  templates: number;
  approvedTemplates: number;
  campaigns: number;
  emailCampaigns: number;
  smsCampaigns: number;
  levels: number;
  plans: number;
  policyPages: number;
  lastUpdate: { status: string; toVersion: string | null; startedAt: string } | null;
}

interface ServerInfo {
  node: string;
  uptimeSeconds: number;
  memoryMb: { rss: number; heapUsed: number };
  database: { ok: boolean; latencyMs: number };
}

type Tone = "info" | "success" | "danger" | "warning" | "primary";
const TONE: Record<Tone, { border: string; tile: string }> = {
  info: { border: "border-info/50", tile: "bg-info-soft text-info" },
  success: { border: "border-success/50", tile: "bg-success-soft text-success" },
  danger: { border: "border-danger/50", tile: "bg-danger-soft text-danger" },
  warning: { border: "border-warning/50", tile: "bg-warning-soft text-warning" },
  primary: { border: "border-primary/50", tile: "bg-primary-soft text-primary" },
};

/** Outlined KPI card with icon tile and a link arrow (top row of the dashboard). */
function KpiCard({ href, label, value, icon, tone }: { href: string; label: string; value: number | undefined; icon: ReactNode; tone: Tone }) {
  return (
    <Link href={href} className={cn("group flex items-center gap-4 rounded-lg border bg-surface p-5 transition-shadow hover:shadow-md", TONE[tone].border)}>
      <span className={cn("flex h-14 w-14 shrink-0 items-center justify-center rounded-lg", TONE[tone].tile)}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fg-muted">{label}</span>
        <span className="block text-2xl font-semibold tabular-nums">{formatNumber(value)}</span>
      </span>
      <ChevronRight className="h-5 w-5 text-fg-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

/** Compact metric row used inside the two summary panels. */
function PanelMetric({ href, label, value, icon, tone }: { href: string; label: string; value: ReactNode; icon: ReactNode; tone: Tone }) {
  return (
    <Link href={href} className="flex items-center gap-3 p-4 hover:bg-subtle/60">
      <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-md", TONE[tone].tile)}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-lg font-semibold tabular-nums">{value}</span>
        <span className="block truncate text-xs text-fg-muted">{label}</span>
      </span>
      <ChevronRight className="h-4 w-4 text-fg-muted" />
    </Link>
  );
}

/** Solid summary tile (bottom rows). */
function Tile({ href, label, value, icon, tone }: { href: string; label: string; value: number | undefined; icon: ReactNode; tone: Tone }) {
  return (
    <Link href={href} className={cn("flex items-center justify-between gap-3 rounded-lg p-5 transition-opacity hover:opacity-90", TONE[tone].tile)}>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-2xl font-semibold tabular-nums">{formatNumber(value)}</span>
      </span>
      <span className="opacity-80">{icon}</span>
    </Link>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shortDay = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const fmtDay = (v: string) => shortDay.format(new Date(`${v}T00:00:00Z`));

function useRange() {
  const [preset, setPreset] = useState("14");
  const [custom, setCustom] = useState({ from: iso(new Date(Date.now() - 13 * 86_400_000)), to: iso(new Date()) });
  const range = useMemo(() => {
    if (preset === "custom") return custom;
    const days = Number(preset);
    return { from: iso(new Date(Date.now() - (days - 1) * 86_400_000)), to: iso(new Date()) };
  }, [preset, custom]);
  const control = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={preset} onChange={(e) => setPreset(e.target.value)} className="h-8 w-36 text-xs" aria-label="Date range">
        <option value="7">Last 7 days</option>
        <option value="14">Last 14 days</option>
        <option value="30">Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="custom">Custom range</option>
      </Select>
      {preset === "custom" && (
        <>
          <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-8 w-36 text-xs" aria-label="From" />
          <Input type="date" value={custom.to} min={custom.from} max={iso(new Date())} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-8 w-36 text-xs" aria-label="To" />
        </>
      )}
    </div>
  );
  return { range, control };
}

const uptime = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

export default function AdminOverview() {
  const o = useQuery<{ data: Overview }>({ queryKey: ["/api/superadmin/dashboard-overview"], refetchInterval: 30_000 });
  const s = useQuery<{ data: ServerInfo }>({ queryKey: ["/api/superadmin/server-info"], refetchInterval: 30_000 });
  const messages = useRange();
  const signups = useRange();
  const msgReport = useQuery<{ data: { day: string; inbound: number; outbound: number; signups: number }[] }>({ queryKey: ["/api/superadmin/reports", messages.range] });
  const signupReport = useQuery<{ data: { day: string; inbound: number; outbound: number; signups: number }[] }>({ queryKey: ["/api/superadmin/reports", signups.range] });
  const logins = useQuery<{ data: { total: number; browsers: { name: string; count: number }[]; os: { name: string; count: number }[] } }>({ queryKey: ["/api/superadmin/login-stats", { days: 30 }] });

  if (o.isLoading) return <PageLoader />;
  if (o.error || !o.data) return <ErrorState error={o.error} onRetry={() => o.refetch()} />;
  const d = o.data.data;
  const seg = d.segments;

  return (
    <PageContainer wide>
      <PageHeader
        title="Dashboard"
        description={`WooMarket360 v${d.version} · ${formatNumber(d.onlineAgents)} online now`}
        actions={
          <Link href="/system-settings/cron" className="inline-flex h-9 items-center gap-2 rounded-md border border-primary px-3 text-sm font-medium text-primary hover:bg-primary-soft">
            <RefreshCw className="h-4 w-4" /> Cron setup
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard href="/users/all" label="Total users" value={seg.all} icon={<Users className="h-6 w-6" />} tone="primary" />
        <KpiCard href="/users/active" label="Active users" value={seg.active} icon={<UserCheck className="h-6 w-6" />} tone="success" />
        <KpiCard href="/users/email-unverified" label="Email unverified users" value={seg["email-unverified"]} icon={<MailWarning className="h-6 w-6" />} tone="danger" />
        <KpiCard href="/users/mobile-unverified" label="Mobile unverified users" value={seg["mobile-unverified"]} icon={<PhoneOff className="h-6 w-6" />} tone="warning" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Messaging" />
          <div className="grid grid-cols-1 divide-border sm:grid-cols-2 sm:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border">
            <PanelMetric href="/channels-management" label="WhatsApp messages (24h)" value={formatNumber(d.messages24h)} icon={<MessageSquare className="h-5 w-5" />} tone="success" />
            <PanelMetric href="/channels-management" label="Connected numbers" value={formatNumber(d.channels)} icon={<Building2 className="h-5 w-5" />} tone="info" />
            <PanelMetric href="/channels-management" label="Active campaigns" value={formatNumber(d.activeCampaigns)} icon={<Megaphone className="h-5 w-5" />} tone="warning" />
            <PanelMetric href="/channels-management" label="Approved templates" value={`${formatNumber(d.approvedTemplates)} / ${formatNumber(d.templates)}`} icon={<FileCheck2 className="h-5 w-5" />} tone="primary" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Marketing & accounts" />
          <div className="grid grid-cols-1 divide-border sm:grid-cols-2 sm:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border">
            <PanelMetric href="/users/all" label="Email campaigns" value={formatNumber(d.emailCampaigns)} icon={<Mail className="h-5 w-5" />} tone="info" />
            <PanelMetric href="/users/all" label="SMS campaigns" value={formatNumber(d.smsCampaigns)} icon={<MessageSquareText className="h-5 w-5" />} tone="warning" />
            <PanelMetric href="/users/with-subscription" label="Users with a subscription" value={formatNumber(seg["with-subscription"])} icon={<CreditCard className="h-5 w-5" />} tone="success" />
            <PanelMetric href="/users/banned" label="Banned users" value={formatNumber(seg.banned)} icon={<Ban className="h-5 w-5" />} tone="danger" />
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile href="/users/all" label="Tenants" value={d.users.admin} icon={<Building2 className="h-6 w-6" />} tone="success" />
        <Tile href="/users/all" label="Team members" value={d.users.team} icon={<UsersRound className="h-6 w-6" />} tone="warning" />
        <Tile href="/manage-levels" label="Access levels" value={d.levels} icon={<Gauge className="h-6 w-6" />} tone="primary" />
        <Tile href="/master-subscriptions" label="Plans" value={d.plans} icon={<CreditCard className="h-6 w-6" />} tone="info" />
        <Tile href="/channels-management" label="Total contacts" value={d.contacts} icon={<Users className="h-6 w-6" />} tone="info" />
        <Tile href="/channels-management" label="WhatsApp campaigns" value={d.campaigns} icon={<Megaphone className="h-6 w-6" />} tone="success" />
        <Tile href="/system-settings/policy-pages" label="Policy pages" value={d.policyPages} icon={<FileText className="h-6 w-6" />} tone="warning" />
        <Tile href="/system-settings" label="Online now" value={d.onlineAgents} icon={<Wifi className="h-6 w-6" />} tone="danger" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="WhatsApp messages report" actions={messages.control} />
          <div className="p-5">
            {msgReport.data ? (
              <BarChart
                data={msgReport.data.data}
                labelKey="day"
                formatLabel={fmtDay}
                caption="WhatsApp messages per day"
                series={[
                  { key: "inbound", label: "Received", color: "bg-series-1" },
                  { key: "outbound", label: "Sent", color: "bg-series-2" },
                ]}
              />
            ) : (
              <PageLoader />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Sign-ups report" description="New accounts per day" actions={signups.control} />
          <div className="p-5">
            {signupReport.data ? (
              <BarChart data={signupReport.data.data} labelKey="day" formatLabel={fmtDay} caption="New accounts per day" series={[{ key: "signups", label: "Sign-ups", color: "bg-series-1" }]} />
            ) : (
              <PageLoader />
            )}
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Sign-ins by browser" description="Last 30 days" />
          <div className="p-5">
            <RankedBars items={logins.data?.data.browsers ?? []} total={logins.data?.data.total ?? 0} emptyText="No sign-ins recorded yet" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Sign-ins by OS" description="Last 30 days" />
          <div className="p-5">
            <RankedBars items={logins.data?.data.os ?? []} total={logins.data?.data.total ?? 0} emptyText="No sign-ins recorded yet" />
          </div>
        </Card>
        <Card>
          <CardHeader title="System" />
          <dl className="space-y-4 p-5 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-fg-muted">
                <Server className="h-4 w-4" /> Database
              </dt>
              <dd className="flex items-center gap-2">
                {s.data && <StatusBadge status={s.data.data.database.ok ? "healthy" : "error"} />}
                <span className="text-fg-muted tabular-nums">{s.data?.data.database.latencyMs} ms</span>
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-muted">Uptime</dt>
              <dd>{s.data ? uptime(s.data.data.uptimeSeconds) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-muted">Memory</dt>
              <dd className="tabular-nums">{s.data ? `${s.data.data.memoryMb.rss} MB` : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-muted">Node.js</dt>
              <dd>{s.data?.data.node ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <dt className="flex items-center gap-2 text-fg-muted">
                <ShieldCheck className="h-4 w-4" /> Last update
              </dt>
              <dd className="text-right">
                {d.lastUpdate ? (
                  <Link href="/app-update" className="hover:underline">
                    v{d.lastUpdate.toVersion} <StatusBadge status={d.lastUpdate.status} />
                    <span className="block text-xs text-fg-muted">{formatDate(d.lastUpdate.startedAt)}</span>
                  </Link>
                ) : (
                  <span className="text-fg-muted">None yet</span>
                )}
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </PageContainer>
  );
}
