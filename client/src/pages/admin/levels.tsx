import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Gauge, Pencil, Plus, Trash2, X } from "lucide-react";
import type { AccessLevel } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Card, EmptyState, PageHeader, PageLoader } from "@/components/ui/display";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

type Level = AccessLevel & { userCount: number };

const COLORS: Record<string, string> = {
  blue: "bg-info-soft text-info",
  green: "bg-success-soft text-success",
  amber: "bg-warning-soft text-warning",
  purple: "bg-primary-soft text-primary",
  red: "bg-danger-soft text-danger",
  gray: "bg-subtle text-fg-muted",
};
const LIMITS = [
  { key: "maxChannels", label: "WhatsApp numbers" },
  { key: "maxContacts", label: "Contacts" },
  { key: "maxMessagesMonthly", label: "Messages / month" },
  { key: "maxCampaigns", label: "Campaigns / month" },
] as const;
const FLAGS = [
  { key: "emailEnabled", label: "Email marketing" },
  { key: "smsEnabled", label: "SMS marketing" },
  { key: "aiAssistantEnabled", label: "AI assistant" },
  { key: "apiAccess", label: "API access" },
  { key: "whiteLabel", label: "White-label (own brand & domains)" },
  { key: "prioritySupport", label: "Priority support" },
] as const;

const show = (n: number | null) => (n === null || n === -1 ? "Unlimited" : formatNumber(n));

type FormState = Omit<AccessLevel, "id" | "createdAt" | "updatedAt">;
const blank = (n: number): FormState => ({
  levelNumber: n,
  name: "",
  description: "",
  badgeColor: "blue",
  maxChannels: 1,
  maxContacts: 500,
  maxMessagesMonthly: 1000,
  maxCampaigns: 5,
  aiAssistantEnabled: false,
  smsEnabled: false,
  emailEnabled: true,
  prioritySupport: false,
  apiAccess: false,
  whiteLabel: false,
});

function LevelDialog({ level, nextNumber, open, onClose }: { level: Level | null; nextNumber: number; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<FormState>(blank(nextNumber));
  useEffect(() => {
    if (open) setV(level ? { ...level } : blank(nextNumber));
  }, [open, level, nextNumber]);
  const save = useMutation({
    mutationFn: () => (level ? apiRequest("PUT", `/api/superadmin/levels/${level.id}`, v) : apiRequest("POST", "/api/superadmin/levels", v)),
    onSuccess: () => {
      toast({ title: "Level saved", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/superadmin/levels"] });
      onClose();
    },
    onError: (err) => toast({ title: "Could not save level", description: (err as Error).message, variant: "error" }),
  });
  const num = (k: (typeof LIMITS)[number]["key"]) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value === "" ? -1 : Number(e.target.value) }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={level ? `Edit level ${level.levelNumber}` : "New access level"}
      description="Limits apply to a tenant and its team, on top of the tenant's plan. Use -1 for unlimited."
      footer={<Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.name.trim()}>Save level</Button>}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Level number" htmlFor="lv-n"><Input id="lv-n" type="number" min={1} value={v.levelNumber} onChange={(e) => setV({ ...v, levelNumber: Number(e.target.value) })} /></Field>
        <Field label="Name" htmlFor="lv-name" className="sm:col-span-2"><Input id="lv-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Description" htmlFor="lv-desc" className="sm:col-span-3"><Textarea id="lv-desc" rows={2} value={v.description ?? ""} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        <Field label="Badge colour" htmlFor="lv-color">
          <Select id="lv-color" value={v.badgeColor ?? "blue"} onChange={(e) => setV({ ...v, badgeColor: e.target.value })}>
            {Object.keys(COLORS).map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        {LIMITS.map((l) => (
          <Field key={l.key} label={l.label} htmlFor={`lv-${l.key}`}>
            <Input id={`lv-${l.key}`} type="number" min={-1} value={v[l.key] ?? -1} onChange={num(l.key)} />
          </Field>
        ))}
        <fieldset className="sm:col-span-3">
          <legend className="mb-2 text-sm font-medium">Included features</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {FLAGS.map((f) => <Checkbox key={f.key} label={f.label} checked={Boolean(v[f.key])} onChange={(on) => setV({ ...v, [f.key]: on })} />)}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

export default function LevelsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Level | null>(null);
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<{ data: Level[] }>({ queryKey: ["/api/superadmin/levels"] });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/superadmin/levels/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/superadmin/levels"] }),
    onError: (err) => toast({ title: "Could not delete level", description: (err as Error).message, variant: "error" }),
  });
  if (isLoading) return <PageLoader />;
  const levels = data?.data ?? [];
  const nextNumber = (levels.at(-1)?.levelNumber ?? 0) + 1;

  return (
    <PageContainer wide>
      <PageHeader
        title="Manage levels"
        description="Access tiers for tenants. New sign-ups get the lowest level; assign others from a user's Details."
        actions={<Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> New level</Button>}
      />
      {!levels.length ? (
        <Card><EmptyState icon={<Gauge className="h-10 w-10" />} title="No levels yet" description="Create tiers to cap usage per tenant." /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {levels.map((l) => (
            <Card key={l.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", COLORS[l.badgeColor ?? "blue"])}>Level {l.levelNumber}</span>
                  <h2 className="mt-2 text-lg font-semibold">{l.name}</h2>
                  {l.description && <p className="text-sm text-fg-muted">{l.description}</p>}
                </div>
                <div className="flex shrink-0">
                  <Button size="icon" variant="ghost" aria-label={`Edit ${l.name}`} onClick={() => { setEditing(l); setOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${l.name}`} onClick={async () => {
                    if (await confirm({ title: `Delete level "${l.name}"?`, confirmText: "Delete", destructive: true })) remove.mutate(l.id);
                  }}><Trash2 className="h-4 w-4 text-danger" /></Button>
                </div>
              </div>
              <dl className="mt-4 space-y-1.5 text-sm">
                {LIMITS.map((x) => (
                  <div key={x.key} className="flex justify-between gap-2">
                    <dt className="text-fg-muted">{x.label}</dt>
                    <dd className="font-medium tabular-nums">{show(l[x.key])}</dd>
                  </div>
                ))}
              </dl>
              <ul className="mt-4 space-y-1 border-t border-border pt-3 text-sm">
                {FLAGS.map((f) => (
                  <li key={f.key} className={cn("flex items-center gap-2", !l[f.key] && "text-fg-muted line-through")}>
                    {l[f.key] ? <Check className="h-4 w-4 text-success" /> : <X className="h-4 w-4" />} {f.label}
                  </li>
                ))}
              </ul>
              <Link href={`/users/all`} className="mt-auto pt-4 text-xs text-fg-muted">
                {formatNumber(l.userCount)} tenant{l.userCount === 1 ? "" : "s"} on this level
              </Link>
            </Card>
          ))}
        </div>
      )}
      <LevelDialog level={editing} nextNumber={nextNumber} open={open} onClose={() => setOpen(false)} />
    </PageContainer>
  );
}
