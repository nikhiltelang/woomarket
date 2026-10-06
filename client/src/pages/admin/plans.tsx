import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Plan } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form";
import { Badge, Card, PageHeader, PageLoader } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

const LIMITS = [
  { key: "channel", label: "WhatsApp numbers" },
  { key: "contacts", label: "Contacts" },
  { key: "team", label: "Team members" },
  { key: "campaign", label: "Campaigns" },
] as const;

const show = (n: number | undefined) => (n === undefined || n === -1 ? "∞" : formatNumber(n));

function PlanDialog({ plan, open, onClose }: { plan: Plan | null; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ name: "", description: "", monthlyPrice: "0", annualPrice: "0", popular: false, features: "", limits: {} as Record<string, string> });
  useEffect(() => {
    if (!open) return;
    setV({
      name: plan?.name ?? "",
      description: plan?.description ?? "",
      monthlyPrice: plan?.monthlyPrice ?? "0",
      annualPrice: plan?.annualPrice ?? "0",
      popular: plan?.popular ?? false,
      features: (plan?.features ?? []).join("\n"),
      limits: Object.fromEntries(LIMITS.map((l) => [l.key, String(plan?.permissions?.[l.key] ?? -1)])),
    });
  }, [open, plan]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: v.name,
        description: v.description || null,
        monthlyPrice: Number(v.monthlyPrice),
        annualPrice: Number(v.annualPrice),
        popular: v.popular,
        features: v.features.split("\n").map((f) => f.trim()).filter(Boolean),
        permissions: Object.fromEntries(Object.entries(v.limits).map(([k, n]) => [k, Number(n)])),
      };
      return plan ? apiRequest("PUT", `/api/admin/plans/${plan.id}`, body) : apiRequest("POST", "/api/admin/plans", body);
    },
    onSuccess: () => {
      toast({ title: "Plan saved", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] });
      onClose();
    },
    onError: (err) => toast({ title: "Could not save plan", description: (err as Error).message, variant: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={plan ? `Edit ${plan.name}` : "New plan"}
      description="Limits: -1 is unlimited, 0 means the feature is not included. Changes apply to new subscriptions; existing ones keep the limits they were assigned with."
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.name.trim()}>
          Save plan
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="p-name" className="sm:col-span-2">
          <Input id="p-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Description" htmlFor="p-desc" className="sm:col-span-2">
          <Textarea id="p-desc" rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </Field>
        <Field label="Monthly price (USD)" htmlFor="p-m">
          <Input id="p-m" type="number" min={0} step="0.01" value={v.monthlyPrice} onChange={(e) => setV({ ...v, monthlyPrice: e.target.value })} />
        </Field>
        <Field label="Annual price (USD)" htmlFor="p-a">
          <Input id="p-a" type="number" min={0} step="0.01" value={v.annualPrice} onChange={(e) => setV({ ...v, annualPrice: e.target.value })} />
        </Field>
        {LIMITS.map((l) => (
          <Field key={l.key} label={l.label} htmlFor={`p-${l.key}`}>
            <Input id={`p-${l.key}`} type="number" min={-1} value={v.limits[l.key] ?? "-1"} onChange={(e) => setV({ ...v, limits: { ...v.limits, [l.key]: e.target.value } })} />
          </Field>
        ))}
        <Field label="Features (one per line)" htmlFor="p-f" className="sm:col-span-2">
          <Textarea id="p-f" rows={4} value={v.features} onChange={(e) => setV({ ...v, features: e.target.value })} />
        </Field>
        <Checkbox label="Highlight as popular" checked={v.popular} onChange={(popular) => setV({ ...v, popular })} />
      </div>
    </Dialog>
  );
}

export default function AdminPlans() {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Plan | null>(null);
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<{ data: Plan[] }>({ queryKey: ["/api/admin/plans"] });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/admin/plans/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/admin/plans"] }),
    onError: (err) => toast({ title: "Could not delete plan", description: (err as Error).message, variant: "error" }),
  });
  if (isLoading) return <PageLoader />;
  return (
    <PageContainer>
      <PageHeader
        title="Plans"
        description="Subscription plans and the limits they enforce."
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> New plan
          </Button>
        }
      />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Plan</Th>
              <Th className="text-right">Monthly</Th>
              {LIMITS.map((l) => (
                <Th key={l.key} className="text-right">
                  {l.label}
                </Th>
              ))}
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((p) => (
              <Tr key={p.id}>
                <Td>
                  <span className="font-medium">{p.name}</span> {p.popular && <Badge tone="info">popular</Badge>}
                </Td>
                <Td className="text-right tabular-nums">${p.monthlyPrice}</Td>
                {LIMITS.map((l) => (
                  <Td key={l.key} className="text-right tabular-nums">
                    {show(p.permissions?.[l.key])}
                  </Td>
                ))}
                <Td className="text-right whitespace-nowrap">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${p.name}`}
                    onClick={() => {
                      setEditing(p);
                      setOpen(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${p.name}`}
                    onClick={async () => {
                      if (await confirm({ title: `Delete plan "${p.name}"?`, confirmText: "Delete", destructive: true })) remove.mutate(p.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-danger" />
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <PlanDialog plan={editing} open={open} onClose={() => setOpen(false)} />
    </PageContainer>
  );
}
