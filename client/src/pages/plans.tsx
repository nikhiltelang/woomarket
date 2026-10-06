import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { Plan } from "@shared/schema";
import { useAuth } from "@/contexts/auth";
import { formatDate, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Badge, Card, PageHeader, PageLoader } from "@/components/ui/display";
import { cn } from "@/lib/utils";

const LIMIT_LABELS: Record<string, string> = { channel: "WhatsApp numbers", contacts: "Contacts", team: "Team members", campaign: "Campaigns" };
const limitText = (n: number | undefined) => (n === undefined || n === -1 ? "Unlimited" : n === 0 ? "Not included" : formatNumber(n));

export default function PlansPage() {
  const { subscription } = useAuth();
  const { data, isLoading } = useQuery<{ data: Plan[] }>({ queryKey: ["/api/admin/plans"] });
  if (isLoading) return <PageLoader />;

  return (
    <PageContainer>
      <PageHeader
        title="Plan & usage"
        description={
          subscription
            ? `You're on ${subscription.planData.name} (${subscription.billingCycle}) until ${formatDate(subscription.endDate)}.`
            : "Your account has no active plan. Contact the platform administrator."
        }
      />
      <div className="grid gap-4 md:grid-cols-3">
        {data?.data.map((p) => {
          const current = subscription?.planId === p.id;
          return (
            <Card key={p.id} className={cn("flex flex-col p-6", current && "ring-2 ring-primary")}>
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">{p.name}</h2>
                {current ? <Badge tone="primary">Current plan</Badge> : p.popular ? <Badge tone="info">Popular</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-fg-muted">{p.description}</p>
              <p className="mt-4">
                <span className="text-3xl font-semibold tabular-nums">${Number(p.monthlyPrice).toFixed(0)}</span>
                <span className="text-sm text-fg-muted"> / month</span>
              </p>
              <dl className="mt-5 space-y-1.5 text-sm">
                {Object.entries(LIMIT_LABELS).map(([k, label]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <dt className="text-fg-muted">{label}</dt>
                    <dd className="font-medium">{limitText(p.permissions?.[k])}</dd>
                  </div>
                ))}
              </dl>
              <ul className="mt-5 space-y-1.5 border-t border-border pt-4 text-sm">
                {(p.features ?? []).map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {f}
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
      <p className="mt-6 text-sm text-fg-muted">To change plans, contact your platform administrator. Online checkout is not enabled on this installation.</p>
    </PageContainer>
  );
}
