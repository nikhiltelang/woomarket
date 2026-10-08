import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Filter, Pencil, Plus, Trash2, X } from "lucide-react";
import { DATE_OPS, ENGAGEMENT_OPS, FIELD_LABELS, NO_VALUE_OPS, OP_LABELS, TEXT_OPS, describeRules, type SegmentCondition, type SegmentRules } from "@shared/segments";
import type { Group, Segment } from "@shared/schema";
import { useChannel } from "@/contexts/channel";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { formatNumber, relativeTime } from "@/lib/utils";
import { useContactFields } from "@/components/contact-fields";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, PageHeader, PageLoader, Spinner } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useConfirm, useToast } from "@/components/ui/overlay";

type Field = SegmentCondition["field"];
export type Cond = { field: Field; op: string; value: string | number; key?: string };
interface Draft {
  id?: string;
  name: string;
  description: string;
  rules: { match: "all" | "any"; conditions: Cond[] };
}
interface Preview {
  count: number;
  active: number;
  sample: { id: string; name: string; phone: string; email: string | null; status: string | null }[];
}

const FIELDS: Field[] = ["name", "email", "phone", "source", "status", "tag", "group", "created_at", "last_contact", "custom", "engagement"];

/** Operators offered for each field. */
function opsFor(field: Field): readonly string[] {
  switch (field) {
    case "status":
      return ["eq", "neq"];
    case "tag":
      return ["has", "not_has"];
    case "group":
      return ["in", "not_in"];
    case "created_at":
    case "last_contact":
      return DATE_OPS;
    case "custom":
      return [...TEXT_OPS, "gt", "lt"];
    case "engagement":
      return ENGAGEMENT_OPS;
    default:
      return TEXT_OPS;
  }
}

export function blank(field: Field): Cond {
  switch (field) {
    case "status":
      return { field, op: "eq", value: "active" };
    case "tag":
      return { field, op: "has", value: "" };
    case "group":
      return { field, op: "in", value: "" };
    case "created_at":
    case "last_contact":
      return { field, op: "within_days", value: 30 };
    case "custom":
      return { field, key: "", op: "eq", value: "" };
    case "engagement":
      return { field, op: "email_opened", value: 30 };
    default:
      return { field, op: "contains", value: "" };
  }
}

const EMPTY: Draft = { name: "", description: "", rules: { match: "all", conditions: [blank("tag")] } };

/** Conditions complete enough to evaluate (the preview skips the rest). */
export function complete(c: Cond): boolean {
  if (c.field === "custom" && !/^[a-z][a-z0-9_]{0,49}$/.test(c.key ?? "")) return false;
  if (NO_VALUE_OPS.has(c.op)) return true;
  if (["tag", "group"].includes(c.field) || c.field === "custom" || ["eq", "neq", "contains", "not_contains", "starts_with"].includes(c.op)) return String(c.value).trim() !== "";
  return String(c.value) !== "";
}

const ruleLabel = (op: string) => OP_LABELS[op]?.replace(" … ", " N ").replace("…", "N") ?? op;

export default function SegmentsPage() {
  const { activeChannel } = useChannel();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const channelId = activeChannel!.id;
  const [draft, setDraft] = useState<Draft | null>(null);
  const list = useQuery<{ data: Segment[] }>({ queryKey: ["/api/segments"] });
  const groups = useQuery<{ data: (Group & { contactCount: number })[] }>({ queryKey: ["/api/groups", { channelId }] });
  const groupName = (id: string) => groups.data?.data.find((g) => g.id === id)?.name ?? "deleted group";

  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/segments/${id}`),
    onSuccess: () => {
      toast({ title: "Segment deleted", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
    },
    onError: (err) => toast({ title: "Could not delete", description: (err as Error).message, variant: "error" }),
  });

  if (draft) return <SegmentEditor initial={draft} channelId={channelId} groups={groups.data?.data ?? []} onDone={() => setDraft(null)} />;
  if (list.isLoading) return <PageLoader />;
  const segments = list.data?.data ?? [];
  const manage = can("groups:manage");

  return (
    <PageContainer>
      <PageHeader
        title="Segments"
        description="Saved filters that update themselves. Use them as a campaign audience on WhatsApp, email or SMS."
        actions={manage && <Button onClick={() => setDraft(structuredClone(EMPTY))}><Plus className="h-4 w-4" /> New segment</Button>}
      />
      {segments.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Filter className="h-10 w-10" />}
            title="No segments yet"
            description="For example: contacts in Pune who opened an email in the last 30 days, or customers who haven't replied on WhatsApp in 90 days."
            action={manage && <Button onClick={() => setDraft(structuredClone(EMPTY))}><Plus className="h-4 w-4" /> New segment</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {segments.map((s) => {
            const rules = s.rules as unknown as SegmentRules;
            return (
              <Card key={s.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">{s.name}</h2>
                    {s.description && <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{s.description}</p>}
                  </div>
                  {manage && (
                    <div className="flex shrink-0">
                      <Button size="icon" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => setDraft({ id: s.id, name: s.name, description: s.description ?? "", rules: structuredClone(rules) as Draft["rules"] })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${s.name}`}
                        onClick={async () => {
                          if (await confirm({ title: `Delete “${s.name}”?`, description: "Contacts aren't affected.", confirmText: "Delete", destructive: true })) remove.mutate(s.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    </div>
                  )}
                </div>
                <p className="mt-3 line-clamp-3 text-sm first-letter:uppercase">{describeRules(rules, groupName)}</p>
                <SegmentCount segment={s} channelId={channelId} />
              </Card>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}

/** Live size of a saved segment in the active channel. */
function SegmentCount({ segment, channelId }: { segment: Segment; channelId: string }) {
  const { data, isLoading } = useQuery<{ data: Preview }>({ queryKey: [`/api/segments/${segment.id}/contacts`, { channelId, limit: 1 }], staleTime: 30_000 });
  return (
    <div className="mt-auto flex items-end justify-between pt-5">
      <p>
        <span className="text-2xl font-semibold tabular-nums">{isLoading ? "…" : formatNumber(data?.data.count)}</span>
        <span className="ml-1 text-sm text-fg-muted">contacts</span>
      </p>
      <span className="text-xs text-fg-muted">Updated {relativeTime(segment.updatedAt)}</span>
    </div>
  );
}

function SegmentEditor({ initial, channelId, groups, onDone }: { initial: Draft; channelId: string; groups: (Group & { contactCount: number })[]; onDone: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(initial);
  const fields = useContactFields(channelId);
  const conds = d.rules.conditions;
  const setConds = (conditions: Cond[]) => setD({ ...d, rules: { ...d.rules, conditions } });
  const setCond = (i: number, c: Cond) => setConds(conds.map((x, j) => (j === i ? c : x)));

  // Debounced live preview of the complete conditions.
  const ready = conds.filter(complete);
  const rulesKey = JSON.stringify({ match: d.rules.match, conditions: ready });
  const [debounced, setDebounced] = useState(rulesKey);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(rulesKey), 400);
    return () => clearTimeout(t);
  }, [rulesKey]);
  const preview = useQuery<{ data: Preview }>({
    queryKey: ["segment-preview", channelId, debounced],
    queryFn: () => apiRequest("POST", "/api/segments/preview", { channelId, rules: JSON.parse(debounced) }) as Promise<{ data: Preview }>,
    enabled: JSON.parse(debounced).conditions.length > 0,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => {
      const body = { name: d.name, description: d.description || null, rules: d.rules };
      return d.id ? apiRequest("PUT", `/api/segments/${d.id}`, body) : apiRequest("POST", "/api/segments", body);
    },
    onSuccess: () => {
      toast({ title: d.id ? "Segment saved" : "Segment created", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      onDone();
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });

  const incomplete = conds.length - ready.length;
  const fieldKeys = useMemo(() => (fields.data?.data ?? []).map((f) => f.key), [fields.data]);

  return (
    <PageContainer>
      <PageHeader
        title={d.id ? `Edit “${initial.name}”` : "New segment"}
        description="Contacts are matched every time the segment is used, so it stays current."
        actions={
          <>
            <Button variant="outline" onClick={onDone}><ArrowLeft className="h-4 w-4" /> Back</Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!d.name.trim() || incomplete > 0 || conds.length === 0}>Save segment</Button>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Name" htmlFor="seg-name" required>
              <Input id="seg-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={100} placeholder="Engaged in Pune" />
            </Field>
            <Field label="Description" htmlFor="seg-desc">
              <Input id="seg-desc" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} maxLength={500} />
            </Field>
          </Card>

          <Card>
            <CardHeader
              title="Conditions"
              description={
                <span className="flex flex-wrap items-center gap-1.5">
                  Contacts matching
                  <Select aria-label="Match" className="h-8 w-auto py-0" value={d.rules.match} onChange={(e) => setD({ ...d, rules: { ...d.rules, match: e.target.value as "all" | "any" } })}>
                    <option value="all">all</option>
                    <option value="any">any</option>
                  </Select>
                  of these
                </span>
              }
            />
            <ol className="divide-y divide-border">
              {conds.map((c, i) => (
                <li key={i} className="flex flex-wrap items-start gap-2 p-4">
                  <span className="mt-2.5 w-10 shrink-0 text-xs font-medium text-fg-muted uppercase">{i === 0 ? "Where" : d.rules.match === "all" ? "and" : "or"}</span>
                  <ConditionRow c={c} onChange={(n) => setCond(i, n)} groups={groups} fieldKeys={fieldKeys} />
                  <Button size="icon" variant="ghost" aria-label="Remove condition" onClick={() => setConds(conds.filter((_, j) => j !== i))} disabled={conds.length === 1}>
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ol>
            <div className="flex items-center justify-between gap-3 border-t border-border p-4">
              <Button size="sm" variant="outline" onClick={() => setConds([...conds, blank("custom")])} disabled={conds.length >= 20}>
                <Plus className="h-3.5 w-3.5" /> Add condition
              </Button>
              {incomplete > 0 && <span className="text-xs text-fg-muted">{incomplete} condition{incomplete > 1 ? "s need" : " needs"} a value</span>}
            </div>
          </Card>
        </div>

        <Card className="h-fit lg:sticky lg:top-4">
          <CardHeader title="Matching contacts" description="On this channel, right now" actions={preview.isFetching && <Spinner className="h-4 w-4" />} />
          <div className="p-5">
            {preview.error ? (
              <p className="text-sm text-danger">{(preview.error as Error).message}</p>
            ) : !preview.data ? (
              <p className="text-sm text-fg-muted">Complete a condition to see who matches.</p>
            ) : (
              <>
                <p className="text-3xl font-semibold tabular-nums">{formatNumber(preview.data.data.count)}</p>
                <p className="text-sm text-fg-muted">
                  {formatNumber(preview.data.data.active)} active · campaigns only send to active contacts
                </p>
                {preview.data.data.sample.length > 0 && (
                  <Table className="mt-4">
                    <thead>
                      <tr>
                        <Th>Contact</Th>
                        <Th className="text-right">Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.data.data.sample.map((s) => (
                        <Tr key={s.id}>
                          <Td>
                            <p className="truncate font-medium">{s.name}</p>
                            <p className="truncate text-xs text-fg-muted">{s.email || s.phone}</p>
                          </Td>
                          <Td className="text-right">
                            <Badge tone={s.status === "active" ? "success" : "neutral"}>{s.status ?? "—"}</Badge>
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )}
                {preview.data.data.count > preview.data.data.sample.length && <p className="mt-2 text-xs text-fg-muted">Showing the {preview.data.data.sample.length} most recently added.</p>}
              </>
            )}
          </div>
        </Card>
      </div>
    </PageContainer>
  );
}

export function ConditionRow({ c, onChange, groups, fieldKeys }: { c: Cond; onChange: (c: Cond) => void; groups: Group[]; fieldKeys: string[] }) {
  const ops = opsFor(c.field);
  const isDays = c.field === "engagement" || c.op === "within_days" || c.op === "older_than_days";
  const listId = "seg-field-keys";
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
      <Select aria-label="Field" className="w-40" value={c.field} onChange={(e) => onChange(blank(e.target.value as Field))}>
        {FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
      </Select>
      {c.field === "custom" && (
        <>
          <Input aria-label="Custom field name" className="w-36" list={listId} value={c.key ?? ""} placeholder="city" onChange={(e) => onChange({ ...c, key: e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
          <datalist id={listId}>{fieldKeys.map((k) => <option key={k} value={k} />)}</datalist>
        </>
      )}
      <Select
        aria-label="Operator"
        className="w-auto min-w-36"
        value={c.op}
        onChange={(e) => {
          const op = e.target.value;
          const toDays = op === "within_days" || op === "older_than_days";
          const wasDays = c.op === "within_days" || c.op === "older_than_days";
          onChange({ ...c, op, value: c.field === "created_at" || c.field === "last_contact" ? (toDays === wasDays ? c.value : toDays ? 30 : new Date().toISOString().slice(0, 10)) : c.value });
        }}
      >
        {ops.map((o) => <option key={o} value={o}>{ruleLabel(o)}</option>)}
      </Select>
      {NO_VALUE_OPS.has(c.op) ? null : c.field === "status" ? (
        <Select aria-label="Status" className="w-36" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value })}>
          {["active", "inactive", "unsubscribed", "blocked"].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      ) : c.field === "group" ? (
        <Select aria-label="Group" className="w-48" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value })}>
          <option value="">Choose a group…</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </Select>
      ) : isDays ? (
        <span className="flex items-center gap-1.5">
          <Input aria-label="Days" type="number" min={1} max={3650} className="w-24" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value === "" ? "" : Number(e.target.value) })} />
          <span className="text-sm text-fg-muted">days</span>
        </span>
      ) : c.op === "before" || c.op === "after" ? (
        <Input aria-label="Date" type="date" className="w-44" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value })} />
      ) : (
        <Input aria-label="Value" className="w-48 flex-1" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value })} placeholder={c.field === "tag" ? "vip" : c.field === "custom" ? "Pune" : ""} />
      )}
    </div>
  );
}
