import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, Eye, FlaskConical, MessageSquareText, Pause, Pencil, Play, Plus, Send, Trash2, XCircle } from "lucide-react";
import type { SmsCampaign, SmsRecipient } from "@shared/schema";
import type { Paginated } from "@shared/api-types";
import { calculateSegments, MERGE_TAGS } from "@shared/sms";
import { useContactFields } from "@/components/contact-fields";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, formatDate, formatNumber } from "@/lib/utils";
import { ChannelShell } from "@/components/channel-shell";
import { useOpenFromQuery } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, ProgressBar, Spinner, StatCard, StatusBadge } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";
import { rewriteTextUrls, SHORT_CODE_LENGTH } from "@shared/tracking";
import type { Delivery } from "@shared/sending";
import { DEFAULT_DELIVERY, DeliveryOptions } from "@/components/delivery-options";
import { AbTestFields, AbTestResults, DEFAULT_AB, type AbCommon } from "@/components/ab-test";

type SmsAb = AbCommon & { messageB: string };
const DEFAULT_SMS_AB: SmsAb = { ...DEFAULT_AB, metric: "click", messageB: "" };
import { DEFAULT_UTM, LinkStats, TrackingOptions, type TrackingValue } from "@/components/tracking-options";
import { AudiencePicker, insertAtCursor, MergeTagButtons, type AudienceValue } from "@/components/marketing";

type Campaign = Omit<SmsCampaign, "csvData"> & { csvCount: number };
type CsvRow = { phone: string; name?: string };
const SMS_TAGS = MERGE_TAGS.filter((t) => t !== "{{email}}");
const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const normalizePhone = (v: string) => v.replace(/[\s()-]/g, "");

interface SmsTemplate {
  id: string;
  name: string;
  category: string;
  message: string;
}

interface Gateway {
  id: string;
  provider: "simulator" | "twilio" | "vonage";
  accountSid: string | null;
  hasAuthToken: boolean;
  authTokenPreview: string | null;
  fromNumber: string | null;
  senderId: string | null;
  statusWebhookUrl: string | null;
}

/** Live segment / encoding readout. Personalised values can change the count per recipient. */
function SegmentMeter({ text }: { text: string }) {
  const s = calculateSegments(text.replace(/\{\{\s*first_name\s*\}\}/gi, "Alexandra").replace(/\{\{\s*name\s*\}\}/gi, "Alexandra Johnson").replace(/\{\{\s*phone\s*\}\}/gi, "+14155550123"));
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      <Badge tone={s.encoding === "UCS-2" ? "warning" : "neutral"}>{s.encoding}</Badge>
      <span className="tabular-nums">
        {s.units} chars · <strong className="text-fg">{s.segments}</strong> segment{s.segments === 1 ? "" : "s"} · {s.remaining} left
      </span>
      {s.encoding === "UCS-2" && (
        <span className="text-warning">
          Unicode ({s.nonGsmChars.join(" ")}) cuts segments to {s.perSegment} chars.
        </span>
      )}
    </div>
  );
}

function Composer({ open, onClose, editing }: { open: boolean; onClose: () => void; editing: Campaign | null }) {
  const toast = useToast();
  const { activeChannel } = useChannel();
  const ref = useRef<HTMLTextAreaElement>(null);
  const fieldList = useContactFields();
  const customTags = (fieldList.data?.data ?? []).map((f) => `{{${f.key}}}`);
  const templates = useQuery<{ data: SmsTemplate[] }>({ queryKey: ["/api/sms-marketing/templates"], enabled: open });
  const gateway = useQuery<{ data: Gateway | null }>({ queryKey: ["/api/sms-marketing/gateway"], enabled: open });
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [audience, setAudience] = useState<AudienceValue<CsvRow>>({ targetAudience: "all_contacts", targetGroupId: "", csvData: [] });
  const [when, setWhen] = useState<"now" | "later" | "draft">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [tracking, setTracking] = useState<TrackingValue>({ trackClicks: false, utm: { ...DEFAULT_UTM } });
  const [delivery, setDelivery] = useState<Delivery>({ ...DEFAULT_DELIVERY });
  const [ab, setAb] = useState<SmsAb>({ ...DEFAULT_SMS_AB });
  const [testTo, setTestTo] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setMessage(editing?.message ?? "");
    setAudience({ targetAudience: (editing?.targetAudience as AudienceValue<CsvRow>["targetAudience"]) ?? "all_contacts", targetGroupId: editing?.targetGroupId ?? "", targetSegmentId: editing?.targetSegmentId ?? "", csvData: [] });
    setWhen(editing ? (editing.status === "scheduled" ? "later" : "draft") : "now");
    setScheduledAt(editing?.scheduledAt ? new Date(new Date(editing.scheduledAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
    setTracking({ trackClicks: editing?.trackClicks ?? false, utm: { ...DEFAULT_UTM, ...(editing?.utm ?? {}) } });
    setDelivery({ ...DEFAULT_DELIVERY, ...((editing?.delivery as Delivery | null) ?? {}) });
    setAb({ ...DEFAULT_SMS_AB, ...((editing?.abTest as Partial<SmsAb> | null) ?? {}) });
  }, [open, editing]);

  const countParams = audience.targetAudience === "csv" ? null : { channelId: activeChannel!.id, targetAudience: audience.targetAudience, targetGroupId: audience.targetGroupId || undefined, targetSegmentId: audience.targetSegmentId || undefined };
  const count = useQuery<{ count: number }>({ queryKey: ["/api/sms-marketing/audience", countParams ?? {}], enabled: open && !!countParams && (audience.targetAudience !== "group" || !!audience.targetGroupId) && (audience.targetAudience !== "segment" || !!audience.targetSegmentId) });
  const recipients = audience.targetAudience === "csv" ? audience.csvData.length || editing?.csvCount || 0 : count.data?.count ?? 0;
  // Tracked links are replaced by short links before sending; count with their length.
  const sendText = tracking.trackClicks ? rewriteTextUrls(message, () => `${window.location.origin}/s/${"x".repeat(SHORT_CODE_LENGTH)}`) : message;
  const segments = calculateSegments(sendText).segments;

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        channelId: activeChannel!.id,
        name,
        message,
        targetAudience: audience.targetAudience,
        targetGroupId: audience.targetGroupId || null,
        targetSegmentId: audience.targetSegmentId || null,
        csvData: audience.csvData,
        scheduledAt: when === "later" && scheduledAt ? new Date(scheduledAt).toISOString() : null,
        trackClicks: tracking.trackClicks,
        utm: tracking.utm,
        delivery,
        abTest: ab.enabled ? ab : null,
      };
      const res = editing
        ? await apiRequest<{ data: SmsCampaign }>("PUT", `/api/sms-marketing/campaigns/${editing.id}`, body)
        : await apiRequest<{ data: SmsCampaign }>("POST", "/api/sms-marketing/campaigns", body);
      if (when === "now") await apiRequest("POST", `/api/sms-marketing/campaigns/${res.data.id}/send`);
    },
    onSuccess: () => {
      toast({ title: when === "now" ? "SMS campaign is sending" : when === "later" ? "SMS campaign scheduled" : "Draft saved", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/sms-marketing/campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/sms-marketing/analytics"] });
      onClose();
    },
    onError: (err) => {
      toast({ title: "Could not save campaign", description: (err as Error).message, variant: "error" });
      void queryClient.invalidateQueries({ queryKey: ["/api/sms-marketing/campaigns"] });
    },
  });
  const test = useMutation({
    mutationFn: () => apiRequest<{ provider: string }>("POST", "/api/sms-marketing/test", { to: normalizePhone(testTo), message: message.replace(/\{\{\s*(first_name|name)\s*\}\}/gi, "there") }),
    onSuccess: (r) => toast({ title: r.provider === "simulator" ? "Test accepted by the SMS simulator" : `Test SMS sent via ${r.provider}`, variant: "success" }),
    onError: (err) => toast({ title: "Test failed", description: (err as Error).message, variant: "error" }),
  });

  const audienceOk = audience.targetAudience === "all_contacts" || (audience.targetAudience === "group" ? !!audience.targetGroupId : audience.targetAudience === "segment" ? !!audience.targetSegmentId && recipients > 0 : recipients > 0);
  const valid = name.trim() && message.trim() && audienceOk && (when !== "later" || scheduledAt);
  const provider = gateway.data?.data?.provider ?? "simulator";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={editing ? `Edit "${editing.name}"` : "New SMS campaign"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
            {when === "now" ? <><Send className="h-4 w-4" /> Save & send</> : when === "later" ? "Schedule" : "Save draft"}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          {provider === "simulator" && (
            <p className="flex items-center gap-2 rounded-md bg-info-soft px-3 py-2 text-sm text-info">
              <FlaskConical className="h-4 w-4 shrink-0" /> No SMS gateway configured — messages go to the simulator and are not delivered.
            </p>
          )}
          <Field label="Campaign name" htmlFor="sms-name">
            <Input id="sms-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label={
              <span className="flex flex-wrap items-center justify-between gap-2">
                Message
                <MergeTagButtons tags={[...SMS_TAGS, ...customTags]} onInsert={(t) => setMessage(insertAtCursor(ref.current, message, t))} />
              </span>
            }
            htmlFor="sms-msg"
          >
            <Textarea id="sms-msg" ref={ref} rows={5} maxLength={1600} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <SegmentMeter text={sendText} />
          {!!templates.data?.data.length && (
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-fg-muted">Templates:</span>
              {templates.data.data.map((t) => (
                <button key={t.id} type="button" onClick={() => setMessage(t.message)} className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-subtle">
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <AudiencePicker<CsvRow>
            kind="sms"
            value={audience}
            onChange={setAudience}
            parseRow={(r) => {
              const phone = normalizePhone(r.phone ?? r.mobile ?? r.number ?? "");
              return PHONE_RE.test(phone) ? { phone, name: r.name || undefined } : null;
            }}
            csvHint="Columns: phone (international format, e.g. +14155550123), name (optional)."
          />
          <Field label="When" htmlFor="sms-when">
            <Select id="sms-when" value={when} onChange={(e) => setWhen(e.target.value as typeof when)}>
              <option value="now">Send now</option>
              <option value="later">Schedule</option>
              <option value="draft">Save as draft</option>
            </Select>
          </Field>
          {when === "later" && (
            <Field label="Send at" htmlFor="sms-at" hint="Your local time">
              <Input id="sms-at" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            </Field>
          )}
          {when !== "draft" && <DeliveryOptions channel="sms" idPrefix="sms" value={delivery} onChange={setDelivery} />}
          <TrackingOptions channel="sms" value={tracking} onChange={setTracking} campaignName={name} />
          {when !== "draft" && (
            <AbTestFields value={ab} onChange={(v) => { setAb(v); if (v.enabled && !tracking.trackClicks) setTracking({ ...tracking, trackClicks: true }); }} metrics={["click"]} audience={recipients}>
              <Field label="Variant B message" htmlFor="sms-msg-b" hint="Winner by click rate, so include a link. Turning the test on turns link tracking on.">
                <Textarea id="sms-msg-b" rows={3} value={ab.messageB} maxLength={1600} onChange={(e) => setAb({ ...ab, messageB: e.target.value })} placeholder={message} />
              </Field>
            </AbTestFields>
          )}
          <div className="flex flex-wrap gap-2 rounded-md border border-border p-3">
            <Input className="max-w-56 flex-1" placeholder="+14155550123" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Send a test SMS to" />
            <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending} disabled={!PHONE_RE.test(normalizePhone(testTo)) || !message.trim()}>Send test SMS</Button>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-border bg-subtle p-4">
            <p className="mb-2 text-center text-xs text-fg-muted">Preview</p>
            <div className="ml-auto max-w-[90%] rounded-2xl rounded-br-sm bg-info px-3 py-2 text-sm break-words whitespace-pre-wrap text-white">
              {message.replace(/\{\{\s*first_name\s*\}\}/gi, "Priya").replace(/\{\{\s*name\s*\}\}/gi, "Priya Sharma").replace(/\{\{\s*phone\s*\}\}/gi, "+919812345601") || "Your message…"}
            </div>
          </div>
          <Card className="p-4 text-sm">
            <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Estimate</p>
            <p className="mt-2 tabular-nums">
              {formatNumber(recipients)} recipients × {segments} segment{segments === 1 ? "" : "s"}
            </p>
            <p className="text-2xl font-semibold tabular-nums">{formatNumber(recipients * segments)} credits</p>
            <p className="mt-1 text-xs text-fg-muted">Personalised values may add segments for some recipients; the exact count is calculated when sending.</p>
          </Card>
        </div>
      </div>
    </Dialog>
  );
}

function CampaignDetail({ campaign, onClose }: { campaign: Campaign | null; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const id = campaign?.id;
  const c = useQuery<{ data: Campaign }>({ queryKey: [`/api/sms-marketing/campaigns/${id}`], enabled: !!id, refetchInterval: (q) => (q.state.data?.data.status === "sending" ? 3000 : false) });
  const r = useQuery<Paginated<SmsRecipient>>({ queryKey: [`/api/sms-marketing/campaigns/${id}/recipients`, { page, limit: 20 }], enabled: !!id, placeholderData: (p) => p, refetchInterval: 3000 });
  const d = c.data?.data ?? campaign;
  if (!d) return null;
  return (
    <Dialog open={!!campaign} onClose={onClose} size="xl" title={d.name} description={`via ${d.gateway} · ${d.smsSegmentsPerRecipient} segment(s) per message`}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={d.status} />
          {d.errorMessage && <span className="text-sm text-danger">{d.errorMessage}</span>}
        </div>
        <p className="rounded-md bg-subtle p-3 text-sm whitespace-pre-wrap">{d.message}</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Recipients" value={formatNumber(d.totalRecipients)} />
          <StatCard label="Sent" value={formatNumber(d.sentCount)} />
          <StatCard label="Delivered" value={formatNumber(d.deliveredCount)} />
          {d.trackClicks ? (
            <StatCard label="Clicked" value={formatNumber(d.clickedCount)} hint={`${d.deliveredCount ? Math.round(((d.clickedCount ?? 0) / d.deliveredCount) * 1000) / 10 : 0}% click rate · ${formatNumber(d.estimatedCredits)} credits`} />
          ) : (
            <StatCard label="Credits" value={formatNumber(d.estimatedCredits)} />
          )}
        </div>
        {(d.abTest as { enabled?: boolean } | null)?.enabled && (
          <AbTestResults basePath="/api/sms-marketing/campaigns" campaignId={d.id} labels={{ A: d.message, B: (d.abTest as { messageB?: string }).messageB ?? "" }} />
        )}
        {d.trackClicks && d.status !== "draft" && d.status !== "scheduled" && <LinkStats type="sms" campaignId={d.id} delivered={d.deliveredCount ?? 0} />}
        <Card>
          <CardHeader title="Recipients" />
          <Table>
            <thead>
              <tr>
                <Th>Recipient</Th>
                <Th>Status</Th>
                <Th className="text-right">Segments</Th>
                <Th className="hidden md:table-cell">Delivered</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody>
              {r.data?.data.map((x) => (
                <Tr key={x.id}>
                  <Td>
                    <p className="font-medium tabular-nums">{x.phone}</p>
                    {x.name && <p className="text-xs text-fg-muted">{x.name}</p>}
                  </Td>
                  <Td><StatusBadge status={x.status} /></Td>
                  <Td className="text-right tabular-nums">{x.segments}</Td>
                  <Td className="hidden text-fg-muted md:table-cell">{formatDate(x.deliveredAt)}</Td>
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

function CampaignsTab({ onEdit }: { onEdit: (c: Campaign) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<Campaign | null>(null);
  const { data, isLoading, error, refetch } = useQuery<Paginated<Campaign>>({
    queryKey: ["/api/sms-marketing/campaigns", { page, limit: 20 }],
    refetchInterval: (q) => (q.state.data?.data.some((c) => c.status === "sending") ? 3000 : false),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "send" | "paused" | "sending" | "cancelled" | "delete" }) =>
      action === "send"
        ? apiRequest("POST", `/api/sms-marketing/campaigns/${id}/send`)
        : action === "delete"
          ? apiRequest("DELETE", `/api/sms-marketing/campaigns/${id}`)
          : apiRequest("PATCH", `/api/sms-marketing/campaigns/${id}/status`, { status: action }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/sms-marketing/campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/sms-marketing/analytics"] });
    },
    onError: (err) => toast({ title: "Action failed", description: (err as Error).message, variant: "error" }),
  });

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading) return <div className="p-10 text-center"><Spinner /></div>;
  if (!data?.data.length) return <EmptyState icon={<MessageSquareText className="h-10 w-10" />} title="No SMS campaigns yet" description="Send a text message to all contacts, a group, or an uploaded list." />;
  const canSend = can("sms:send");

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Campaign</Th>
            <Th>Status</Th>
            <Th className="min-w-44">Progress</Th>
            <Th className="text-right">Delivered</Th>
            <Th className="text-right">Failed</Th>
            <Th className="text-right">Credits</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {data.data.map((c) => {
            const total = c.totalRecipients ?? 0;
            const done = c.sentCount ?? 0;
            return (
              <Tr key={c.id}>
                <Td>
                  <button className="text-left font-medium hover:underline" onClick={() => setViewing(c)}>{c.name}</button>
                  <p className="max-w-80 truncate text-xs text-fg-muted">{c.message}</p>
                  <p className="text-xs text-fg-muted">{c.status === "scheduled" ? `scheduled ${formatDate(c.scheduledAt)}` : formatDate(c.createdAt)}</p>
                </Td>
                <Td>
                  <StatusBadge status={c.status} />
                  {c.errorMessage && <p className="mt-1 max-w-48 truncate text-xs text-danger" title={c.errorMessage}>{c.errorMessage}</p>}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <ProgressBar value={total ? (Math.min(done, total) / total) * 100 : 0} tone={c.status === "sent" ? "success" : "primary"} />
                    <span className="shrink-0 text-xs text-fg-muted tabular-nums">{formatNumber(c.sentCount)}/{formatNumber(total)}</span>
                  </div>
                </Td>
                <Td className="text-right tabular-nums">{formatNumber(c.deliveredCount)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(c.failedCount)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(c.estimatedCredits)}</Td>
                <Td className="text-right whitespace-nowrap">
                  <Button size="icon" variant="ghost" aria-label="View" onClick={() => setViewing(c)}><Eye className="h-4 w-4" /></Button>
                  {canSend && ["draft", "scheduled"].includes(c.status ?? "") && (
                    <>
                      <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => onEdit(c)}><Pencil className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" aria-label="Send now" onClick={async () => {
                        if (await confirm({ title: `Send "${c.name}" now?`, description: "Your SMS provider charges per segment.", confirmText: "Send now" })) act.mutate({ id: c.id, action: "send" });
                      }}><Send className="h-4 w-4" /></Button>
                    </>
                  )}
                  {canSend && c.status === "sending" && <Button size="icon" variant="ghost" aria-label="Pause" onClick={() => act.mutate({ id: c.id, action: "paused" })}><Pause className="h-4 w-4" /></Button>}
                  {canSend && ["paused", "failed"].includes(c.status ?? "") && <Button size="icon" variant="ghost" aria-label="Resume" onClick={() => act.mutate({ id: c.id, action: "sending" })}><Play className="h-4 w-4" /></Button>}
                  {canSend && ["draft", "scheduled", "sending", "paused", "failed"].includes(c.status ?? "") && (
                    <Button size="icon" variant="ghost" aria-label="Cancel" onClick={async () => {
                      if (await confirm({ title: `Cancel "${c.name}"?`, description: "Messages not yet sent won't be sent.", confirmText: "Cancel campaign", destructive: true })) act.mutate({ id: c.id, action: "cancelled" });
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

function GatewayTab() {
  const { can, user } = useAuth();
  const toast = useToast();
  const canEdit = user?.role === "admin" && can("settings:edit");
  const { data, isLoading } = useQuery<{ data: Gateway | null }>({ queryKey: ["/api/sms-marketing/gateway"] });
  const [v, setV] = useState({ provider: "simulator" as Gateway["provider"], accountSid: "", authToken: "", fromNumber: "", senderId: "" });
  useEffect(() => {
    const g = data?.data;
    if (g) setV({ provider: g.provider, accountSid: g.accountSid ?? "", authToken: "", fromNumber: g.fromNumber ?? "", senderId: g.senderId ?? "" });
  }, [data?.data]);
  const save = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/sms-marketing/gateway", v.provider === "simulator" ? { provider: "simulator" } : { ...v, authToken: v.authToken || undefined }),
    onSuccess: () => {
      toast({ title: "SMS gateway saved", variant: "success" });
      setV((s) => ({ ...s, authToken: "" }));
      void queryClient.invalidateQueries({ queryKey: ["/api/sms-marketing/gateway"] });
    },
    onError: (err) => toast({ title: "Could not save gateway", description: (err as Error).message, variant: "error" }),
  });
  if (isLoading) return <div className="p-10 text-center"><Spinner /></div>;
  const g = data?.data;
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const isVonage = v.provider === "vonage";

  return (
    <Card>
      <CardHeader title="SMS gateway" description="The provider that delivers your SMS campaigns. Credentials are stored encrypted when ENCRYPTION_KEY is set." />
      <div className="flex max-w-2xl flex-col gap-4 p-5">
        <Field label="Provider" htmlFor="gw-provider">
          <Select id="gw-provider" value={v.provider} onChange={(e) => setV((s) => ({ ...s, provider: e.target.value as Gateway["provider"] }))} disabled={!canEdit}>
            <option value="simulator">Simulator (no real messages)</option>
            <option value="twilio">Twilio</option>
            <option value="vonage">Vonage (Nexmo)</option>
          </Select>
        </Field>
        {v.provider !== "simulator" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={isVonage ? "API key" : "Account SID"} htmlFor="gw-sid">
                <Input id="gw-sid" value={v.accountSid} onChange={set("accountSid")} autoComplete="off" disabled={!canEdit} />
              </Field>
              <Field label={isVonage ? "API secret" : "Auth token"} htmlFor="gw-token" hint={g?.hasAuthToken && g.provider === v.provider ? `Saved (${g.authTokenPreview}). Leave blank to keep.` : undefined}>
                <Input id="gw-token" type="password" value={v.authToken} onChange={set("authToken")} autoComplete="new-password" disabled={!canEdit} />
              </Field>
              <Field label="Sending number" htmlFor="gw-from" hint="E.164, e.g. +14155550123">
                <Input id="gw-from" value={v.fromNumber} onChange={set("fromNumber")} disabled={!canEdit} />
              </Field>
              <Field label="Alphanumeric sender ID (optional)" htmlFor="gw-sender" hint="Up to 11 characters; not supported in every country.">
                <Input id="gw-sender" value={v.senderId} onChange={set("senderId")} maxLength={11} disabled={!canEdit} />
              </Field>
            </div>
            {g?.statusWebhookUrl && g.provider === v.provider && (
              <div className="rounded-md bg-subtle p-3 text-sm">
                <p className="font-medium">Delivery receipts</p>
                <p className="mt-1 text-fg-muted">
                  {g.provider === "twilio" ? "Sent automatically with each message as the StatusCallback." : "Set this as the delivery receipt URL in your Vonage dashboard (or it is sent per message)."}
                </p>
                <p className="mt-2 flex items-center gap-2">
                  <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs break-all">{g.statusWebhookUrl}</code>
                  <Button size="icon" variant="ghost" aria-label="Copy URL" onClick={() => void navigator.clipboard.writeText(g.statusWebhookUrl!)}><Copy className="h-4 w-4" /></Button>
                </p>
              </div>
            )}
          </>
        )}
        {canEdit ? (
          <Button className="self-start" onClick={() => save.mutate()} loading={save.isPending}>Save gateway</Button>
        ) : (
          <p className="text-sm text-fg-muted">Only the account administrator can change the gateway.</p>
        )}
      </div>
    </Card>
  );
}

export default function SmsMarketingPage({ params }: { params: { tab?: string } }) {
  const { can } = useAuth();
  const tab = params.tab === "settings" ? "settings" : "campaigns";
  const [composer, setComposer] = useState<{ open: boolean; editing: Campaign | null }>({ open: false, editing: null });
  useOpenFromQuery(() => setComposer({ open: true, editing: null }), can("sms:send"));

  return (
    <ChannelShell
      channel="sms"
      description="Text-message campaigns through Twilio or Vonage, with delivery receipts."
      actions={can("sms:send") && <Button onClick={() => setComposer({ open: true, editing: null })}><Plus className="h-4 w-4" /> New campaign</Button>}
    >
      {tab === "settings" ? <GatewayTab /> : <Card><CampaignsTab onEdit={(c) => setComposer({ open: true, editing: c })} /></Card>}
      <Composer open={composer.open} editing={composer.editing} onClose={() => setComposer({ open: false, editing: null })} />
    </ChannelShell>
  );
}
