import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Megaphone, Pause, Play, Plus, Rocket, Trash2, XCircle } from "lucide-react";
import type { Campaign, Group, Template } from "@shared/schema";
import type { Paginated } from "@shared/api-types";
import { useChannel } from "@/contexts/channel";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate, formatNumber } from "@/lib/utils";
import { ChannelShell } from "@/components/channel-shell";
import { useOpenFromQuery } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Card, EmptyState, ErrorState, ProgressBar, Spinner, StatusBadge } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";
import { TemplatePreview } from "./templates";
import { useContactFields } from "@/components/contact-fields";
import { fieldLabel } from "@shared/contact-fields";

type GroupRow = Group & { contactCount: number };

const FIELD_OPTIONS = [
  { value: "field:name", label: "Contact name" },
  { value: "field:phone", label: "Contact phone" },
  { value: "field:email", label: "Contact email" },
  { value: "static", label: "Fixed text…" },
];

function NewCampaignDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeChannel } = useChannel();
  const customFields = useContactFields(activeChannel?.id);
  // Built-in contact fields, then each custom field (age, address, …), then fixed text.
  const fieldOptions = [
    ...FIELD_OPTIONS.slice(0, 3),
    ...(customFields.data?.data ?? []).map((f) => ({ value: `field:meta.${f.key}`, label: fieldLabel(f.key) })),
    FIELD_OPTIONS[3],
  ];
  const toast = useToast();
  const channelId = activeChannel!.id;
  const templates = useQuery<{ data: Template[] }>({ queryKey: ["/api/templates", { channelId, status: "approved" }], enabled: open });
  const groups = useQuery<{ data: GroupRow[] }>({ queryKey: ["/api/groups", { channelId }], enabled: open });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [audienceType, setAudienceType] = useState<"all" | "groups">("all");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, { kind: string; text: string }>>({});
  const [when, setWhen] = useState<"now" | "later">("now");
  const [scheduledAt, setScheduledAt] = useState("");

  const template = templates.data?.data.find((t) => t.id === templateId);
  const vars = template?.bodyVariables ?? 0;

  const reset = () => {
    setName("");
    setDescription("");
    setTemplateId("");
    setAudienceType("all");
    setGroupIds([]);
    setMapping({});
    setWhen("now");
    setScheduledAt("");
  };

  const create = useMutation({
    mutationFn: async () => {
      const variableMapping = Object.fromEntries(
        Array.from({ length: vars }, (_, i) => {
          const m = mapping[String(i + 1)] ?? { kind: "field:name", text: "" };
          return [String(i + 1), m.kind === "static" ? `static:${m.text}` : m.kind];
        }),
      );
      const res = await apiRequest<{ data: Campaign }>("POST", "/api/campaigns", {
        channelId,
        name,
        description: description || null,
        templateId,
        audienceType,
        contactGroups: audienceType === "groups" ? groupIds : [],
        variableMapping,
        scheduledAt: when === "later" && scheduledAt ? new Date(scheduledAt).toISOString() : null,
      });
      if (when === "now") await apiRequest("POST", `/api/campaigns/${res.data.id}/start`);
      return res.data;
    },
    onSuccess: () => {
      toast({
        title: when === "now" ? "Campaign started" : "Campaign scheduled",
        description: when === "now" ? "Messages are being sent at your channel's rate limit." : `It will start ${formatDate(scheduledAt)}.`,
        variant: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
      reset();
      onClose();
    },
    onError: (err) => toast({ title: "Could not create campaign", description: (err as Error).message, variant: "error" }),
  });

  const audienceSize = audienceType === "groups" ? (groups.data?.data ?? []).filter((g) => groupIds.includes(g.id)).reduce((a, g) => a + g.contactCount, 0) : null;
  const valid =
    name.trim() &&
    template &&
    (audienceType === "all" || groupIds.length > 0) &&
    (when === "now" || scheduledAt) &&
    Array.from({ length: vars }, (_, i) => mapping[String(i + 1)]).every((m) => !m || m.kind !== "static" || m.text.trim());

  const previewParams = Array.from({ length: vars }, (_, i) => {
    const m = mapping[String(i + 1)] ?? { kind: "field:name", text: "" };
    return m.kind === "static" ? m.text || "…" : `[${fieldOptions.find((o) => o.value === m.kind)?.label ?? m.kind}]`;
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="New campaign"
      description="Broadcast an approved template to your contacts."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!valid}>
            <Rocket className="h-4 w-4" /> {when === "now" ? "Create & send" : "Schedule"}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-4">
          <Field label="Campaign name" htmlFor="cp-name">
            <Input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
          </Field>
          <Field label="Description (optional)" htmlFor="cp-desc">
            <Textarea id="cp-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Template" htmlFor="cp-tpl" hint={templates.data && !templates.data.data.length ? "No approved templates yet — create one first." : undefined}>
            <Select
              id="cp-tpl"
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                setMapping({});
              }}
            >
              <option value="">Choose an approved template…</option>
              {templates.data?.data.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </Select>
          </Field>
          {vars > 0 && (
            <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">Personalisation</legend>
              {Array.from({ length: vars }, (_, i) => {
                const key = String(i + 1);
                const m = mapping[key] ?? { kind: "field:name", text: "" };
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2">
                    <span className="w-12 text-sm text-fg-muted">{`{{${key}}}`}</span>
                    <Select className="w-44" value={m.kind} onChange={(e) => setMapping((s) => ({ ...s, [key]: { ...m, kind: e.target.value } }))} aria-label={`Value for {{${key}}}`}>
                      {fieldOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                    {m.kind === "static" && (
                      <Input className="min-w-40 flex-1" value={m.text} onChange={(e) => setMapping((s) => ({ ...s, [key]: { ...m, text: e.target.value } }))} aria-label={`Fixed text for {{${key}}}`} />
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}
          <Field label="Audience" htmlFor="cp-aud">
            <Select id="cp-aud" value={audienceType} onChange={(e) => setAudienceType(e.target.value as "all" | "groups")}>
              <option value="all">All active contacts</option>
              <option value="groups">Specific groups</option>
            </Select>
          </Field>
          {audienceType === "groups" && (
            <div className="flex flex-wrap gap-2">
              {(groups.data?.data ?? []).map((g) => {
                const on = groupIds.includes(g.id);
                return (
                  <button
                    type="button"
                    key={g.id}
                    onClick={() => setGroupIds((s) => (on ? s.filter((x) => x !== g.id) : [...s, g.id]))}
                    className={`rounded-full border px-3 py-1 text-sm ${on ? "border-primary bg-primary-soft text-primary" : "border-border"}`}
                    aria-pressed={on}
                  >
                    {g.name} · {formatNumber(g.contactCount)}
                  </button>
                );
              })}
              {audienceSize !== null && <p className="w-full text-xs text-fg-muted">Up to {formatNumber(audienceSize)} contacts (duplicates across groups are sent once).</p>}
            </div>
          )}
          <Field label="When" htmlFor="cp-when">
            <Select id="cp-when" value={when} onChange={(e) => setWhen(e.target.value as "now" | "later")}>
              <option value="now">Send now</option>
              <option value="later">Schedule for later</option>
            </Select>
          </Field>
          {when === "later" && (
            <Field label="Send at" htmlFor="cp-at" hint="Your local time">
              <Input id="cp-at" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)} />
            </Field>
          )}
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Preview</p>
          {template ? (
            <TemplatePreview header={template.header} body={template.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => previewParams[Number(n) - 1] ?? "")} footer={template.footer} buttons={template.buttons ?? []} />
          ) : (
            <p className="text-sm text-fg-muted">Pick a template to preview the message.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export default function CampaignsPage() {
  const { activeChannel } = useChannel();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const channelId = activeChannel!.id;
  const { data, isLoading, error, refetch } = useQuery<Paginated<Campaign>>({
    queryKey: ["/api/campaigns", { channelId, page, limit: 20 }],
    refetchInterval: (q) => (q.state.data?.data.some((c) => c.status === "running") ? 5000 : false),
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "start" | "paused" | "running" | "cancelled" | "delete" }) =>
      action === "start"
        ? apiRequest("POST", `/api/campaigns/${id}/start`)
        : action === "delete"
          ? apiRequest("DELETE", `/api/campaigns/${id}`)
          : apiRequest("PATCH", `/api/campaigns/${id}/status`, { status: action }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] }),
    onError: (err) => toast({ title: "Action failed", description: (err as Error).message, variant: "error" }),
  });

  const rows = useMemo(() => data?.data ?? [], [data]);
  useOpenFromQuery(() => setOpen(true), can("campaigns:create"));

  return (
    <ChannelShell
      channel="whatsapp"
      description="Broadcast approved templates to your contacts, with delivery and read tracking."
      actions={
        can("campaigns:create") && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        )
      }
    >
      <Card>
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="p-10 text-center">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Megaphone className="h-10 w-10" />} title="No campaigns yet" description="Create a campaign to broadcast an approved template to your contacts." />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Campaign</Th>
                  <Th>Status</Th>
                  <Th className="min-w-48">Progress</Th>
                  <Th className="text-right">Delivered</Th>
                  <Th className="text-right">Read</Th>
                  <Th className="text-right">Failed</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const total = c.recipientCount ?? 0;
                  const done = (c.sentCount ?? 0) + (c.failedCount ?? 0);
                  return (
                    <Tr key={c.id}>
                      <Td>
                        <Link href={`/analytics/campaign/${c.id}`} className="font-medium hover:underline">
                          {c.name}
                        </Link>
                        <p className="text-xs text-fg-muted">
                          {c.templateName} · {c.status === "scheduled" ? `scheduled ${formatDate(c.scheduledAt)}` : formatDate(c.createdAt)}
                        </p>
                      </Td>
                      <Td>
                        <StatusBadge status={c.status} />
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <ProgressBar value={total ? (done / total) * 100 : 0} tone={c.status === "completed" ? "success" : "primary"} />
                          <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                            {formatNumber(done)}/{formatNumber(total)}
                          </span>
                        </div>
                      </Td>
                      <Td className="text-right tabular-nums">{formatNumber(c.deliveredCount)}</Td>
                      <Td className="text-right tabular-nums">{formatNumber(c.readCount)}</Td>
                      <Td className="text-right tabular-nums">{formatNumber(c.failedCount)}</Td>
                      <Td className="text-right whitespace-nowrap">
                        {can("campaigns:send") && ["draft", "scheduled"].includes(c.status ?? "") && (
                          <Button size="icon" variant="ghost" aria-label="Send now" onClick={() => act.mutate({ id: c.id, action: "start" })}>
                            <Rocket className="h-4 w-4" />
                          </Button>
                        )}
                        {can("campaigns:edit") && c.status === "running" && (
                          <Button size="icon" variant="ghost" aria-label="Pause" onClick={() => act.mutate({ id: c.id, action: "paused" })}>
                            <Pause className="h-4 w-4" />
                          </Button>
                        )}
                        {can("campaigns:edit") && c.status === "paused" && (
                          <Button size="icon" variant="ghost" aria-label="Resume" onClick={() => act.mutate({ id: c.id, action: "running" })}>
                            <Play className="h-4 w-4" />
                          </Button>
                        )}
                        {can("campaigns:edit") && ["draft", "scheduled", "running", "paused"].includes(c.status ?? "") && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Cancel"
                            onClick={async () => {
                              if (await confirm({ title: `Cancel "${c.name}"?`, description: "Messages not yet sent will not be sent.", confirmText: "Cancel campaign", destructive: true })) {
                                act.mutate({ id: c.id, action: "cancelled" });
                              }
                            }}
                          >
                            <XCircle className="h-4 w-4" />
                          </Button>
                        )}
                        {can("campaigns:delete") && !["running", "paused"].includes(c.status ?? "") && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Delete"
                            onClick={async () => {
                              if (await confirm({ title: `Delete "${c.name}"?`, description: "Its statistics are removed permanently.", confirmText: "Delete", destructive: true })) {
                                act.mutate({ id: c.id, action: "delete" });
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-danger" />
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
            <Pagination page={page} limit={20} total={data!.total} onPage={setPage} />
          </>
        )}
      </Card>
      <NewCampaignDialog open={open} onClose={() => setOpen(false)} />
    </ChannelShell>
  );
}
