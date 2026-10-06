import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Activity, Building2, Megaphone, MessageSquare, Users, Wifi } from "lucide-react";
import { formatDate, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Card, CardHeader, ErrorState, PageHeader, PageLoader, StatCard, StatusBadge } from "@/components/ui/display";

interface Overview {
  version: string;
  users: Record<string, number>;
  totalUsers: number;
  channels: number;
  messages24h: number;
  activeCampaigns: number;
  onlineAgents: number;
  lastUpdate: { status: string; toVersion: string | null; startedAt: string } | null;
}

interface ServerInfo {
  node: string;
  platform: string;
  uptimeSeconds: number;
  memoryMb: { rss: number; heapUsed: number };
  loadAverage: number[];
  cpus: number;
  database: { ok: boolean; latencyMs: number };
  instance: string;
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
  if (o.isLoading) return <PageLoader />;
  if (o.error || !o.data) return <ErrorState error={o.error} onRetry={() => o.refetch()} />;
  const d = o.data.data;

  return (
    <PageContainer>
      <PageHeader title="Platform overview" description={`WooMarket360 v${d.version}`} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Tenants" value={formatNumber(d.users.admin ?? 0)} icon={<Users className="h-4 w-4" />} />
        <StatCard label="All users" value={formatNumber(d.totalUsers)} hint={`${formatNumber(d.users.team ?? 0)} team members`} />
        <StatCard label="Channels" value={formatNumber(d.channels)} icon={<Building2 className="h-4 w-4" />} />
        <StatCard label="Messages 24h" value={formatNumber(d.messages24h)} icon={<MessageSquare className="h-4 w-4" />} />
        <StatCard label="Active campaigns" value={formatNumber(d.activeCampaigns)} icon={<Megaphone className="h-4 w-4" />} />
        <StatCard label="Online now" value={formatNumber(d.onlineAgents)} icon={<Wifi className="h-4 w-4" />} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Server health" description={s.data ? `Instance ${s.data.data.instance}` : undefined} />
          {s.data && (
            <dl className="grid grid-cols-2 gap-4 p-5 text-sm">
              <div>
                <dt className="text-xs text-fg-muted">Database</dt>
                <dd className="flex items-center gap-2">
                  <StatusBadge status={s.data.data.database.ok ? "healthy" : "error"} />
                  <span className="text-fg-muted">{s.data.data.database.latencyMs} ms</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">Uptime</dt>
                <dd>{uptime(s.data.data.uptimeSeconds)}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">Memory (RSS / heap)</dt>
                <dd className="tabular-nums">
                  {s.data.data.memoryMb.rss} / {s.data.data.memoryMb.heapUsed} MB
                </dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">Load average (1m)</dt>
                <dd className="tabular-nums">
                  {s.data.data.loadAverage[0]?.toFixed(2)} on {s.data.data.cpus} CPUs
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-fg-muted">Runtime</dt>
                <dd>
                  Node {s.data.data.node} · {s.data.data.platform}
                </dd>
              </div>
            </dl>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Last application update"
            actions={
              <Link href="/app-update" className="text-xs font-medium text-primary hover:underline">
                Application Update
              </Link>
            }
          />
          <div className="p-5 text-sm">
            {d.lastUpdate ? (
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-fg-muted" />
                <div>
                  <p>
                    v{d.lastUpdate.toVersion} <StatusBadge status={d.lastUpdate.status} />
                  </p>
                  <p className="text-xs text-fg-muted">{formatDate(d.lastUpdate.startedAt)}</p>
                </div>
              </div>
            ) : (
              <p className="text-fg-muted">No updates have been applied from the panel yet.</p>
            )}
          </div>
        </Card>
      </div>
    </PageContainer>
  );
}
