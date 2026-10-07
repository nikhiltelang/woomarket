import { useEffect, useRef, useState } from "react";
import { AiDraftButton } from "@/components/ai";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Eye, Mail, MailOpen, Pause, Pencil, Play, Plus, Send, Trash2, XCircle } from "lucide-react";
import type { EmailCampaign, EmailRecipient, EmailTemplate } from "@shared/schema";
import type { Paginated } from "@shared/api-types";
import { MERGE_TAGS } from "@shared/sms";
import { useContactFields } from "@/components/contact-fields";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, formatDate, formatNumber } from "@/lib/utils";
import { ChannelShell } from "@/components/channel-shell";
import { useOpenFromQuery } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, ProgressBar, Spinner, StatCard, StatusBadge } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";
import { DEFAULT_UTM, LinkStats, TrackingOptions, type TrackingValue } from "@/components/tracking-options";
import { DEFAULT_DELIVERY, DeliveryOptions } from "@/components/delivery-options";
import { AbTestFields, AbTestResults, DEFAULT_AB, type AbCommon } from "@/components/ab-test";
import type { Delivery } from "@shared/sending";
import { AudiencePicker, type AudienceValue } from "@/components/marketing";
import { SmtpSettings } from "@/components/smtp-settings";
import { EmailContentField } from "@/components/email-builder";
import { renderDesign, starterDesign, type EmailDesign } from "@shared/email-design";

const designed = (design: EmailDesign) => ({ design, contentHtml: renderDesign(design) });

type Campaign = Omit<EmailCampaign, "csvData"> & { csvCount: number };
type CsvRow = { email: string; name?: string };
const EMAIL_TAGS = [...MERGE_TAGS.filter((t) => t !== "{{phone}}"), "{{unsubscribe_url}}"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACTIVE = ["sending"];

/** Renders sample merge values for the preview (escaped like the server does). */
function previewHtml(html: string) {
  return html
    .replace(/\{\{\s*first_name\s*\}\}/gi, "Priya")
    .replace(/\{\{\s*name\s*\}\}/gi, "Priya Sharma")
    .replace(/\{\{\s*email\s*\}\}/gi, "priya@example.com")
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, "#");
}

/** Sandboxed preview: no scripts, no same-origin access. */
export function EmailPreview({ html, className }: { html: string; className?: string }) {
  return <iframe title="Email preview" sandbox="" srcDoc={previewHtml(html)} className={cn("h-full w-full rounded-md border border-border bg-white", className)} />;
}

interface ComposerState {
  name: string;
  subject: string;
  previewText: string;
  senderName: string;
  replyTo: string;
  contentHtml: string;
  design: EmailDesign | null;
  templateId: string | null;
  audience: AudienceValue<CsvRow>;
  when: "draft" | "now" | "later";
  scheduledAt: string;
  tracking: TrackingValue;
  delivery: Delivery;
  ab: EmailAb;
}

type EmailAb = AbCommon & { subjectB: string; previewTextB: string; contentHtmlB: string | null };
const DEFAULT_EMAIL_AB: EmailAb = { ...DEFAULT_AB, subjectB: "", previewTextB: "", contentHtmlB: null };

const toLocalInput = (d: string | Date) => {
  const date = new Date(d);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function Composer({ open, onClose, editing, seed }: { open: boolean; onClose: () => void; editing: Campaign | null; seed: EmailTemplate | null }) {
  const toast = useToast();
  const { activeChannel } = useChannel();
  const templates = useQuery<{ data: EmailTemplate[] }>({ queryKey: ["/api/email-marketing/templates"], enabled: open });
  const smtp = useQuery<{ effective: { fromName?: string; source: string } }>({ queryKey: ["/api/smtp/config"], enabled: open });
  const fieldList = useContactFields();
  const customTags = (fieldList.data?.data ?? []).map((f) => `{{${f.key}}}`);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [testTo, setTestTo] = useState("");
  const [s, setS] = useState<ComposerState>(() => blank());

  function blank(): ComposerState {
    return {
      name: "",
      subject: "",
      previewText: "",
      senderName: "",
      replyTo: "",
      ...designed(starterDesign("newsletter")),
      templateId: null,
      audience: { targetAudience: "all_contacts", targetGroupId: "", csvData: [] },
      when: "now",
      scheduledAt: "",
      tracking: { trackClicks: true, utm: { ...DEFAULT_UTM } },
      delivery: { ...DEFAULT_DELIVERY },
      ab: { ...DEFAULT_EMAIL_AB },
    };
  }

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setS({
        name: editing.name,
        subject: editing.subject,
        previewText: editing.previewText ?? "",
        senderName: editing.senderName ?? "",
        replyTo: editing.replyTo ?? "",
        contentHtml: editing.contentHtml,
        design: (editing.design as EmailDesign | null) ?? null,
        templateId: editing.templateId,
        // CSV lists aren't sent back to the browser; re-upload to change them.
        audience: { targetAudience: (editing.targetAudience as AudienceValue<CsvRow>["targetAudience"]) ?? "all_contacts", targetGroupId: editing.targetGroupId ?? "", targetSegmentId: editing.targetSegmentId ?? "", csvData: [] },
        when: editing.status === "scheduled" ? "later" : "draft",
        scheduledAt: editing.scheduledAt ? toLocalInput(editing.scheduledAt) : "",
        tracking: { trackClicks: editing.trackClicks ?? true, utm: { ...DEFAULT_UTM, ...(editing.utm ?? {}) } },
        delivery: { ...DEFAULT_DELIVERY, ...((editing.delivery as Delivery | null) ?? {}) },
        ab: { ...DEFAULT_EMAIL_AB, ...((editing.abTest as Partial<EmailAb> | null) ?? {}) },
      });
    } else {
      const b = blank();
      if (seed) Object.assign(b, { contentHtml: seed.contentHtml, design: (seed.design as EmailDesign | null) ?? null, subject: seed.subject ?? "", previewText: seed.previewText ?? "", templateId: seed.isSystem ? null : seed.id, name: seed.name });
      setS(b);
    }
  }, [open, editing, seed]);

  useEffect(() => {
    if (open && !s.senderName && smtp.data?.effective.fromName) setS((x) => ({ ...x, senderName: smtp.data!.effective.fromName! }));
  }, [open, smtp.data, s.senderName]);

  const payload = () => ({
    channelId: activeChannel!.id,
    name: s.name,
    subject: s.subject,
    previewText: s.previewText || null,
    senderName: s.senderName,
    replyTo: s.replyTo || null,
    contentHtml: s.contentHtml,
    design: s.design,
    templateId: s.templateId,
    targetAudience: s.audience.targetAudience,
    targetGroupId: s.audience.targetGroupId || null,
    targetSegmentId: s.audience.targetSegmentId || null,
    csvData: s.audience.csvData,
    scheduledAt: s.when === "later" && s.scheduledAt ? new Date(s.scheduledAt).toISOString() : null,
    trackClicks: s.tracking.trackClicks,
    utm: s.tracking.utm,
    delivery: s.delivery,
    abTest: s.ab.enabled ? { ...s.ab, previewTextB: s.ab.previewTextB || null } : null,
  });

  const save = useMutation({
    mutationFn: async () => {
      const res = editing
        ? await apiRequest<{ data: EmailCampaign }>("PUT", `/api/email-marketing/campaigns/${editing.id}`, payload())
        : await apiRequest<{ data: EmailCampaign }>("POST", "/api/email-marketing/campaigns", payload());
      if (s.when === "now") await apiRequest("POST", `/api/email-marketing/campaigns/${res.data.id}/send`);
      return res.data;
    },
    onSuccess: () => {
      toast({
        title: s.when === "now" ? "Campaign is sending" : s.when === "later" ? "Campaign scheduled" : "Draft saved",
        variant: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/email-marketing/campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/email-marketing/analytics"] });
      onClose();
    },
    onError: (err) => {
      toast({ title: "Could not save campaign", description: (err as Error).message, variant: "error" });
      void queryClient.invalidateQueries({ queryKey: ["/api/email-marketing/campaigns"] });
    },
  });

  const sendTest = useMutation({
    mutationFn: async () => {
      // Tests render the saved campaign, so save a draft first when needed.
      let id = editing?.id;
      if (!id) {
        const res = await apiRequest<{ data: EmailCampaign }>("POST", "/api/email-marketing/campaigns", { ...payload(), scheduledAt: null });
        id = res.data.id;
      } else {
        await apiRequest("PUT", `/api/email-marketing/campaigns/${id}`, payload());
      }
      const r = await apiRequest<{ simulated: boolean }>("POST", `/api/email-marketing/campaigns/${id}/test`, { email: testTo });
      return { ...r, id };
    },
    onSuccess: (r) => {
      toast({ title: r.simulated ? "Test captured by the email simulator" : `Test sent to ${testTo}`, description: editing ? undefined : "Saved as a draft.", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/email-marketing/campaigns"] });
      if (!editing) onClose();
    },
    onError: (err) => toast({ title: "Test failed", description: (err as Error).message, variant: "error" }),
  });

  const set = <K extends keyof ComposerState>(k: K, val: ComposerState[K]) => setS((x) => ({ ...x, [k]: val }));
  const audienceOk = s.audience.targetAudience === "all_contacts" || (s.audience.targetAudience === "group" ? !!s.audience.targetGroupId : s.audience.targetAudience === "segment" ? !!s.audience.targetSegmentId : s.audience.csvData.length > 0 || (editing?.targetAudience === "csv" && editing.csvCount > 0));
  const valid = s.name.trim() && s.subject.trim() && s.senderName.trim() && s.contentHtml.trim() && audienceOk && (s.when !== "later" || s.scheduledAt);
  const csvKept = editing?.targetAudience === "csv" && s.audience.targetAudience === "csv" && s.audience.csvData.length === 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={editing ? `Edit "${editing.name}"` : "New email campaign"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
            {s.when === "now" ? (
              <>
                <Send className="h-4 w-4" /> Save & send
              </>
            ) : s.when === "later" ? (
              "Schedule"
            ) : (
              "Save draft"
            )}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Field label="Campaign name" htmlFor="em-name" hint="Internal; recipients don't see it.">
            <Input id="em-name" value={s.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field
            label={
              <span className="flex flex-wrap items-center justify-between gap-2">
                Subject line
                <AiDraftButton channel="email_subject" current={s.subject} label="Suggest subjects" onPick={(v) => setS((x) => ({ ...x, subject: v.text, previewText: v.preview ?? x.previewText }))} />
              </span>
            }
            htmlFor="em-subject"
          >
            <Input id="em-subject" ref={subjectRef} value={s.subject} onChange={(e) => set("subject", e.target.value)} maxLength={255} />
          </Field>
          <Field label="Preview text (optional)" htmlFor="em-pre" hint="Shown after the subject in most inboxes.">
            <Input id="em-pre" value={s.previewText} onChange={(e) => set("previewText", e.target.value)} maxLength={255} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sender name" htmlFor="em-sender">
              <Input id="em-sender" value={s.senderName} onChange={(e) => set("senderName", e.target.value)} />
            </Field>
            <Field label="Reply-to (optional)" htmlFor="em-reply">
              <Input id="em-reply" type="email" value={s.replyTo} onChange={(e) => set("replyTo", e.target.value)} />
            </Field>
          </div>
          <Field label="Start from a template" htmlFor="em-tpl">
            <Select
              id="em-tpl"
              value=""
              onChange={(e) => {
                const t = templates.data?.data.find((x) => x.id === e.target.value);
                if (t) setS((x) => ({ ...x, contentHtml: t.contentHtml, design: (t.design as EmailDesign | null) ?? null, subject: x.subject || (t.subject ?? ""), previewText: x.previewText || (t.previewText ?? ""), templateId: t.isSystem ? null : t.id }));
              }}
            >
              <option value="">Replace content with a template…</option>
              {templates.data?.data.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isSystem ? " (built-in)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <EmailContentField idPrefix="em" title={s.subject || s.name} mergeTags={[...EMAIL_TAGS, ...customTags]} value={{ contentHtml: s.contentHtml, design: s.design }} onChange={(v) => setS((x) => ({ ...x, ...v }))} />
          <AudiencePicker<CsvRow>
            kind="email"
            value={s.audience}
            onChange={(audience) => set("audience", audience)}
            parseRow={(r) => {
              const email = (r.email ?? r["e-mail"] ?? "").toLowerCase();
              return EMAIL_RE.test(email) ? { email, name: r.name || r.full_name || undefined } : null;
            }}
            csvHint="Columns: email (required), name (optional)."
          />
          {csvKept && <p className="text-xs text-fg-muted">Keeping the previously uploaded list of {formatNumber(editing!.csvCount)} recipients. Re-upload to replace it.</p>}
          <Field label="When" htmlFor="em-when">
            <Select id="em-when" value={s.when} onChange={(e) => set("when", e.target.value as ComposerState["when"])}>
              <option value="now">Send now</option>
              <option value="later">Schedule</option>
              <option value="draft">Save as draft</option>
            </Select>
          </Field>
          {s.when === "later" && (
            <Field label="Send at" htmlFor="em-at" hint="Your local time">
              <Input id="em-at" type="datetime-local" value={s.scheduledAt} onChange={(e) => set("scheduledAt", e.target.value)} />
            </Field>
          )}
          {s.when !== "draft" && <DeliveryOptions channel="email" idPrefix="em" value={s.delivery} onChange={(delivery) => set("delivery", delivery)} />}
          <TrackingOptions channel="email" value={s.tracking} onChange={(tracking) => set("tracking", tracking)} campaignName={s.name} />
          {s.when !== "draft" && (
            <AbTestFields value={s.ab} onChange={(ab) => set("ab", ab)} metrics={s.tracking.trackClicks ? ["open", "click"] : ["open"]}>
              <Field label="Variant B subject" htmlFor="em-subject-b" hint="Leave blank to test content only.">
                <Input id="em-subject-b" value={s.ab.subjectB} onChange={(e) => set("ab", { ...s.ab, subjectB: e.target.value })} placeholder={s.subject} />
              </Field>
              <Checkbox
                label="Different content for B"
                checked={s.ab.contentHtmlB !== null}
                onChange={(on) => set("ab", { ...s.ab, contentHtmlB: on ? s.contentHtml : null })}
              />
              {s.ab.contentHtmlB !== null && (
                <Field label="Variant B content (HTML)" htmlFor="em-html-b">
                  <Textarea id="em-html-b" rows={8} className="w-full font-mono text-xs" value={s.ab.contentHtmlB} onChange={(e) => set("ab", { ...s.ab, contentHtmlB: e.target.value })} />
                </Field>
              )}
            </AbTestFields>
          )}
          <div className="flex flex-wrap gap-2 rounded-md border border-border p-3">
            <Input type="email" className="max-w-56 flex-1" placeholder="you@example.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Send a test to" />
            <Button variant="outline" onClick={() => sendTest.mutate()} loading={sendTest.isPending} disabled={!EMAIL_RE.test(testTo) || !s.name || !s.subject || !s.senderName}>
              Send test
            </Button>
          </div>
        </div>
        <div className="flex min-h-[480px] min-w-0 flex-col">
          <div className="mb-2 rounded-md border border-border p-3 text-sm">
            <p className="font-medium">{s.senderName || "Sender"}</p>
            <p className="truncate">{previewHtml(s.subject) || "Subject"}</p>
            <p className="truncate text-xs text-fg-muted">{previewHtml(s.previewText)}</p>
          </div>
          <EmailPreview html={s.contentHtml} className="min-h-[420px] flex-1" />
        </div>
      </div>
    </Dialog>
  );
}

function CampaignDetail({ campaign, onClose }: { campaign: Campaign | null; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const id = campaign?.id;
  const c = useQuery<{ data: Campaign }>({ queryKey: [`/api/email-marketing/campaigns/${id}`], enabled: !!id, refetchInterval: (q) => (ACTIVE.includes(q.state.data?.data.status ?? "") ? 3000 : false) });
  const r = useQuery<Paginated<EmailRecipient>>({ queryKey: [`/api/email-marketing/campaigns/${id}/recipients`, { page, limit: 20, status: status || undefined }], enabled: !!id, placeholderData: (p) => p });
  const d = c.data?.data ?? campaign;
  if (!d) return null;
  const total = d.totalRecipients || 0;
  const pct = (n: number | null) => (d.deliveredCount ? Math.round(((n ?? 0) / d.deliveredCount) * 1000) / 10 : 0);
  return (
    <Dialog open={!!campaign} onClose={onClose} size="xl" title={d.name} description={`${d.subject} · ${d.targetAudience === "group" ? `group ${d.targetGroupName}` : d.targetAudience === "csv" ? "CSV list" : "all contacts"}`}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={d.status} />
          {d.sentAt && <span className="text-sm text-fg-muted">Finished {formatDate(d.sentAt)}</span>}
          {d.errorMessage && <span className="text-sm text-danger">{d.errorMessage}</span>}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Recipients" value={formatNumber(total)} />
          <StatCard label="Delivered" value={formatNumber(d.deliveredCount)} hint="Accepted by the mail server" />
          <StatCard label="Opened" value={formatNumber(d.openedCount)} hint={`${pct(d.openedCount)}% open rate`} />
          <StatCard label="Clicked" value={formatNumber(d.clickedCount)} hint={`${pct(d.clickedCount)}% click rate · ${formatNumber(d.failedCount)} failed`} />
        </div>
        <ProgressBar value={total ? (((d.sentCount ?? 0) + (d.failedCount ?? 0)) / total) * 100 : 0} />
        {(d.abTest as { enabled?: boolean } | null)?.enabled && (
          <AbTestResults
            basePath="/api/email-marketing/campaigns"
            campaignId={d.id}
            labels={{ A: `Subject: ${d.subject}`, B: `Subject: ${(d.abTest as { subjectB?: string }).subjectB || d.subject}${(d.abTest as { contentHtmlB?: string | null }).contentHtmlB ? " · different content" : ""}` }}
          />
        )}
        {d.trackClicks && d.status !== "draft" && d.status !== "scheduled" && <LinkStats type="email" campaignId={d.id} delivered={d.deliveredCount ?? 0} />}
        <Card>
          <CardHeader
            title="Recipients"
            actions={
              <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="h-8 w-36 text-xs" aria-label="Filter by status">
                <option value="">All</option>
                {["pending", "sent", "failed", "cancelled"].map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </Select>
            }
          />
          <Table>
            <thead>
              <tr>
                <Th>Recipient</Th>
                <Th>Status</Th>
                <Th className="hidden md:table-cell">Sent</Th>
                <Th>Opened</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {r.data?.data.map((x) => (
                <Tr key={x.id}>
                  <Td>
                    <p className="font-medium">{x.name || x.email}</p>
                    {x.name && <p className="text-xs text-fg-muted">{x.email}</p>}
                  </Td>
                  <Td><StatusBadge status={x.status} /></Td>
                  <Td className="hidden text-fg-muted md:table-cell">{formatDate(x.sentAt)}</Td>
                  <Td>{x.openedAt ? <MailOpen className="h-4 w-4 text-success" aria-label={`Opened ${formatDate(x.openedAt)}`} /> : <span className="text-fg-muted">—</span>}</Td>
                  <Td className={cn("max-w-56 truncate text-xs", x.status === "failed" ? "text-danger" : "text-fg-muted")} title={x.errorMessage ?? undefined}>{x.errorMessage}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {r.data && <Pagination page={page} limit={20} total={r.data.total} onPage={setPage} />}
        </Card>
      </div>
    </Dialog>
  );
}

function CampaignsTab({ onCompose }: { onCompose: (c: Campaign | null) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<Campaign | null>(null);
  const { data, isLoading, error, refetch } = useQuery<Paginated<Campaign>>({
    queryKey: ["/api/email-marketing/campaigns", { page, limit: 20 }],
    refetchInterval: (q) => (q.state.data?.data.some((c) => ACTIVE.includes(c.status ?? "")) ? 3000 : false),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "send" | "paused" | "sending" | "cancelled" | "delete" }) =>
      action === "send"
        ? apiRequest("POST", `/api/email-marketing/campaigns/${id}/send`)
        : action === "delete"
          ? apiRequest("DELETE", `/api/email-marketing/campaigns/${id}`)
          : apiRequest("PATCH", `/api/email-marketing/campaigns/${id}/status`, { status: action }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/email-marketing/campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/email-marketing/analytics"] });
    },
    onError: (err) => toast({ title: "Action failed", description: (err as Error).message, variant: "error" }),
  });

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading) return <div className="p-10 text-center"><Spinner /></div>;
  if (!data?.data.length) return <EmptyState icon={<Mail className="h-10 w-10" />} title="No email campaigns yet" description="Design an email, pick an audience and send or schedule it." />;
  const canSend = can("email:send");

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Campaign</Th>
            <Th>Status</Th>
            <Th className="min-w-44">Progress</Th>
            <Th className="text-right">Opened</Th>
            <Th className="text-right">Failed</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {data.data.map((c) => {
            const total = c.totalRecipients ?? 0;
            const done = (c.sentCount ?? 0) + (c.failedCount ?? 0);
            const openRate = c.deliveredCount ? Math.round(((c.openedCount ?? 0) / c.deliveredCount) * 100) : 0;
            return (
              <Tr key={c.id}>
                <Td>
                  <button className="text-left font-medium hover:underline" onClick={() => setViewing(c)}>{c.name}</button>
                  <p className="max-w-80 truncate text-xs text-fg-muted">
                    {c.subject} · {c.status === "scheduled" ? `scheduled ${formatDate(c.scheduledAt)}` : formatDate(c.createdAt)}
                  </p>
                </Td>
                <Td>
                  <StatusBadge status={c.status} />
                  {c.errorMessage && <p className="mt-1 max-w-48 truncate text-xs text-danger" title={c.errorMessage}>{c.errorMessage}</p>}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <ProgressBar value={total ? (done / total) * 100 : 0} tone={c.status === "sent" ? "success" : "primary"} />
                    <span className="shrink-0 text-xs text-fg-muted tabular-nums">{formatNumber(done)}/{formatNumber(total)}</span>
                  </div>
                </Td>
                <Td className="text-right tabular-nums">
                  {formatNumber(c.openedCount)} <span className="text-xs text-fg-muted">({openRate}%)</span>
                  {(c.clickedCount ?? 0) > 0 && <span className="block text-xs text-fg-muted">{formatNumber(c.clickedCount)} clicked</span>}
                </Td>
                <Td className="text-right tabular-nums">{formatNumber(c.failedCount)}</Td>
                <Td className="text-right whitespace-nowrap">
                  <Button size="icon" variant="ghost" aria-label="View" onClick={() => setViewing(c)}><Eye className="h-4 w-4" /></Button>
                  {canSend && ["draft", "scheduled"].includes(c.status ?? "") && (
                    <>
                      <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => onCompose(c)}><Pencil className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" aria-label="Send now" onClick={async () => {
                        if (await confirm({ title: `Send "${c.name}" now?`, confirmText: "Send now" })) act.mutate({ id: c.id, action: "send" });
                      }}><Send className="h-4 w-4" /></Button>
                    </>
                  )}
                  {canSend && c.status === "sending" && (
                    <Button size="icon" variant="ghost" aria-label="Pause" onClick={() => act.mutate({ id: c.id, action: "paused" })}><Pause className="h-4 w-4" /></Button>
                  )}
                  {canSend && ["paused", "failed"].includes(c.status ?? "") && (
                    <Button size="icon" variant="ghost" aria-label="Resume" onClick={() => act.mutate({ id: c.id, action: "sending" })}><Play className="h-4 w-4" /></Button>
                  )}
                  {canSend && ["draft", "scheduled", "sending", "paused", "failed"].includes(c.status ?? "") && (
                    <Button size="icon" variant="ghost" aria-label="Cancel" onClick={async () => {
                      if (await confirm({ title: `Cancel "${c.name}"?`, description: "Emails not yet sent won't be sent.", confirmText: "Cancel campaign", destructive: true })) act.mutate({ id: c.id, action: "cancelled" });
                    }}><XCircle className="h-4 w-4" /></Button>
                  )}
                  {canSend && !["sending", "paused"].includes(c.status ?? "") && (
                    <Button size="icon" variant="ghost" aria-label="Delete" onClick={async () => {
                      if (await confirm({ title: `Delete "${c.name}"?`, confirmText: "Delete", destructive: true })) act.mutate({ id: c.id, action: "delete" });
                    }}><Trash2 className="h-4 w-4 text-danger" /></Button>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <Pagination page={page} limit={20} total={data.total} onPage={setPage} />
      <CampaignDetail campaign={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

function TemplatesTab({ onUse }: { onUse: (t: EmailTemplate) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<EmailTemplate | "new" | null>(null);
  const [form, setForm] = useState<{ name: string; category: string; subject: string; contentHtml: string; design: EmailDesign | null }>({ name: "", category: "promotional", subject: "", ...designed(starterDesign("newsletter")) });
  const { data, isLoading } = useQuery<{ data: EmailTemplate[] }>({ queryKey: ["/api/email-marketing/templates"] });

  useEffect(() => {
    if (editing === "new") setForm({ name: "", category: "promotional", subject: "", ...designed(starterDesign("newsletter")) });
    else if (editing) setForm({ name: editing.name, category: editing.category ?? "promotional", subject: editing.subject ?? "", contentHtml: editing.contentHtml, design: (editing.design as EmailDesign | null) ?? null });
  }, [editing]);

  const save = useMutation({
    mutationFn: () =>
      editing && editing !== "new"
        ? apiRequest("PUT", `/api/email-marketing/templates/${editing.id}`, form)
        : apiRequest("POST", "/api/email-marketing/templates", form),
    onSuccess: () => {
      toast({ title: "Template saved", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/email-marketing/templates"] });
      setEditing(null);
    },
    onError: (err) => toast({ title: "Could not save template", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/email-marketing/templates/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/email-marketing/templates"] }),
  });

  if (isLoading) return <div className="p-10 text-center"><Spinner /></div>;
  return (
    <div className="p-4">
      {can("email:send") && (
        <Button variant="outline" className="mb-4" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> New template
        </Button>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {data?.data.map((t) => (
          <div key={t.id} className="flex flex-col overflow-hidden rounded-lg border border-border">
            <div className="h-48 overflow-hidden bg-white">
              <iframe title={t.name} sandbox="" srcDoc={previewHtml(t.contentHtml)} className="pointer-events-none h-[600px] w-[166%] origin-top-left scale-[0.6] border-0" tabIndex={-1} />
            </div>
            <div className="flex flex-1 flex-col gap-2 border-t border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">{t.name}</p>
                {t.isSystem ? <Badge tone="info">built-in</Badge> : <Badge>{t.category}</Badge>}
              </div>
              <p className="truncate text-xs text-fg-muted">{t.subject}</p>
              <div className="mt-auto flex gap-1">
                {can("email:send") && <Button size="sm" onClick={() => onUse(t)}>Use</Button>}
                {can("email:send") && !t.isSystem && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Edit</Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={async () => {
                      if (await confirm({ title: `Delete template "${t.name}"?`, confirmText: "Delete", destructive: true })) remove.mutate(t.id);
                    }}>Delete</Button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="xl"
        title={editing === "new" ? "New email template" : "Edit template"}
        footer={<Button onClick={() => save.mutate()} loading={save.isPending} disabled={!form.name.trim() || !form.contentHtml.trim()}>Save template</Button>}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Field label="Name" htmlFor="et-name"><Input id="et-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Category" htmlFor="et-cat">
              <Select id="et-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {["promotional", "newsletter", "transactional", "announcement"].map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Default subject" htmlFor="et-sub"><Input id="et-sub" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
            <EmailContentField idPrefix="et" title={form.subject || form.name} mergeTags={EMAIL_TAGS} value={{ contentHtml: form.contentHtml, design: form.design }} onChange={(v) => setForm((f) => ({ ...f, ...v }))} />
          </div>
          <EmailPreview html={form.contentHtml} className="min-h-[420px]" />
        </div>
      </Dialog>
    </div>
  );
}

type EmailTab = "campaigns" | "templates" | "settings";

export default function EmailMarketingPage({ params }: { params: { tab?: string } }) {
  const { can, user } = useAuth();
  const tab: EmailTab = params.tab === "templates" || params.tab === "settings" ? params.tab : "campaigns";
  const [composer, setComposer] = useState<{ open: boolean; editing: Campaign | null; seed: EmailTemplate | null }>({ open: false, editing: null, seed: null });
  useOpenFromQuery(() => setComposer({ open: true, editing: null, seed: null }), can("email:send"));

  return (
    <ChannelShell
      channel="email"
      description="Newsletters and promotions with open tracking and one-click unsubscribe."
      actions={can("email:send") && <Button onClick={() => setComposer({ open: true, editing: null, seed: null })}><Plus className="h-4 w-4" /> New campaign</Button>}
    >
      {tab === "settings" ? (
        <SmtpSettings canEdit={user?.role === "admin" && can("settings:edit")} />
      ) : (
        <Card>
          {tab === "campaigns" ? (
            <CampaignsTab onCompose={(c) => setComposer({ open: true, editing: c, seed: null })} />
          ) : (
            <TemplatesTab onUse={(t) => setComposer({ open: true, editing: null, seed: t })} />
          )}
        </Card>
      )}
      <Composer open={composer.open} editing={composer.editing} seed={composer.seed} onClose={() => setComposer({ open: false, editing: null, seed: null })} />
    </ChannelShell>
  );
}
