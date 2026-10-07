import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Download, FileText, Pencil, Plus, Send, Trash2 } from "lucide-react";
import {
  FREQUENCIES,
  formatDuration,
  pct,
  REPORT_SECTIONS,
  SECTION_LABELS,
  type FullReport,
  type ReportSection,
  type ReportScheduleInput,
} from "@shared/reports";
import type { ReportSchedule } from "@shared/schema";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { apiRequest, queryClient } from "@/lib/api";
import { CHANNELS } from "@/lib/channels";
import { formatDate, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { BarChart, RankedBars } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, Spinner, StatCard } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, Tabs, useConfirm, useToast } from "@/components/ui/overlay";

type Tab = "overview" | "team" | "response-times" | "schedules";
const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

function presets() {
  const now = new Date();
  const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastPrev = new Date(now.getFullYear(), now.getMonth(), 0);
  const firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1);
  return [
    { key: "7", label: "Last 7 days", from: daysAgo(6), to: daysAgo(0) },
    { key: "30", label: "Last 30 days", from: daysAgo(29), to: daysAgo(0) },
    { key: "month", label: "This month", from: iso(firstThis), to: daysAgo(0) },
    { key: "prev", label: "Last month", from: iso(firstPrev), to: iso(lastPrev) },
    { key: "90", label: "Last 90 days", from: daysAgo(89), to: daysAgo(0) },
  ];
}

const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const rate = (n: number, d: number) => (d ? `${pct(n, d)}%` : "—");

export default function ReportsPage() {
  const { can } = useAuth();
  const { channels } = useChannel();
  const P = useMemo(presets, []);
  const [preset, setPreset] = useState("30");
  const [range, setRange] = useState({ from: P[1].from, to: P[1].to });
  const [channelId, setChannelId] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const params = { from: range.from, to: range.to, ...(channelId ? { channelId } : {}) };
  const report = useQuery<{ data: FullReport }>({ queryKey: ["/api/reports", params], enabled: tab !== "schedules" && range.from <= range.to });
  const canExport = can("analytics:export");

  const download = (format: "pdf" | "csv", section?: ReportSection) => {
    const q = new URLSearchParams({ ...params, format, ...(section ? { section } : {}) });
    window.location.assign(`/api/reports/export?${q}`);
  };

  const r = report.data?.data;
  return (
    <PageContainer wide>
      <PageHeader
        title="Reports"
        description={r ? `${formatDate(`${r.query.from}T00:00:00`).split(",")[0]} – ${formatDate(`${r.query.to}T00:00:00`).split(",")[0]} · times in ${r.timezone}` : "Channel results, team performance and inbox response times."}
        actions={
          canExport && tab !== "schedules" && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => download("pdf")}><FileText className="h-4 w-4" /> PDF</Button>
              <Button variant="outline" onClick={() => download("csv", tab as ReportSection)}><Download className="h-4 w-4" /> CSV</Button>
            </div>
          )
        }
      />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[...REPORT_SECTIONS.map((s) => ({ value: s as Tab, label: SECTION_LABELS[s] })), ...(canExport ? [{ value: "schedules" as Tab, label: "Scheduled" }] : [])]} />
        {tab !== "schedules" && (
          <>
            <Select aria-label="Period" className="w-40" value={preset} onChange={(e) => { setPreset(e.target.value); const p = P.find((x) => x.key === e.target.value); if (p) setRange({ from: p.from, to: p.to }); }}>
              {P.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              <option value="custom">Custom…</option>
            </Select>
            {preset === "custom" && (
              <>
                <Input type="date" aria-label="From" className="w-40" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} />
                <Input type="date" aria-label="To" className="w-40" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} />
              </>
            )}
            {channels.length > 1 && (
              <Select aria-label="Channel" className="w-56" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                <option value="">All numbers</option>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
          </>
        )}
      </div>

      {tab === "schedules" ? (
        <Schedules />
      ) : report.isLoading ? (
        <div className="p-10 text-center"><Spinner /></div>
      ) : report.error ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : r ? (
        tab === "overview" ? <Overview r={r} /> : tab === "team" ? <Team r={r} /> : <Responses r={r} />
      ) : null}
    </PageContainer>
  );
}

function Overview({ r }: { r: FullReport }) {
  const o = r.overview!;
  const w = o.whatsapp;
  const wa = CHANNELS[0];
  const em = CHANNELS[1];
  const sm = CHANNELS[2];
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Messages sent per day" />
        <div className="p-5">
          <BarChart
            data={o.daily as unknown as Record<string, number | string>[]}
            labelKey="day"
            formatLabel={fmtDay}
            caption="Messages sent per day by channel"
            series={[
              { key: "whatsappSent", label: "WhatsApp", color: wa.color },
              { key: "emailSent", label: "Email", color: em.color },
              { key: "smsSent", label: "SMS", color: sm.color },
            ]}
          />
        </div>
      </Card>
      <section>
        <h2 className="mb-3 text-sm font-semibold">WhatsApp</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Campaign messages" value={formatNumber(w.campaignSent)} hint={`${rate(w.campaignDelivered, w.campaignSent)} delivered · ${w.campaignFailed} failed`} />
          <StatCard label="Read rate" value={rate(w.campaignRead, w.campaignSent)} hint={`${formatNumber(w.campaignRead)} read`} />
          <StatCard label="Reply rate" value={rate(w.campaignReplied, w.campaignSent)} hint={`${formatNumber(w.campaignReplied)} replied`} />
          <StatCard label="Inbox" value={`${formatNumber(w.received)} in · ${formatNumber(w.conversationsSent)} out`} hint={`${w.failed} failed`} />
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold">Email</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Sent" value={formatNumber(o.email.sent)} hint={`${o.email.failed} failed · ${o.email.bounced} bounced`} />
          <StatCard label="Open rate" value={rate(o.email.opened, o.email.sent)} hint={`${formatNumber(o.email.opened)} opened`} />
          <StatCard label="Click rate" value={rate(o.email.clicked, o.email.sent)} hint={`${formatNumber(o.email.clicked)} clicked`} />
          <StatCard label="Unsubscribes" value={formatNumber(o.email.unsubscribed)} hint={rate(o.email.unsubscribed, o.email.sent)} />
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold">SMS</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Sent" value={formatNumber(o.sms.sent)} hint={`${o.sms.failed} failed`} />
          <StatCard label="Delivered" value={rate(o.sms.delivered, o.sms.sent)} hint={`${formatNumber(o.sms.delivered)} confirmed`} />
          <StatCard label="Link clicks" value={formatNumber(o.sms.clicked)} hint={rate(o.sms.clicked, o.sms.sent)} />
          <StatCard label="Recipients" value={formatNumber(o.sms.recipients)} />
        </div>
      </section>
    </div>
  );
}

function Team({ r }: { r: FullReport }) {
  const rows = r.team ?? [];
  if (!rows.length) return <Card><EmptyState title="No team activity" description="Replies sent from the inbox are counted for whoever sent them." /></Card>;
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <Th>Agent</Th>
            <Th className="text-right">Messages</Th>
            <Th className="text-right">Conversations</Th>
            <Th className="text-right">Resolved</Th>
            <Th className="text-right">Open now</Th>
            <Th className="text-right">Median reply</Th>
            <Th className="text-right">90% within</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <Tr key={t.userId}>
              <Td>
                <span className="font-medium">{t.name}</span> {t.role === "owner" && <Badge className="ml-1">owner</Badge>}
              </Td>
              <Td className="text-right tabular-nums">{formatNumber(t.messagesSent)}</Td>
              <Td className="text-right tabular-nums">{formatNumber(t.conversations)}</Td>
              <Td className="text-right tabular-nums">{formatNumber(t.resolved)}</Td>
              <Td className="text-right tabular-nums">{formatNumber(t.openAssigned)}</Td>
              <Td className="text-right tabular-nums">{formatDuration(t.median)}</Td>
              <Td className="text-right tabular-nums">{formatDuration(t.p90)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <p className="border-t border-border px-5 py-3 text-xs text-fg-muted">Reply times count from the customer's first unanswered message to the agent's reply. “Open now” and “Resolved” use each conversation's current assignee.</p>
    </Card>
  );
}

function Responses({ r }: { r: FullReport }) {
  const t = r.responseTimes!;
  // Quick teams reply in seconds: chart in the unit that keeps the bars readable.
  const peak = Math.max(0, ...t.daily.map((d) => d.median ?? 0));
  const unit = peak < 120 ? { label: "seconds", div: 1 } : peak < 7200 ? { label: "minutes", div: 60 } : { label: "hours", div: 3600 };
  const daily = t.daily.map((d) => ({ day: d.day, value: d.median == null ? 0 : Math.round((d.median / unit.div) * 10) / 10 }));
  const plural = (n: number, one: string, many: string) => `${formatNumber(n)} ${n === 1 ? one : many}`;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="First response (median)" value={formatDuration(t.first.median)} hint={`${plural(t.first.count, "conversation", "conversations")} · 90% within ${formatDuration(t.first.p90)}`} />
        <StatCard label="Any reply (median)" value={formatDuration(t.all.median)} hint={`${plural(t.all.count, "reply", "replies")} · average ${formatDuration(t.all.avg)}`} />
        <StatCard label="Answered within 15 min" value={rate(t.buckets[0].count + t.buckets[1].count, t.all.count)} />
        <StatCard label="Waiting for a reply" value={formatNumber(t.awaiting)} hint="Customer messages from this period with no reply yet" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="How fast customers hear back" />
          <div className="p-5"><RankedBars items={t.buckets.map((b) => ({ name: b.label, count: b.count }))} total={t.all.count} emptyText="No replies in this period." /></div>
        </Card>
        <Card>
          <CardHeader title={`Median reply time per day (${unit.label})`} description="Days without replies show no bar." />
          <div className="p-5">
            <BarChart data={daily} labelKey="day" formatLabel={fmtDay} caption={`Median reply time per day in ${unit.label}`} series={[{ key: "value", label: `Median ${unit.label}`, color: CHANNELS[0].color }]} />
          </div>
        </Card>
      </div>
      {t.truncated && <p className="text-xs text-warning">A very busy period: only the first 200,000 messages were analysed. Pick a shorter range for exact numbers.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scheduled reports
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const blankSchedule = (email: string): ReportScheduleInput => ({ name: "Weekly report", sections: [...REPORT_SECTIONS], frequency: "weekly", dayOfWeek: 1, hour: 8, format: "pdf", recipients: email ? [email] : [], channelId: null, enabled: true });

function Schedules() {
  const { user } = useAuth();
  const { channels } = useChannel();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery<{ data: ReportSchedule[] }>({ queryKey: ["/api/reports/schedules"] });
  const [editing, setEditing] = useState<ReportSchedule | "new" | null>(null);
  const [v, setV] = useState<ReportScheduleInput>(blankSchedule(user?.email ?? ""));
  const [emails, setEmails] = useState("");
  const open = (s: ReportSchedule | "new") => {
    setEditing(s);
    const val = s === "new" ? blankSchedule(user?.email ?? "") : { name: s.name, sections: s.sections as ReportSection[], frequency: s.frequency as ReportScheduleInput["frequency"], dayOfWeek: s.dayOfWeek, hour: s.hour, format: s.format as ReportScheduleInput["format"], recipients: s.recipients, channelId: s.channelId, enabled: s.enabled };
    setV(val);
    setEmails(val.recipients.join(", "));
  };
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["/api/reports/schedules"] });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...v, recipients: emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean) };
      return editing && editing !== "new" ? apiRequest("PUT", `/api/reports/schedules/${editing.id}`, body) : apiRequest("POST", "/api/reports/schedules", body);
    },
    onSuccess: () => {
      toast({ title: "Scheduled report saved", variant: "success" });
      invalidate();
      setEditing(null);
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  const sendNow = useMutation({
    mutationFn: (id: string) => apiRequest<{ data: { status: string }; success: boolean }>("POST", `/api/reports/schedules/${id}/send`),
    onSuccess: (r) => {
      toast({ title: r.success ? "Report sent" : "Report not sent", description: r.data.status, variant: r.success ? "success" : "error" });
      invalidate();
    },
  });
  const toggle = useMutation({ mutationFn: (s: ReportSchedule) => apiRequest("PUT", `/api/reports/schedules/${s.id}`, { name: s.name, sections: s.sections, frequency: s.frequency, dayOfWeek: s.dayOfWeek, hour: s.hour, format: s.format, recipients: s.recipients, channelId: s.channelId, enabled: !s.enabled }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => apiRequest("DELETE", `/api/reports/schedules/${id}`), onSuccess: invalidate });

  if (isLoading) return <div className="p-10 text-center"><Spinner /></div>;
  const list = data?.data ?? [];
  const when = (s: { frequency: string; dayOfWeek: number; hour: number }) => `${s.frequency === "daily" ? "Every day" : s.frequency === "weekly" ? `Every ${WEEKDAYS[s.dayOfWeek]}` : "On the 1st of each month"} at ${String(s.hour).padStart(2, "0")}:00`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between gap-3">
        <p className="text-sm text-fg-muted">Reports are emailed for the last full day, week or month, in your time zone (Sending preferences).</p>
        <Button onClick={() => open("new")}><Plus className="h-4 w-4" /> New scheduled report</Button>
      </div>
      {list.length === 0 ? (
        <Card><EmptyState icon={<CalendarClock className="h-10 w-10" />} title="No scheduled reports" description="Send a PDF or CSV summary to yourself or your team every day, week or month." /></Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {list.map((s) => (
              <li key={s.id} className="flex flex-col gap-3 p-5 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.name} {!s.enabled && <Badge tone="warning" className="ml-1">Paused</Badge>}</p>
                  <p className="text-sm text-fg-muted">{when(s)} · {s.format === "both" ? "PDF + CSV" : s.format.toUpperCase()} · {(s.sections as ReportSection[]).map((x) => SECTION_LABELS[x]).join(", ")}</p>
                  <p className="truncate text-xs text-fg-muted">To {s.recipients.join(", ")}</p>
                  <p className="text-xs text-fg-muted">
                    {s.enabled && s.nextRunAt ? `Next: ${formatDate(s.nextRunAt)}` : ""}
                    {s.lastRunAt ? ` · Last: ${formatDate(s.lastRunAt)} (${s.lastStatus})` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" loading={sendNow.isPending && sendNow.variables === s.id} onClick={() => sendNow.mutate(s.id)}><Send className="h-3.5 w-3.5" /> Send now</Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle.mutate(s)}>{s.enabled ? "Pause" : "Resume"}</Button>
                  <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => open(s)}><Pencil className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label="Delete" onClick={async () => { if (await confirm({ title: `Delete “${s.name}”?`, confirmText: "Delete", destructive: true })) remove.mutate(s.id); }}><Trash2 className="h-4 w-4 text-danger" /></Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} size="lg" title={editing === "new" ? "New scheduled report" : "Edit scheduled report"} footer={<Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.name.trim() || !v.sections.length || !emails.trim()}>Save</Button>}>
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="rs-name"><Input id="rs-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={100} /></Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Include</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {REPORT_SECTIONS.map((s) => <Checkbox key={s} label={SECTION_LABELS[s]} checked={v.sections.includes(s)} onChange={(on) => setV({ ...v, sections: on ? [...v.sections, s] : v.sections.filter((x) => x !== s) })} />)}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="How often" htmlFor="rs-freq">
              <Select id="rs-freq" value={v.frequency} onChange={(e) => setV({ ...v, frequency: e.target.value as ReportScheduleInput["frequency"] })}>
                {FREQUENCIES.map((f) => <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>)}
              </Select>
            </Field>
            {v.frequency === "weekly" && (
              <Field label="Day" htmlFor="rs-dow">
                <Select id="rs-dow" value={String(v.dayOfWeek)} onChange={(e) => setV({ ...v, dayOfWeek: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Time" htmlFor="rs-hour">
              <Select id="rs-hour" value={String(v.hour)} onChange={(e) => setV({ ...v, hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Format" htmlFor="rs-format">
              <Select id="rs-format" value={v.format} onChange={(e) => setV({ ...v, format: e.target.value as ReportScheduleInput["format"] })}>
                <option value="pdf">PDF</option>
                <option value="csv">CSV (one file per section)</option>
                <option value="both">PDF and CSV</option>
              </Select>
            </Field>
            {channels.length > 1 && (
              <Field label="Number" htmlFor="rs-channel">
                <Select id="rs-channel" value={v.channelId ?? ""} onChange={(e) => setV({ ...v, channelId: e.target.value || null })}>
                  <option value="">All numbers</option>
                  {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            )}
          </div>
          <Field label="Send to" htmlFor="rs-to" hint="Up to 10 email addresses, separated by commas.">
            <Input id="rs-to" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="you@company.com, manager@company.com" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
