import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bell,
  Clock,
  Flag,
  GitBranch,
  Mail,
  MessageCircle,
  MessageSquareText,
  PenLine,
  Play,
  Pause,
  Plus,
  Tag,
  Trash2,
  UserPlus,
  Users,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import {
  CONDITION_EVENTS,
  CONTACT_SOURCES,
  EVENTS_BY_STEP,
  EVENT_LABELS,
  SOURCE_LABELS,
  STEP_LABELS,
  TRIGGER_LABELS,
  describeWait,
  flatten,
  newStepId,
  nextAfter,
  stepsBefore,
  type AutomationTrigger,
  type ConditionEvent,
  type Step,
  type StepType,
} from "@shared/automations";
import { describeRules, type SegmentRules } from "@shared/segments";
import { calculateSegments } from "@shared/sms";
import type { Group, Template } from "@shared/schema";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { ApiError, apiRequest, queryClient } from "@/lib/api";
import { cn, formatDate, formatNumber } from "@/lib/utils";
import { useContactFields } from "@/components/contact-fields";
import { EmailContentField } from "@/components/email-builder";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, PageLoader, Spinner } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, Tabs, useConfirm, useToast } from "@/components/ui/overlay";
import { STATUS_TONE, describeTrigger, type FlowRow } from "./automations";
import { ConditionRow, blank as blankCondition, complete as conditionComplete, type Cond } from "./segments";

interface Flow {
  id: string;
  name: string;
  description: string | null;
  status: FlowRow["status"];
  trigger: AutomationTrigger;
  steps: Step[];
  reentry: "never" | "after_exit";
  enrolledCount: number;
  completedCount: number;
}
interface Draft {
  name: string;
  description: string | null;
  trigger: AutomationTrigger;
  steps: Step[];
  reentry: "never" | "after_exit";
}
interface Stats {
  outcomes: Record<string, Record<string, number>>;
  waitingAt: Record<string, number>;
  runs: Record<string, number>;
}
interface Assignee {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
}

const MERGE_TAGS = ["first_name", "name", "phone", "email"];
const MERGE_HINT = "Personalise with {{first_name}}, {{name}}, {{phone}}, {{email}} or a custom field like {{city}}.";

const STEP_ICONS: Record<StepType, ReactNode> = {
  send_whatsapp: <MessageCircle className="h-4 w-4" />,
  send_email: <Mail className="h-4 w-4" />,
  send_sms: <MessageSquareText className="h-4 w-4" />,
  wait: <Clock className="h-4 w-4" />,
  condition: <GitBranch className="h-4 w-4" />,
  add_tags: <Tag className="h-4 w-4" />,
  remove_tags: <Tag className="h-4 w-4" />,
  add_to_group: <Users className="h-4 w-4" />,
  remove_from_group: <Users className="h-4 w-4" />,
  update_field: <PenLine className="h-4 w-4" />,
  notify: <Bell className="h-4 w-4" />,
  webhook: <Webhook className="h-4 w-4" />,
  exit: <Flag className="h-4 w-4" />,
};
const STEP_GROUPS: { title: string; types: StepType[] }[] = [
  { title: "Messages", types: ["send_whatsapp", "send_email", "send_sms"] },
  { title: "Timing & logic", types: ["wait", "condition", "exit"] },
  { title: "Contact", types: ["add_tags", "remove_tags", "add_to_group", "remove_from_group", "update_field"] },
  { title: "Team & tools", types: ["notify", "webhook"] },
];

// ---------------------------------------------------------------------------
// Tree editing (immutable)
// ---------------------------------------------------------------------------

/** Where a list of steps lives: the root, or one branch of a condition. */
type Owner = { root: true } | { conditionId: string; branch: "yes" | "no" };

function mapSteps(steps: Step[], fn: (s: Step) => Step): Step[] {
  return steps.map((s) => {
    const n = fn(s);
    return n.type === "condition" ? { ...n, yes: mapSteps(n.yes, fn), no: mapSteps(n.no, fn) } : n;
  });
}
function editList(steps: Step[], owner: Owner, edit: (list: Step[]) => Step[]): Step[] {
  if ("root" in owner) return edit(steps);
  return mapSteps(steps, (s) => (s.type === "condition" && s.id === owner.conditionId ? { ...s, [owner.branch]: edit(s[owner.branch]) } : s));
}
function removeStep(steps: Step[], id: string): Step[] {
  return steps.filter((s) => s.id !== id).map((s) => (s.type === "condition" ? { ...s, yes: removeStep(s.yes, id), no: removeStep(s.no, id) } : s));
}
function moveStep(steps: Step[], id: string, dir: -1 | 1): Step[] {
  const i = steps.findIndex((s) => s.id === id);
  if (i >= 0) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return steps;
    const copy = [...steps];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  }
  return steps.map((s) => (s.type === "condition" ? { ...s, yes: moveStep(s.yes, id, dir), no: moveStep(s.no, id, dir) } : s));
}

function newStep(type: StepType, channelId: string | undefined): Step {
  const id = newStepId();
  switch (type) {
    case "send_whatsapp":
      return { id, type, channelId: channelId ?? "", mode: "template", templateId: "", variables: [] };
    case "send_email":
      return { id, type, subject: "", contentHtml: "", design: null };
    case "send_sms":
      return { id, type, message: "" };
    case "wait":
      return { id, type, amount: 1, unit: "days" };
    case "condition":
      return { id, type, check: { kind: "contact", rules: { match: "all", conditions: [{ field: "tag", op: "has", value: "" }] } }, yes: [], no: [] };
    case "add_tags":
    case "remove_tags":
      return { id, type, tags: [] };
    case "add_to_group":
    case "remove_from_group":
      return { id, type, groupId: "" };
    case "update_field":
      return { id, type, key: "", value: "" };
    case "notify":
      return { id, type, message: "{{name}} reached this step.", userIds: [] };
    case "webhook":
      return { id, type, url: "" };
    case "exit":
      return { id, type };
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AutomationBuilderPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const { can } = useAuth();
  const toast = useToast();
  const manage = can("settings:edit");
  const flowQ = useQuery<{ data: Flow; problems: string[] }>({ queryKey: [`/api/automations/${id}`] });
  const statsQ = useQuery<{ data: Stats }>({ queryKey: [`/api/automations/${id}/stats`], refetchInterval: 15_000 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>("trigger");
  const [tab, setTab] = useState<"flow" | "contacts">("flow");
  const [adding, setAdding] = useState<{ owner: Owner; index: number } | null>(null);
  const [enrolOpen, setEnrolOpen] = useState(false);
  // Wide flows (branches) scroll sideways on small screens: start centred on the trigger.
  const canvas = useRef<HTMLDivElement>(null);
  const centred = useRef(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el || centred.current || !draft) return;
    centred.current = true;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  });

  useEffect(() => {
    if (flowQ.data && !dirty) {
      const f = flowQ.data.data;
      setDraft({ name: f.name, description: f.description, trigger: f.trigger, steps: f.steps, reentry: f.reentry });
    }
  }, [flowQ.data, dirty]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [`/api/automations/${id}`] });
    void queryClient.invalidateQueries({ queryKey: ["/api/automations"] });
  };
  const save = useMutation({
    mutationFn: () => apiRequest<{ data: Flow; problems: string[] }>("PUT", `/api/automations/${id}`, draft),
    onSuccess: (r) => {
      setDirty(false);
      queryClient.setQueryData([`/api/automations/${id}`], r);
      void queryClient.invalidateQueries({ queryKey: ["/api/automations"] });
      toast({ title: "Flow saved", description: r.data.status === "paused" && flowQ.data?.data.status === "active" ? "It was paused: fix the issues listed, then turn it on again." : undefined, variant: r.data.status === "paused" && flowQ.data?.data.status === "active" ? "error" : "success" });
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  const setStatus = useMutation({
    mutationFn: (status: "active" | "paused") => apiRequest("POST", `/api/automations/${id}/status`, { status }),
    onSuccess: refresh,
    onError: (err) => toast({ title: "Could not turn the flow on", description: (err as Error).message, variant: "error" }),
  });

  if (flowQ.isLoading || !draft) return <PageLoader />;
  if (!flowQ.data) return <EmptyState title="Flow not found" />;
  const flow = flowQ.data.data;
  const problems = flowQ.data.problems;
  const update = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const setSteps = (steps: Step[]) => update({ steps });
  const selectedStep = selected && selected !== "trigger" ? flatten(draft.steps).find((s) => s.id === selected) : undefined;
  const stats = statsQ.data?.data;
  const inFlow = (stats?.runs.active ?? 0) + (stats?.runs.waiting ?? 0);

  const insert = (type: StepType) => {
    if (!adding) return;
    const step = newStep(type, flatten(draft.steps).find((s): s is Extract<Step, { type: "send_whatsapp" }> => s.type === "send_whatsapp")?.channelId);
    setSteps(editList(draft.steps, adding.owner, (list) => [...list.slice(0, adding.index), step, ...list.slice(adding.index)]));
    setSelected(step.id);
    setAdding(null);
  };

  return (
    <PageContainer wide>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/automations" className="text-fg-muted hover:text-fg" aria-label="All flows"><ArrowLeft className="h-5 w-5" /></Link>
        <Input aria-label="Flow name" className="h-10 max-w-sm text-base font-semibold" value={draft.name} disabled={!manage} onChange={(e) => update({ name: e.target.value })} maxLength={100} />
        <Badge tone={STATUS_TONE[flow.status]}>{flow.status === "active" ? "On" : flow.status === "paused" ? "Paused" : "Draft"}</Badge>
        <span className="text-xs text-fg-muted">{formatNumber(flow.enrolledCount)} enrolled · {formatNumber(inFlow)} in flow · {formatNumber(flow.completedCount)} finished</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {manage && flow.status === "active" && <Button variant="outline" onClick={() => setEnrolOpen(true)}><UserPlus className="h-4 w-4" /> Add contacts</Button>}
          {manage && (
            <Button variant={dirty ? "primary" : "outline"} onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !draft.name.trim()}>
              {dirty ? "Save changes" : "Saved"}
            </Button>
          )}
          {manage &&
            (flow.status === "active" ? (
              <Button variant="outline" onClick={() => setStatus.mutate("paused")} loading={setStatus.isPending}><Pause className="h-4 w-4" /> Pause</Button>
            ) : (
              <Button onClick={() => setStatus.mutate("active")} loading={setStatus.isPending} disabled={dirty} title={dirty ? "Save your changes first" : undefined}><Play className="h-4 w-4" /> Turn on</Button>
            ))}
        </div>
      </div>

      {problems.length > 0 && (
        <div role="status" className="mb-4 flex gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium">Before this flow can run</p>
            <ul className="mt-1 list-disc pl-5 text-fg-muted">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        </div>
      )}

      <div className="mb-4">
        <Tabs value={tab} onChange={setTab} tabs={[{ value: "flow", label: "Flow" }, { value: "contacts", label: `Contacts${inFlow ? ` (${inFlow} in flow)` : ""}` }]} />
      </div>

      {tab === "flow" ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div ref={canvas} className="overflow-x-auto rounded-lg border border-border bg-surface p-6">
            <div className="mx-auto flex min-w-fit flex-col items-center">
              <NodeCard
                icon={<Zap className="h-4 w-4" />}
                kind="Trigger"
                title={describeTrigger(draft.trigger)}
                selected={selected === "trigger"}
                onClick={() => setSelected("trigger")}
                tone="primary"
              />
              <StepList steps={draft.steps} all={draft.steps} owner={{ root: true }} selected={selected} onSelect={setSelected} onAdd={manage ? (owner, index) => setAdding({ owner, index }) : undefined} stats={stats} />
              <Connector />
              <span className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg-muted">End</span>
            </div>
          </div>
          <div className="lg:sticky lg:top-4 lg:self-start">
            {selected === "trigger" ? (
              <TriggerEditor draft={draft} disabled={!manage} onChange={update} />
            ) : selectedStep ? (
              <StepEditor
                key={selectedStep.id}
                step={selectedStep}
                all={draft.steps}
                disabled={!manage}
                stats={stats}
                onChange={(s) => setSteps(mapSteps(draft.steps, (x) => (x.id === s.id ? s : x)))}
                onRemove={() => {
                  setSteps(removeStep(draft.steps, selectedStep.id));
                  setSelected("trigger");
                }}
                onMove={(dir) => setSteps(moveStep(draft.steps, selectedStep.id, dir))}
                onClose={() => setSelected(null)}
              />
            ) : (
              <Card className="p-6 text-sm text-fg-muted">Select the trigger or a step to edit it, or use + to add a step.</Card>
            )}
          </div>
        </div>
      ) : (
        <Runs flowId={id} steps={draft.steps} manage={manage} />
      )}

      <AddStepDialog open={Boolean(adding)} onClose={() => setAdding(null)} onPick={insert} />
      <EnrolDialog open={enrolOpen} onClose={() => setEnrolOpen(false)} flowId={id} />
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

function Connector() {
  return <span aria-hidden className="h-5 w-px bg-border" />;
}

function NodeCard({ icon, kind, title, subtitle, selected, onClick, tone, stats, invalid }: { icon: ReactNode; kind: string; title: string; subtitle?: string; selected: boolean; onClick: () => void; tone?: "primary"; stats?: ReactNode; invalid?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "w-72 rounded-lg border bg-surface p-3 text-left shadow-sm transition-colors hover:border-primary/60",
        selected ? "border-primary ring-2 ring-primary/30" : invalid ? "border-danger/60" : "border-border",
      )}
    >
      <span className="flex items-center gap-2 text-xs font-medium text-fg-muted">
        <span className={cn("flex h-6 w-6 items-center justify-center rounded-md", tone === "primary" ? "bg-primary text-primary-fg" : "bg-subtle text-fg")}>{icon}</span>
        {kind}
        {invalid && <AlertTriangle className="ml-auto h-3.5 w-3.5 text-danger" aria-label="Needs attention" />}
      </span>
      <span className="mt-1.5 block text-sm font-medium break-words">{title}</span>
      {subtitle && <span className="mt-0.5 block truncate text-xs text-fg-muted">{subtitle}</span>}
      {stats}
    </button>
  );
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Add a step here" className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface text-fg-muted hover:border-primary hover:text-primary">
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

function StepList({ steps, all, owner, selected, onSelect, onAdd, stats }: { steps: Step[]; all: Step[]; owner: Owner; selected: string | null; onSelect: (id: string) => void; onAdd?: (owner: Owner, index: number) => void; stats?: Stats }) {
  return (
    <>
      {steps.map((s, i) => (
        <div key={s.id} className="flex flex-col items-center">
          <Connector />
          {onAdd && <AddButton onClick={() => onAdd(owner, i)} />}
          {onAdd && <Connector />}
          <NodeCard icon={STEP_ICONS[s.type]} kind={STEP_LABELS[s.type]} title={summarize(s, all)} selected={selected === s.id} onClick={() => onSelect(s.id)} invalid={!stepComplete(s)} stats={<StepStats step={s} all={all} stats={stats} />} />
          {s.type === "condition" && (
            <div className="mt-0 flex gap-6">
              {(["yes", "no"] as const).map((branch) => (
                <div key={branch} className="flex min-w-72 flex-col items-center">
                  <Connector />
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", branch === "yes" ? "bg-success/15 text-success" : "bg-danger/10 text-danger")}>{branch === "yes" ? "Yes" : "No"}</span>
                  <StepList steps={s[branch]} all={all} owner={{ conditionId: s.id, branch }} selected={selected} onSelect={onSelect} onAdd={onAdd} stats={stats} />
                  {onAdd && (
                    <>
                      <Connector />
                      <AddButton onClick={() => onAdd({ conditionId: s.id, branch }, s[branch].length)} />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {onAdd && "root" in owner && (
        <>
          <Connector />
          <AddButton onClick={() => onAdd(owner, steps.length)} />
        </>
      )}
    </>
  );
}

function StepStats({ step, all, stats }: { step: Step; all: Step[]; stats?: Stats }) {
  const o = stats?.outcomes[step.id];
  // Runs waiting after a wait step are stored at the step that comes next.
  const waiting = step.type === "wait" ? (stats?.waitingAt[nextAfter(all, step.id)?.id ?? ""] ?? 0) : 0;
  if (!o && !waiting) return null;
  const chips: [string, number, string][] =
    step.type === "condition"
      ? [["yes", o?.yes ?? 0, "text-success"], ["no", o?.no ?? 0, "text-danger"]]
      : [["done", o?.done ?? 0, "text-fg"], ["skipped", o?.skipped ?? 0, "text-fg-muted"], ["failed", o?.failed ?? 0, "text-danger"]];
  return (
    <span className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border pt-2 text-[11px] text-fg-muted">
      {chips.filter(([, n], i) => n > 0 || i === 0).map(([label, n, cls]) => <span key={label}><b className={cn("tabular-nums", cls)}>{formatNumber(n)}</b> {label}</span>)}
      {waiting > 0 && <span><b className="text-fg tabular-nums">{formatNumber(waiting)}</b> waiting</span>}
    </span>
  );
}

/** One-line description of a step for its card. */
function summarize(s: Step, all: Step[]): string {
  switch (s.type) {
    case "send_whatsapp":
      return s.mode === "text" ? (s.text ? `“${s.text.slice(0, 60)}”` : "Text message (24-hour window)") : s.templateId ? "Template message" : "Choose a template";
    case "send_email":
      return s.subject || "Write the email";
    case "send_sms":
      return s.message ? `“${s.message.slice(0, 60)}”` : "Write the SMS";
    case "wait":
      return describeWait(s);
    case "condition":
      if (s.check.kind === "step") {
        const target = all.find((x) => x.id === (s.check as { stepId: string }).stepId);
        return `If ${target ? `the “${summarize(target, all).slice(0, 30)}” message` : "a message"} ${EVENT_LABELS[s.check.event]}`;
      }
      return `If the contact matches: ${describeRules(s.check.rules as SegmentRules)}`.slice(0, 120);
    case "add_tags":
    case "remove_tags":
      return s.tags.length ? s.tags.join(", ") : "Choose tags";
    case "add_to_group":
    case "remove_from_group":
      return s.groupId ? "Group selected" : "Choose a group";
    case "update_field":
      return s.key ? `${s.key} = ${s.value || "(clear)"}` : "Choose a field";
    case "notify":
      return s.message.slice(0, 60);
    case "webhook":
      return s.url || "Enter a URL";
    case "exit":
      return "The contact leaves the flow";
  }
}

/** Whether a step has what it needs (cards show a warning otherwise). */
function stepComplete(s: Step): boolean {
  switch (s.type) {
    case "send_whatsapp":
      return Boolean(s.channelId) && (s.mode === "text" ? Boolean(s.text.trim()) : Boolean(s.templateId));
    case "send_email":
      return Boolean(s.subject.trim() && s.contentHtml.trim());
    case "send_sms":
      return Boolean(s.message.trim());
    case "condition":
      return s.check.kind === "step" ? Boolean(s.check.stepId) : s.check.rules.conditions.every((c) => conditionComplete(c as Cond));
    case "add_tags":
    case "remove_tags":
      return s.tags.length > 0;
    case "add_to_group":
    case "remove_from_group":
      return Boolean(s.groupId);
    case "update_field":
      return /^[a-z][a-z0-9_]{0,49}$/.test(s.key);
    case "webhook":
      return /^https?:\/\/.+/.test(s.url);
    default:
      return true;
  }
}

function AddStepDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (t: StepType) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Add a step">
      <div className="flex flex-col gap-4">
        {STEP_GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">{g.title}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {g.types.map((t) => (
                <button key={t} type="button" onClick={() => onPick(t)} className="flex items-center gap-2 rounded-md border border-border p-2.5 text-left text-sm hover:border-primary hover:bg-subtle">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-subtle">{STEP_ICONS[t]}</span>
                  {STEP_LABELS[t]}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Trigger editor
// ---------------------------------------------------------------------------

function blankTrigger(type: AutomationTrigger["type"]): AutomationTrigger {
  switch (type) {
    case "contact_created":
      return { type, sources: ["manual", "api", "whatsapp", "widget"] };
    case "tag_added":
      return { type, tag: "" };
    case "group_joined":
      return { type, groupId: "" };
    case "message_received":
      return { type, keywords: [] };
    case "date":
      return { type, field: "birthday", offsetDays: 0, yearly: true, time: "09:00" };
    case "manual":
      return { type };
  }
}

function TriggerEditor({ draft, disabled, onChange }: { draft: Draft; disabled: boolean; onChange: (p: Partial<Draft>) => void }) {
  const t = draft.trigger;
  const set = (trigger: AutomationTrigger) => onChange({ trigger });
  const groups = useQuery<{ data: Group[] }>({ queryKey: ["/api/groups"] });
  const fields = useContactFields();
  const [keywords, setKeywords] = useState(t.type === "message_received" ? t.keywords.join(", ") : "");
  return (
    <Card>
      <CardHeader title="Trigger" description="What starts the flow for a contact." />
      <fieldset disabled={disabled} className="flex flex-col gap-4 p-5">
        <Field label="Start when" htmlFor="trg-type">
          <Select id="trg-type" value={t.type} onChange={(e) => set(blankTrigger(e.target.value as AutomationTrigger["type"]))}>
            {(Object.keys(TRIGGER_LABELS) as AutomationTrigger["type"][]).map((k) => <option key={k} value={k}>{TRIGGER_LABELS[k]}</option>)}
          </Select>
        </Field>
        {t.type === "contact_created" && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Added by</legend>
            <div className="flex flex-col gap-2">
              {CONTACT_SOURCES.map((s) => <Checkbox key={s} label={SOURCE_LABELS[s]} checked={t.sources.includes(s)} onChange={(on) => set({ ...t, sources: on ? [...t.sources, s] : t.sources.filter((x) => x !== s) })} />)}
            </div>
            {t.sources.includes("import") && <p className="mt-2 text-xs text-warning">Imports can add thousands of contacts at once: they'll all start the flow.</p>}
          </fieldset>
        )}
        {t.type === "tag_added" && <Field label="Tag" htmlFor="trg-tag" hint="Not case-sensitive. Contacts created with this tag also start the flow."><Input id="trg-tag" value={t.tag} onChange={(e) => set({ ...t, tag: e.target.value })} placeholder="lead" maxLength={50} /></Field>}
        {t.type === "group_joined" && (
          <Field label="Group" htmlFor="trg-group">
            <Select id="trg-group" value={t.groupId} onChange={(e) => set({ ...t, groupId: e.target.value })}>
              <option value="">Choose a group…</option>
              {(groups.data?.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </Field>
        )}
        {t.type === "message_received" && (
          <Field label="Only messages containing" htmlFor="trg-kw" hint="Comma-separated keywords (whole words). Leave empty for any message.">
            <Input id="trg-kw" value={keywords} onChange={(e) => { setKeywords(e.target.value); set({ ...t, keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) }); }} placeholder="price, offer" />
          </Field>
        )}
        {t.type === "date" && (
          <>
            <Field label="Date" htmlFor="trg-field" hint="A custom field holding a date (YYYY-MM-DD or DD/MM/YYYY), or the date the contact was added.">
              <Input id="trg-field" list="trg-fields" value={t.field} onChange={(e) => set({ ...t, field: e.target.value.trim().toLowerCase() })} placeholder="birthday" />
              <datalist id="trg-fields">
                <option value="created_at">Date added</option>
                {(fields.data?.data ?? []).map((f) => <option key={f.key} value={f.key} />)}
              </datalist>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Days before (−) / after" htmlFor="trg-off"><Input id="trg-off" type="number" min={-60} max={60} value={t.offsetDays} onChange={(e) => set({ ...t, offsetDays: Number(e.target.value) })} /></Field>
              <Field label="At" htmlFor="trg-time"><Input id="trg-time" type="time" value={t.time} onChange={(e) => set({ ...t, time: e.target.value })} /></Field>
            </div>
            <Checkbox label="Every year (birthdays, anniversaries)" checked={t.yearly} onChange={(yearly) => set({ ...t, yearly })} />
          </>
        )}
        {t.type === "manual" && <p className="text-sm text-fg-muted">Once the flow is on, add contacts with “Add contacts” (a group or a segment).</p>}
        <Field label="Can a contact go through it again?" htmlFor="trg-re">
          <Select id="trg-re" value={draft.reentry} onChange={(e) => onChange({ reentry: e.target.value as Draft["reentry"] })}>
            <option value="never">No, only once</option>
            <option value="after_exit">Yes, once they've finished it</option>
          </Select>
        </Field>
        <Field label="Notes" htmlFor="trg-desc"><Textarea id="trg-desc" rows={2} value={draft.description ?? ""} onChange={(e) => onChange({ description: e.target.value })} maxLength={500} /></Field>
      </fieldset>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step editor
// ---------------------------------------------------------------------------

function StepEditor({ step, all, disabled, stats, onChange, onRemove, onMove, onClose }: { step: Step; all: Step[]; disabled: boolean; stats?: Stats; onChange: (s: Step) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void; onClose: () => void }) {
  const confirm = useConfirm();
  const o = stats?.outcomes[step.id];
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2">{STEP_ICONS[step.type]} {STEP_LABELS[step.type]}</span>}
        description={o ? Object.entries(o).map(([k, n]) => `${formatNumber(n)} ${k}`).join(" · ") : undefined}
        actions={
          <div className="flex items-center">
            {!disabled && (
              <>
                <Button size="icon" variant="ghost" aria-label="Move up" onClick={() => onMove(-1)}><ArrowUp className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="Move down" onClick={() => onMove(1)}><ArrowDown className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="Delete step" onClick={async () => { if (step.type !== "condition" || (step.yes.length + step.no.length === 0) || (await confirm({ title: "Delete this condition?", description: "The steps in both branches are deleted too.", confirmText: "Delete", destructive: true }))) onRemove(); }}>
                  <Trash2 className="h-4 w-4 text-danger" />
                </Button>
              </>
            )}
            <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}><X className="h-4 w-4" /></Button>
          </div>
        }
      />
      <fieldset disabled={disabled} className="flex flex-col gap-4 p-5">
        <StepFields step={step} all={all} onChange={onChange} />
      </fieldset>
    </Card>
  );
}

function StepFields({ step: s, all, onChange }: { step: Step; all: Step[]; onChange: (s: Step) => void }) {
  switch (s.type) {
    case "send_whatsapp":
      return <WhatsappFields step={s} onChange={onChange} />;
    case "send_email":
      return (
        <>
          <Field label="Subject" htmlFor="st-subj" hint={MERGE_HINT}><Input id="st-subj" value={s.subject} onChange={(e) => onChange({ ...s, subject: e.target.value })} maxLength={200} /></Field>
          <Field label="Preview text" htmlFor="st-prev"><Input id="st-prev" value={s.previewText ?? ""} onChange={(e) => onChange({ ...s, previewText: e.target.value })} maxLength={200} /></Field>
          <EmailContentField value={{ design: (s.design ?? null) as never, contentHtml: s.contentHtml }} onChange={(v) => onChange({ ...s, design: v.design, contentHtml: v.contentHtml })} mergeTags={MERGE_TAGS} title={s.subject} idPrefix={`st-${s.id}`} />
          <Field label="Sender name" htmlFor="st-sender" hint="Leave empty to use your email settings."><Input id="st-sender" value={s.senderName ?? ""} onChange={(e) => onChange({ ...s, senderName: e.target.value })} maxLength={100} /></Field>
          <p className="text-xs text-fg-muted">Includes an unsubscribe link. Contacts who unsubscribed or bounced are skipped.</p>
        </>
      );
    case "send_sms": {
      const seg = calculateSegments(s.message);
      return (
        <Field label="Message" htmlFor="st-sms" hint={`${seg.segments} SMS segment${seg.segments === 1 ? "" : "s"} · ${MERGE_HINT}`}>
          <Textarea id="st-sms" rows={4} value={s.message} onChange={(e) => onChange({ ...s, message: e.target.value })} maxLength={1600} />
        </Field>
      );
    }
    case "wait":
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Wait" htmlFor="st-amt"><Input id="st-amt" type="number" min={1} max={365} value={s.amount} onChange={(e) => onChange({ ...s, amount: Math.max(1, Number(e.target.value) || 1) })} /></Field>
            <Field label="Unit" htmlFor="st-unit">
              <Select id="st-unit" value={s.unit} onChange={(e) => onChange({ ...s, unit: e.target.value as "days" })}>
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </Select>
            </Field>
          </div>
          <Checkbox label="Then wait until a time of day" checked={Boolean(s.until)} onChange={(on) => onChange({ ...s, until: on ? "10:00" : null })} />
          {s.until && <Field label="Time (your time zone)" htmlFor="st-until"><Input id="st-until" type="time" value={s.until} onChange={(e) => onChange({ ...s, until: e.target.value })} /></Field>}
          <Checkbox label="Only continue on weekdays" checked={Boolean(s.weekdaysOnly)} onChange={(weekdaysOnly) => onChange({ ...s, weekdaysOnly })} />
        </>
      );
    case "condition":
      return <ConditionFields step={s} all={all} onChange={onChange} />;
    case "add_tags":
    case "remove_tags":
      return <TagsField step={s} onChange={onChange} />;
    case "add_to_group":
    case "remove_from_group":
      return <GroupField step={s} onChange={onChange} />;
    case "update_field":
      return (
        <>
          <Field label="Custom field" htmlFor="st-key" hint="Lower-case letters, digits and _"><Input id="st-key" value={s.key} onChange={(e) => onChange({ ...s, key: e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_") })} placeholder="stage" /></Field>
          <Field label="New value" htmlFor="st-val" hint={`Leave empty to clear it. ${MERGE_HINT}`}><Input id="st-val" value={s.value} onChange={(e) => onChange({ ...s, value: e.target.value })} maxLength={500} placeholder="onboarded" /></Field>
        </>
      );
    case "notify":
      return <NotifyFields step={s} onChange={onChange} />;
    case "webhook":
      return (
        <Field label="URL" htmlFor="st-url" hint="We POST the contact's details as JSON. Private network addresses aren't allowed.">
          <Input id="st-url" type="url" value={s.url} onChange={(e) => onChange({ ...s, url: e.target.value.trim() })} placeholder="https://hooks.zapier.com/…" />
        </Field>
      );
    case "exit":
      return <p className="text-sm text-fg-muted">The contact leaves the flow here. Steps after this one don't run for them.</p>;
  }
}

function WhatsappFields({ step: s, onChange }: { step: Extract<Step, { type: "send_whatsapp" }>; onChange: (s: Step) => void }) {
  const { channels } = useChannel();
  const channelId = s.channelId || channels[0]?.id || "";
  const templates = useQuery<{ data: Template[] }>({ queryKey: ["/api/templates", { channelId, status: "approved" }], enabled: Boolean(channelId) });
  const template = s.mode === "template" ? templates.data?.data.find((t) => t.id === s.templateId) : undefined;
  const vars = template?.bodyVariables ?? 0;
  useEffect(() => {
    if (!s.channelId && channelId) onChange({ ...s, channelId });
  }, [s, channelId, onChange]);
  return (
    <>
      <Field label="From number" htmlFor="st-ch">
        <Select id="st-ch" value={channelId} onChange={(e) => onChange(s.mode === "template" ? { ...s, channelId: e.target.value, templateId: "", variables: [] } : { ...s, channelId: e.target.value })}>
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="Message type" htmlFor="st-mode" hint={s.mode === "text" ? "Free text only reaches contacts who wrote to you in the last 24 hours; others are skipped." : "Templates reach anyone who opted in."}>
        <Select id="st-mode" value={s.mode} onChange={(e) => onChange(e.target.value === "text" ? { id: s.id, type: "send_whatsapp", channelId, mode: "text", text: "" } : { id: s.id, type: "send_whatsapp", channelId, mode: "template", templateId: "", variables: [] })}>
          <option value="template">Approved template</option>
          <option value="text">Text (24-hour window only)</option>
        </Select>
      </Field>
      {s.mode === "text" ? (
        <Field label="Message" htmlFor="st-wtext" hint={MERGE_HINT}><Textarea id="st-wtext" rows={4} value={s.text} onChange={(e) => onChange({ ...s, text: e.target.value })} maxLength={4096} /></Field>
      ) : (
        <>
          <Field label="Template" htmlFor="st-tpl" hint={templates.data && !templates.data.data.length ? "No approved templates on this number yet." : undefined}>
            <Select id="st-tpl" value={s.templateId} onChange={(e) => { const t = templates.data?.data.find((x) => x.id === e.target.value); onChange({ ...s, templateId: e.target.value, variables: Array.from({ length: t?.bodyVariables ?? 0 }, (_, i) => s.variables[i] ?? (i === 0 ? "{{first_name}}" : "")) }); }}>
              <option value="">Choose a template…</option>
              {(templates.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
            </Select>
          </Field>
          {template && (
            <>
              <p className="rounded-md bg-subtle p-3 text-sm whitespace-pre-wrap">{template.body}</p>
              {Array.from({ length: vars }, (_, i) => (
                <Field key={i} label={`{{${i + 1}}}`} htmlFor={`st-var-${i}`}>
                  <Input id={`st-var-${i}`} value={s.variables[i] ?? ""} onChange={(e) => { const v = [...s.variables]; v[i] = e.target.value; onChange({ ...s, variables: v }); }} placeholder="{{first_name}}" />
                </Field>
              ))}
              {vars > 0 && <p className="text-xs text-fg-muted">{MERGE_HINT}</p>}
            </>
          )}
        </>
      )}
    </>
  );
}

function ConditionFields({ step: s, all, onChange }: { step: Extract<Step, { type: "condition" }>; all: Step[]; onChange: (s: Step) => void }) {
  const groups = useQuery<{ data: Group[] }>({ queryKey: ["/api/groups"] });
  const fields = useContactFields();
  const sends = stepsBefore(all, s.id).filter((x): x is Extract<Step, { type: "send_whatsapp" | "send_email" | "send_sms" }> => x.type in EVENTS_BY_STEP && !(x.type === "send_whatsapp" && x.mode === "text"));
  const check = s.check;
  return (
    <>
      <Field label="Check" htmlFor="st-kind">
        <Select
          id="st-kind"
          value={check.kind}
          onChange={(e) =>
            onChange({ ...s, check: e.target.value === "step" ? { kind: "step", stepId: sends[0]?.id ?? "", event: (sends[0] ? EVENTS_BY_STEP[sends[0].type][0] : "opened") as ConditionEvent } : { kind: "contact", rules: { match: "all", conditions: [blankCondition("tag") as never] } } })
          }
        >
          <option value="contact">The contact's details (tags, groups, fields…)</option>
          <option value="step" disabled={!sends.length}>What they did with an earlier message{sends.length ? "" : " (add a message step first)"}</option>
        </Select>
      </Field>
      {check.kind === "step" ? (
        <>
          <Field label="Message" htmlFor="st-ref">
            <Select id="st-ref" value={check.stepId} onChange={(e) => { const t = sends.find((x) => x.id === e.target.value); onChange({ ...s, check: { ...check, stepId: e.target.value, event: t && EVENTS_BY_STEP[t.type].includes(check.event) ? check.event : (t ? EVENTS_BY_STEP[t.type][0] : check.event) } }); }}>
              {sends.map((x) => <option key={x.id} value={x.id}>{STEP_LABELS[x.type]}: {summarize(x, all).slice(0, 50)}</option>)}
            </Select>
          </Field>
          <Field label="Has it…" htmlFor="st-ev">
            <Select id="st-ev" value={check.event} onChange={(e) => onChange({ ...s, check: { ...check, event: e.target.value as ConditionEvent } })}>
              {CONDITION_EVENTS.filter((ev) => { const t = sends.find((x) => x.id === check.stepId); return !t || EVENTS_BY_STEP[t.type].includes(ev); }).map((ev) => <option key={ev} value={ev}>{EVENT_LABELS[ev]}</option>)}
            </Select>
          </Field>
          <p className="text-xs text-fg-muted">Tip: put a wait before this check so the contact has time to open or reply.</p>
        </>
      ) : (
        <>
          <Field label="Match" htmlFor="st-match">
            <Select id="st-match" value={check.rules.match} onChange={(e) => onChange({ ...s, check: { ...check, rules: { ...check.rules, match: e.target.value as "all" } } })}>
              <option value="all">All of these</option>
              <option value="any">Any of these</option>
            </Select>
          </Field>
          {check.rules.conditions.map((c, i) => (
            <div key={i} className="flex items-start gap-1 rounded-md border border-border p-2">
              <ConditionRow c={c as Cond} groups={groups.data?.data ?? []} fieldKeys={(fields.data?.data ?? []).map((f) => f.key)} onChange={(n) => onChange({ ...s, check: { ...check, rules: { ...check.rules, conditions: check.rules.conditions.map((x, j) => (j === i ? (n as never) : x)) } } })} />
              <Button size="icon" variant="ghost" aria-label="Remove condition" disabled={check.rules.conditions.length === 1} onClick={() => onChange({ ...s, check: { ...check, rules: { ...check.rules, conditions: check.rules.conditions.filter((_, j) => j !== i) } } })}><X className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" className="self-start" disabled={check.rules.conditions.length >= 20} onClick={() => onChange({ ...s, check: { ...check, rules: { ...check.rules, conditions: [...check.rules.conditions, blankCondition("tag") as never] } } })}><Plus className="h-3.5 w-3.5" /> Add condition</Button>
        </>
      )}
    </>
  );
}

function TagsField({ step: s, onChange }: { step: Extract<Step, { type: "add_tags" | "remove_tags" }>; onChange: (s: Step) => void }) {
  const [text, setText] = useState(s.tags.join(", "));
  return (
    <Field label="Tags" htmlFor="st-tags" hint="Comma-separated">
      <Input id="st-tags" value={text} onChange={(e) => { setText(e.target.value); onChange({ ...s, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10) }); }} placeholder="customer, vip" />
    </Field>
  );
}

function GroupField({ step: s, onChange }: { step: Extract<Step, { type: "add_to_group" | "remove_from_group" }>; onChange: (s: Step) => void }) {
  const groups = useQuery<{ data: Group[] }>({ queryKey: ["/api/groups"] });
  return (
    <Field label="Group" htmlFor="st-group">
      <Select id="st-group" value={s.groupId} onChange={(e) => onChange({ ...s, groupId: e.target.value })}>
        <option value="">Choose a group…</option>
        {(groups.data?.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </Select>
    </Field>
  );
}

function NotifyFields({ step: s, onChange }: { step: Extract<Step, { type: "notify" }>; onChange: (s: Step) => void }) {
  const team = useQuery<{ data: Assignee[] }>({ queryKey: ["/api/team/assignees"] });
  return (
    <>
      <Field label="Message" htmlFor="st-note" hint={MERGE_HINT}><Textarea id="st-note" rows={3} value={s.message} onChange={(e) => onChange({ ...s, message: e.target.value })} maxLength={500} /></Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Who gets it</legend>
        <p className="mb-2 text-xs text-fg-muted">Nobody ticked: the account owner.</p>
        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
          {(team.data?.data ?? []).map((u) => (
            <Checkbox key={u.id} label={[u.firstName, u.lastName].filter(Boolean).join(" ") || u.username} checked={s.userIds.includes(u.id)} onChange={(on) => onChange({ ...s, userIds: on ? [...s.userIds, u.id] : s.userIds.filter((x) => x !== u.id) })} />
          ))}
        </div>
      </fieldset>
    </>
  );
}

// ---------------------------------------------------------------------------
// Contacts in the flow
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  status: "active" | "waiting" | "completed" | "exited" | "failed";
  currentStepId: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  startedAt: string;
  finishedAt: string | null;
}
const RUN_TONE = { active: "info", waiting: "info", completed: "success", exited: "neutral", failed: "danger" } as const;

function Runs({ flowId, steps, manage }: { flowId: string; steps: Step[]; manage: boolean }) {
  const [status, setStatus] = useState<"" | RunRow["status"]>("");
  const [open, setOpen] = useState<RunRow | null>(null);
  const runs = useQuery<{ data: RunRow[] }>({ queryKey: [`/api/automations/${flowId}/runs`, status ? { status } : {}], refetchInterval: 15_000 });
  const label = (id: string | null) => {
    const s = id ? flatten(steps).find((x) => x.id === id) : undefined;
    return s ? `${STEP_LABELS[s.type]}: ${summarize(s, steps).slice(0, 40)}` : "—";
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        <Tabs
          value={status || "all"}
          onChange={(v) => setStatus(v === "all" ? "" : (v as RunRow["status"]))}
          tabs={[{ value: "all", label: "All" }, { value: "waiting", label: "Waiting" }, { value: "completed", label: "Finished" }, { value: "exited", label: "Left" }, { value: "failed", label: "Failed" }]}
        />
        {runs.isFetching && <Spinner className="h-4 w-4" />}
      </div>
      {!runs.data?.data.length ? (
        <EmptyState icon={<Users className="h-10 w-10" />} title="No contacts here yet" description="Contacts appear when the trigger enrols them." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Contact</Th>
                <Th>Status</Th>
                <Th>Next step</Th>
                <Th>Started</Th>
              </tr>
            </thead>
            <tbody>
              {runs.data.data.map((r) => (
                <Tr key={r.id} onClick={() => setOpen(r)} className="cursor-pointer">
                  <Td>
                    <p className="font-medium">{r.contactName}</p>
                    <p className="text-xs text-fg-muted">{r.contactPhone}</p>
                  </Td>
                  <Td><Badge tone={RUN_TONE[r.status]}>{r.status === "waiting" ? "waiting" : r.status}</Badge></Td>
                  <Td className="text-sm">{r.status === "waiting" || r.status === "active" ? <>{label(r.currentStepId)}{r.nextRunAt && <span className="block text-xs text-fg-muted">at {formatDate(r.nextRunAt)}</span>}</> : r.lastError ? <span className="text-xs text-fg-muted">{r.lastError}</span> : "—"}</Td>
                  <Td className="text-xs text-fg-muted">{formatDate(r.startedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {open && <RunDialog run={open} steps={steps} manage={manage} onClose={() => setOpen(null)} flowId={flowId} />}
    </Card>
  );
}

function RunDialog({ run, steps, manage, onClose, flowId }: { run: RunRow; steps: Step[]; manage: boolean; onClose: () => void; flowId: string }) {
  const toast = useToast();
  const detail = useQuery<{ data: RunRow & { log: { id: string; stepId: string; outcome: string; detail: string | null; createdAt: string }[] } }>({ queryKey: [`/api/automations/runs/${run.id}`] });
  const exit = useMutation({
    mutationFn: () => apiRequest("POST", `/api/automations/runs/${run.id}/exit`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [`/api/automations/${flowId}/runs`] });
      toast({ title: "Removed from the flow", variant: "success" });
      onClose();
    },
    onError: (err) => toast({ title: "Could not remove", description: (err as Error).message, variant: "error" }),
  });
  const stepOf = (id: string) => flatten(steps).find((s) => s.id === id);
  const live = run.status === "active" || run.status === "waiting";
  return (
    <Dialog open onClose={onClose} title={run.contactName} description={`${run.contactPhone} · started ${formatDate(run.startedAt)}`} footer={manage && live ? <Button variant="danger" onClick={() => exit.mutate()} loading={exit.isPending}>Remove from flow</Button> : undefined}>
      {detail.isLoading ? (
        <Spinner />
      ) : (
        <ol className="flex flex-col gap-2">
          {(detail.data?.data.log ?? []).map((l) => {
            const s = stepOf(l.stepId);
            return (
              <li key={l.id} className="flex items-start gap-3 rounded-md border border-border p-2.5 text-sm">
                <span className="mt-0.5 text-fg-muted">{s ? STEP_ICONS[s.type] : <Flag className="h-4 w-4" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{s ? STEP_LABELS[s.type] : "Removed step"}</span> <Badge tone={l.outcome === "failed" ? "danger" : l.outcome === "skipped" ? "neutral" : "success"}>{l.outcome}</Badge>
                  {l.detail && <span className="block truncate text-xs text-fg-muted">{l.detail}</span>}
                </span>
                <time className="shrink-0 text-xs text-fg-muted">{formatDate(l.createdAt)}</time>
              </li>
            );
          })}
          {detail.data && !detail.data.data.log.length && <p className="text-sm text-fg-muted">No steps have run yet.</p>}
          {live && run.nextRunAt && <p className="text-xs text-fg-muted">Next: {stepOf(run.currentStepId ?? "") ? STEP_LABELS[stepOf(run.currentStepId!)!.type] : "end"} at {formatDate(run.nextRunAt)}</p>}
        </ol>
      )}
    </Dialog>
  );
}

function EnrolDialog({ open, onClose, flowId }: { open: boolean; onClose: () => void; flowId: string }) {
  const toast = useToast();
  const [by, setBy] = useState<"group" | "segment">("group");
  const [target, setTarget] = useState("");
  const groups = useQuery<{ data: Group[] }>({ queryKey: ["/api/groups"], enabled: open });
  const segments = useQuery<{ data: { id: string; name: string }[] }>({ queryKey: ["/api/segments"], enabled: open && by === "segment" });
  const enrol = useMutation({
    mutationFn: () => apiRequest<{ data: { enrolled: number; skipped: number } }>("POST", `/api/automations/${flowId}/enroll`, by === "group" ? { groupId: target } : { segmentId: target }),
    onSuccess: (r) => {
      toast({ title: `${formatNumber(r.data.enrolled)} contact${r.data.enrolled === 1 ? "" : "s"} added`, description: r.data.skipped ? `${formatNumber(r.data.skipped)} skipped (already in the flow or been through it).` : undefined, variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [`/api/automations/${flowId}/runs`] });
      void queryClient.invalidateQueries({ queryKey: [`/api/automations/${flowId}/stats`] });
      onClose();
    },
    onError: (err) => toast({ title: "Could not add contacts", description: err instanceof ApiError ? err.message : (err as Error).message, variant: "error" }),
  });
  const options = by === "group" ? (groups.data?.data ?? []) : (segments.data?.data ?? []);
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Add contacts to this flow" description="Active contacts start at the first step right away." footer={<Button onClick={() => enrol.mutate()} loading={enrol.isPending} disabled={!target}>Add contacts</Button>}>
      <div className="flex flex-col gap-4">
        <Tabs value={by} onChange={(v) => { setBy(v); setTarget(""); }} tabs={[{ value: "group", label: "A group" }, { value: "segment", label: "A segment" }]} />
        <Field label={by === "group" ? "Group" : "Segment"} htmlFor="enrol-target">
          <Select id="enrol-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

