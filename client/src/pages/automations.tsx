import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Cake, Copy, Mail, Plus, Sparkles, Tag, Trash2, Workflow } from "lucide-react";
import { TRIGGER_LABELS, type AutomationInput, type AutomationStatus, type AutomationTrigger } from "@shared/automations";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { formatNumber, relativeTime } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/form";
import { Badge, Card, EmptyState, PageHeader, PageLoader } from "@/components/ui/display";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

export interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  trigger: AutomationTrigger;
  stepCount: number;
  enrolledCount: number;
  completedCount: number;
  runs: Record<string, number>;
  updatedAt: string;
}

const KEY = ["/api/automations"];
export const STATUS_TONE = { draft: "neutral", active: "success", paused: "warning" } as const;

export function describeTrigger(t: AutomationTrigger, groupName?: (id: string) => string): string {
  switch (t.type) {
    case "tag_added":
      return `Tag “${t.tag}” is added`;
    case "group_joined":
      return `Joins ${groupName ? `“${groupName(t.groupId)}”` : "a group"}`;
    case "message_received":
      return t.keywords.length ? `WhatsApp message containing ${t.keywords.map((k) => `“${k}”`).join(", ")}` : "Any WhatsApp message";
    case "date": {
      const field = t.field === "created_at" ? "date added" : t.field;
      const when = t.offsetDays === 0 ? "On" : `${Math.abs(t.offsetDays)} day${Math.abs(t.offsetDays) === 1 ? "" : "s"} ${t.offsetDays < 0 ? "before" : "after"}`;
      return `${when} the contact's ${field}${t.yearly ? " (every year)" : ""} at ${t.time}`;
    }
    default:
      return TRIGGER_LABELS[t.type];
  }
}

export default function AutomationsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [, navigate] = useLocation();
  const manage = can("settings:edit");
  const { data, isLoading } = useQuery<{ data: FlowRow[] }>({ queryKey: KEY });
  const [creating, setCreating] = useState(false);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const fail = (title: string) => (err: unknown) => toast({ title, description: (err as Error).message, variant: "error" });
  const status = useMutation({ mutationFn: ({ id, on }: { id: string; on: boolean }) => apiRequest("POST", `/api/automations/${id}/status`, { status: on ? "active" : "paused" }), onSuccess: invalidate, onError: fail("Could not change the flow") });
  const copy = useMutation({ mutationFn: (id: string) => apiRequest<{ data: { id: string } }>("POST", `/api/automations/${id}/duplicate`), onSuccess: (r) => navigate(`/automations/${r.data.id}`), onError: fail("Could not copy") });
  const remove = useMutation({ mutationFn: (id: string) => apiRequest("DELETE", `/api/automations/${id}`), onSuccess: invalidate, onError: fail("Could not delete") });

  if (isLoading) return <PageLoader />;
  const flows = data?.data ?? [];
  return (
    <PageContainer>
      <PageHeader
        title="Automation flows"
        description="Send the right message at the right moment: welcome series, birthday wishes, follow-ups and more, on WhatsApp, email and SMS."
        actions={manage && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New flow</Button>}
      />
      {flows.length === 0 ? (
        <Card>
          <EmptyState icon={<Workflow className="h-10 w-10" />} title="No flows yet" description="A flow starts when something happens to a contact (added, tagged, a birthday…) and then sends messages, waits and branches on what they do." action={manage && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Create your first flow</Button>} />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {flows.map((f) => {
              const inFlow = (f.runs.active ?? 0) + (f.runs.waiting ?? 0);
              return (
                <li key={f.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <Link href={`/automations/${f.id}`} className="min-w-0 flex-1 rounded-md outline-offset-4">
                    <p className="flex flex-wrap items-center gap-2 font-medium hover:text-primary">
                      {f.name} <Badge tone={STATUS_TONE[f.status]}>{f.status === "active" ? "On" : f.status === "paused" ? "Paused" : "Draft"}</Badge>
                    </p>
                    <p className="mt-0.5 truncate text-sm text-fg-muted">{describeTrigger(f.trigger)} · {f.stepCount} step{f.stepCount === 1 ? "" : "s"}</p>
                  </Link>
                  <dl className="grid grid-cols-3 gap-4 text-center text-xs sm:w-72">
                    <div><dt className="text-fg-muted">Enrolled</dt><dd className="text-sm font-semibold tabular-nums">{formatNumber(f.enrolledCount)}</dd></div>
                    <div><dt className="text-fg-muted">In flow</dt><dd className="text-sm font-semibold tabular-nums">{formatNumber(inFlow)}</dd></div>
                    <div><dt className="text-fg-muted">Finished</dt><dd className="text-sm font-semibold tabular-nums">{formatNumber(f.completedCount)}</dd></div>
                  </dl>
                  <span className="hidden w-24 text-right text-xs text-fg-muted lg:block">{relativeTime(f.updatedAt)}</span>
                  {manage && (
                    <div className="flex items-center gap-1">
                      <Switch label={<span className="sr-only">Flow on</span>} checked={f.status === "active"} disabled={status.isPending} onChange={(on) => status.mutate({ id: f.id, on })} />
                      <Button size="icon" variant="ghost" aria-label={`Copy ${f.name}`} onClick={() => copy.mutate(f.id)}><Copy className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" aria-label={`Delete ${f.name}`} onClick={async () => { if (await confirm({ title: `Delete “${f.name}”?`, description: inFlow ? `${inFlow} contact${inFlow === 1 ? " is" : "s are"} in this flow and will stop where they are. Messages already sent aren't affected.` : "This can't be undone.", confirmText: "Delete", destructive: true })) remove.mutate(f.id); }}>
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <NewFlowDialog open={creating} onClose={() => setCreating(false)} />
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Starting points
// ---------------------------------------------------------------------------

const html = (...paragraphs: string[]) => `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827"><div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:8px;padding:28px;font-size:15px;line-height:1.6">${paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join("")}</div></body></html>`;

interface Starter {
  key: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  flow: Omit<AutomationInput, "name"> & { name: string };
}

const STARTERS: Starter[] = [
  { key: "blank", title: "Start from scratch", description: "An empty flow you build step by step.", icon: <Plus className="h-5 w-5" />, flow: { name: "New flow", trigger: { type: "contact_created", sources: ["manual", "api", "whatsapp", "widget"] }, steps: [], reentry: "never" } },
  {
    key: "welcome",
    title: "Welcome series",
    description: "Welcome new contacts by email, then follow up if they didn't open it.",
    icon: <Mail className="h-5 w-5" />,
    flow: {
      name: "Welcome series",
      trigger: { type: "contact_created", sources: ["manual", "api", "whatsapp", "widget"] },
      reentry: "never",
      steps: [
        { id: "s_welcome1", type: "send_email", subject: "Welcome, {{first_name}}!", contentHtml: html("Hi {{first_name}},", "Thanks for joining us. Here's what you can expect from us…", "Reply to this email any time: a real person reads it.") },
        { id: "s_wait2d", type: "wait", amount: 2, unit: "days", until: "10:00" },
        {
          id: "s_opened",
          type: "condition",
          check: { kind: "step", stepId: "s_welcome1", event: "opened" },
          yes: [{ id: "s_tageng", type: "add_tags", tags: ["engaged"] }],
          no: [{ id: "s_welcome2", type: "send_email", subject: "Did you see this, {{first_name}}?", contentHtml: html("Hi {{first_name}},", "Just checking you got our welcome message…") }],
        },
      ],
    },
  },
  {
    key: "birthday",
    title: "Birthday wishes",
    description: "Every year on the contact's birthday (custom field “birthday”).",
    icon: <Cake className="h-5 w-5" />,
    flow: {
      name: "Birthday wishes",
      trigger: { type: "date", field: "birthday", offsetDays: 0, yearly: true, time: "09:00" },
      reentry: "after_exit",
      steps: [
        { id: "s_bday", type: "send_email", subject: "Happy birthday, {{first_name}}! 🎂", contentHtml: html("Happy birthday, {{first_name}}!", "To celebrate, here's 15% off your next order with the code BIRTHDAY15.") },
        { id: "s_bdaytag", type: "add_tags", tags: ["birthday-sent"] },
      ],
    },
  },
  {
    key: "lead",
    title: "Lead follow-up",
    description: "When a contact is tagged “lead”, alert the team and follow up if they haven't become a customer.",
    icon: <Tag className="h-5 w-5" />,
    flow: {
      name: "Lead follow-up",
      trigger: { type: "tag_added", tag: "lead" },
      reentry: "after_exit",
      steps: [
        { id: "s_alert", type: "notify", message: "New lead: {{name}} ({{phone}}). Please get in touch today.", userIds: [] },
        { id: "s_wait1d", type: "wait", amount: 1, unit: "days" },
        {
          id: "s_iscust",
          type: "condition",
          check: { kind: "contact", rules: { match: "all", conditions: [{ field: "tag", op: "has", value: "customer" }] } },
          yes: [{ id: "s_done", type: "exit" }],
          no: [{ id: "s_followup", type: "send_email", subject: "Any questions, {{first_name}}?", contentHtml: html("Hi {{first_name}},", "Thanks for your interest! Is there anything we can help you decide?") }],
        },
      ],
    },
  },
];

function NewFlowDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [picked, setPicked] = useState("welcome");
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => {
      const s = STARTERS.find((x) => x.key === picked)!;
      return apiRequest<{ data: { id: string } }>("POST", "/api/automations", { ...s.flow, name: name.trim() || s.flow.name });
    },
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
      navigate(`/automations/${r.data.id}`);
    },
    onError: (err) => toast({ title: "Could not create the flow", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="New flow" description="Pick a starting point. You can change everything afterwards." footer={<Button onClick={() => create.mutate()} loading={create.isPending}><Sparkles className="h-4 w-4" /> Create and edit</Button>}>
      <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Starting point">
        {STARTERS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="radio"
            aria-checked={picked === s.key}
            onClick={() => setPicked(s.key)}
            className={`flex gap-3 rounded-lg border p-4 text-left transition-colors ${picked === s.key ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-subtle"}`}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-subtle text-primary">{s.icon}</span>
            <span>
              <span className="block text-sm font-medium">{s.title}</span>
              <span className="mt-0.5 block text-xs text-fg-muted">{s.description}</span>
            </span>
          </button>
        ))}
      </div>
      <Field label="Name" htmlFor="flow-name" className="mt-4">
        <Input id="flow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={STARTERS.find((s) => s.key === picked)?.flow.name} maxLength={100} />
      </Field>
    </Dialog>
  );
}

