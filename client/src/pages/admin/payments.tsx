import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Receipt } from "lucide-react";
import { formatMoney, type PaymentStatus } from "@shared/billing";
import { formatDate, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Badge, Card, EmptyState, PageHeader, PageLoader, StatCard } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/overlay";

export interface PaymentRow {
  id: string;
  planName: string;
  billingCycle: string;
  currency: string;
  total: number;
  tax: number;
  discount: number;
  credit: number;
  couponCode: string | null;
  provider: string;
  status: PaymentStatus;
  failureReason: string | null;
  invoiceNumber: string | null;
  paidAt: string | null;
  createdAt: string;
  tenant?: { id: string; username: string; email: string } | null;
}

export const PAYMENT_TONE = { pending: "info", paid: "success", failed: "danger", expired: "neutral", refunded: "warning" } as const;
export const PROVIDER_NAME: Record<string, string> = { stripe: "Stripe", razorpay: "Razorpay", simulator: "Test" };

export default function AdminPaymentsPage() {
  const [status, setStatus] = useState<"all" | PaymentStatus>("all");
  const { data, isLoading } = useQuery<{ data: PaymentRow[]; revenue30d: { payments: number; total: number; tax: number } }>({ queryKey: ["/api/admin/payments", status === "all" ? {} : { status }] });
  if (isLoading) return <PageLoader />;
  const rows = data?.data ?? [];
  const cur = rows[0]?.currency ?? "USD";
  return (
    <PageContainer>
      <PageHeader title="Payments" description="Plan purchases and renewals paid online by tenants." />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Revenue (30 days)" value={formatMoney(data?.revenue30d.total ?? 0, cur)} />
        <StatCard label="Payments (30 days)" value={formatNumber(data?.revenue30d.payments ?? 0)} />
        <StatCard label="Tax collected (30 days)" value={formatMoney(data?.revenue30d.tax ?? 0, cur)} />
      </div>
      <div className="mb-4">
        <Tabs value={status} onChange={setStatus} tabs={[{ value: "all", label: "All" }, { value: "paid", label: "Paid" }, { value: "pending", label: "Pending" }, { value: "failed", label: "Failed" }, { value: "expired", label: "Abandoned" }]} />
      </div>
      <Card>
        {!rows.length ? (
          <EmptyState icon={<Receipt className="h-10 w-10" />} title="No payments yet" description="Payments appear when tenants buy or renew a plan from Plan & billing." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Tenant</Th>
                  <Th>Plan</Th>
                  <Th>Gateway</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Total</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <Tr key={p.id}>
                    <Td className="text-xs whitespace-nowrap text-fg-muted">{formatDate(p.paidAt ?? p.createdAt)}</Td>
                    <Td>
                      <p className="font-medium">{p.tenant?.username ?? "—"}</p>
                      <p className="text-xs text-fg-muted">{p.tenant?.email}</p>
                    </Td>
                    <Td>
                      {p.planName} <span className="text-xs text-fg-muted">({p.billingCycle})</span>
                      {p.couponCode && <span className="block text-xs text-fg-muted">coupon {p.couponCode}</span>}
                    </Td>
                    <Td className="text-sm">{PROVIDER_NAME[p.provider] ?? p.provider}</Td>
                    <Td>
                      <Badge tone={PAYMENT_TONE[p.status]}>{p.status === "expired" ? "abandoned" : p.status}</Badge>
                      {p.failureReason && <span className="block max-w-48 truncate text-xs text-fg-muted">{p.failureReason}</span>}
                    </Td>
                    <Td className="text-right font-medium tabular-nums">{formatMoney(p.total, p.currency)}</Td>
                    <Td className="text-right">
                      {p.invoiceNumber && (
                        <a href={`/api/admin/payments/${p.id}/invoice`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          <Download className="h-3.5 w-3.5" /> {p.invoiceNumber}
                        </a>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
