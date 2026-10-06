import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import type { Campaign, CampaignRecipient } from "@shared/schema";
import type { Paginated } from "@shared/api-types";
import { formatDate, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Card, CardHeader, ErrorState, PageHeader, PageLoader, ProgressBar, StatCard, StatusBadge } from "@/components/ui/display";
import { Select } from "@/components/ui/form";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";

interface Analytics {
  campaign: Campaign;
  breakdown: Record<string, number>;
  rates: { sent: number; delivered: number; read: number; replied: number; failed: number };
}

export default function CampaignAnalytics({ params }: { params: { campaignId: string } }) {
  const id = params.campaignId;
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const a = useQuery<{ data: Analytics }>({
    queryKey: [`/api/campaigns/${id}/analytics`],
    refetchInterval: (q) => (q.state.data?.data.campaign.status === "running" ? 4000 : false),
  });
  const r = useQuery<Paginated<CampaignRecipient>>({
    queryKey: [`/api/campaigns/${id}/recipients`, { page, limit: 25, status: status || undefined }],
    placeholderData: (p) => p,
    refetchInterval: a.data?.data.campaign.status === "running" ? 4000 : false,
  });

  if (a.isLoading) return <PageLoader />;
  if (a.error || !a.data) return <ErrorState error={a.error} onRetry={() => a.refetch()} />;
  const { campaign: c, rates } = a.data.data;
  const total = c.recipientCount ?? 0;

  const funnel = [
    { label: "Sent", value: c.sentCount, rate: rates.sent },
    { label: "Delivered", value: c.deliveredCount, rate: rates.delivered },
    { label: "Read", value: c.readCount, rate: rates.read },
    { label: "Replied", value: c.repliedCount, rate: rates.replied },
  ];

  return (
    <PageContainer>
      <Link href="/campaigns" className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Campaigns
      </Link>
      <PageHeader title={c.name} description={`${c.templateName} · created ${formatDate(c.createdAt)}${c.completedAt ? ` · finished ${formatDate(c.completedAt)}` : ""}`} actions={<StatusBadge status={c.status} />} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Recipients" value={formatNumber(total)} />
        {funnel.map((f) => (
          <StatCard key={f.label} label={f.label} value={formatNumber(f.value)} hint={`${f.rate}% of recipients`} />
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader title="Delivery funnel" description={c.failedCount ? `${formatNumber(c.failedCount)} failed (${rates.failed}%)` : "No failures"} />
        <div className="space-y-3 p-5">
          {funnel.map((f) => (
            <div key={f.label} className="grid grid-cols-[80px_1fr_80px] items-center gap-3 text-sm">
              <span className="text-fg-muted">{f.label}</span>
              <ProgressBar value={f.rate} />
              <span className="text-right tabular-nums">{f.rate}%</span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="Recipients"
          actions={
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="h-8 w-36 text-xs"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {["pending", "sent", "delivered", "read", "replied", "failed"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          }
        />
        <Table>
          <thead>
            <tr>
              <Th>Contact</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">Sent</Th>
              <Th className="hidden md:table-cell">Delivered</Th>
              <Th>Error</Th>
            </tr>
          </thead>
          <tbody>
            {r.data?.data.map((x) => (
              <Tr key={x.id}>
                <Td>
                  <p className="font-medium">{x.name}</p>
                  <p className="text-xs text-fg-muted tabular-nums">{x.phone}</p>
                </Td>
                <Td>
                  <StatusBadge status={x.status} />
                </Td>
                <Td className="hidden text-fg-muted md:table-cell">{formatDate(x.sentAt)}</Td>
                <Td className="hidden text-fg-muted md:table-cell">{formatDate(x.deliveredAt)}</Td>
                <Td className="max-w-64 truncate text-xs text-danger" title={x.errorMessage ?? undefined}>
                  {x.errorMessage}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {r.data && <Pagination page={page} limit={25} total={r.data.total} onPage={setPage} />}
      </Card>
    </PageContainer>
  );
}
