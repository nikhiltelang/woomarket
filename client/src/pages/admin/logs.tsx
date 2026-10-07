import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Copy, Pause, Play, ScrollText, Search, Settings2, Trash2 } from "lucide-react";
import type { Paginated } from "@shared/api-types";
import type { RequestLog, RequestLogSettings } from "@shared/schema";
import { usePlatform } from "@/contexts/platform";
import { apiRequest, fieldErrors, queryClient } from "@/lib/api";
import { cn, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner, StatCard } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, Tabs, useConfirm, useToast } from "@/components/ui/overlay";

const KEY = "/api/superadmin/request-logs";
type Summary = Omit<RequestLog, "query" | "userAgent" | "requestHeaders" | "requestBody" | "responseHeaders" | "responseBody">;
type Settings = Required<RequestLogSettings>;
interface Stats {
  total: number;
  clientErrors: number;
  serverErrors: number;
  avgMs: number;
  maxMs: number;
  pending: number;
}
interface Filters {
  search: string;
  method: string;
  status: string;
  user: string;
  from: string;
  to: string;
  minDurationMs: string;
}
const NO_FILTERS: Filters = { search: "", method: "", status: "", user: "", from: "", to: "", minDurationMs: "" };

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const dayFmt = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", year: "numeric" });
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** Local date and time with milliseconds, e.g. "07 Oct 2026, 08:15:26.413". */
export function preciseTime(v: string | Date | null | undefined) {
  if (!v) return "—";
  const d = new Date(v);
  return `${dayFmt.format(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const duration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 2 : 0)} ms`);
const bytes = (n: number | null | undefined) => (n == null ? "—" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const pretty = (text: string | null | undefined) => {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};
const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);

const METHOD_TONE: Record<string, "info" | "success" | "warning" | "danger" | "primary" | "neutral"> = {
  GET: "info",
  POST: "success",
  PUT: "warning",
  PATCH: "warning",
  DELETE: "danger",
};
const MethodBadge = ({ method }: { method: string }) => <Badge tone={METHOD_TONE[method] ?? "neutral"} className="w-16 justify-center font-mono">{method}</Badge>;

function StatusCode({ code, aborted }: { code: number; aborted?: boolean }) {
  const tone = code >= 500 ? "danger" : code >= 400 ? "warning" : code >= 300 ? "info" : "success";
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={tone} className="font-mono tabular-nums">{code}</Badge>
      {aborted && <span title="The client disconnected before the response finished"><Badge>aborted</Badge></span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />} {done ? "Copied" : "Copy"}
    </Button>
  );
}

function CodeBlock({ title, text, empty }: { title: string; text: string; empty: string }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {text && <CopyButton text={text} />}
      </div>
      {text ? (
        <pre className="max-h-[50vh] overflow-auto rounded-md border border-border bg-subtle p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">{text}</pre>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-fg-muted">{empty}</p>
      )}
    </section>
  );
}

function HeaderTable({ headers }: { headers: Record<string, string> | null | undefined }) {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return <p className="text-sm text-fg-muted">No headers recorded.</p>;
  return (
    <section>
      <h3 className="mb-1.5 text-sm font-medium">Headers</h3>
      <dl className="divide-y divide-border rounded-md border border-border font-mono text-xs">
        {entries.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-3 px-3 py-1.5">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </div>
  );
}

function LogDetail({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [tab, setTab] = useState<"overview" | "request" | "response">("overview");
  const { data, isLoading, error } = useQuery<{ data: RequestLog }>({ queryKey: [`${KEY}/${id}`], enabled: id !== null });
  useEffect(() => setTab("overview"), [id]);
  const log = data?.data;
  const queryString = log?.query ? new URLSearchParams(Object.entries(log.query).map(([k, v]) => [k, String(v)])).toString() : "";

  return (
    <Dialog
      open={id !== null}
      onClose={onClose}
      size="xl"
      title={log ? <span className="flex flex-wrap items-center gap-2"><MethodBadge method={log.method} /><span className="font-mono text-sm break-all">{log.path}</span><StatusCode code={log.statusCode} aborted={log.aborted} /></span> : "Log entry"}
      description={log ? `${preciseTime(log.requestedAt)} · ${duration(log.durationMs)}` : undefined}
    >
      {error ? (
        <ErrorState error={error} />
      ) : isLoading || !log ? (
        <div className="p-10 text-center"><Spinner /></div>
      ) : (
        <div className="space-y-4">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "overview", label: "Overview" },
              { value: "request", label: "Request" },
              { value: "response", label: "Response" },
            ]}
          />
          {tab === "overview" && (
            <dl className="divide-y divide-border text-sm">
              <Row label="Request ID"><span className="font-mono">{log.requestId}</span></Row>
              <Row label="URL"><span className="font-mono">{log.path}{queryString && `?${queryString}`}</span></Row>
              <Row label="Status"><StatusCode code={log.statusCode} aborted={log.aborted} /></Row>
              <Row label="Request time"><span className="tabular-nums">{preciseTime(log.requestedAt)}</span></Row>
              <Row label="Response time"><span className="tabular-nums">{preciseTime(log.respondedAt)}</span></Row>
              <Row label="Duration"><span className="tabular-nums">{duration(log.durationMs)}</span></Row>
              <Row label="User">{log.username ? `${log.username} (${log.role})` : log.userId ? <span className="font-mono">{log.userId}</span> : <span className="text-fg-muted">Not signed in</span>}</Row>
              <Row label="IP address"><span className="font-mono">{log.ip ?? "—"}</span></Row>
              <Row label="User agent">{log.userAgent ?? "—"}</Row>
              <Row label="Request size">{bytes(log.requestSize)}</Row>
              <Row label="Response size">{bytes(log.responseSize)}</Row>
            </dl>
          )}
          {tab === "request" && (
            <div className="space-y-4">
              {log.query && <CodeBlock title="Query parameters" text={pretty(JSON.stringify(log.query))} empty="" />}
              <HeaderTable headers={log.requestHeaders} />
              <CodeBlock title="Payload" text={pretty(log.requestBody)} empty={log.method === "GET" ? "GET requests have no payload." : "No payload, or body capture was off."} />
            </div>
          )}
          {tab === "response" && (
            <div className="space-y-4">
              <HeaderTable headers={log.responseHeaders} />
              <CodeBlock title="Body" text={pretty(log.responseBody)} empty="Empty response, or body capture was off." />
            </div>
          )}
          <p className="text-xs text-fg-muted">Passwords, tokens, cookies, API keys and verification codes are replaced with [REDACTED] before logs are stored.</p>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsDialog({ open, settings, onClose }: { open: boolean; settings: Settings | undefined; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ enabled: true, captureBodies: true, retentionDays: "14", excludePaths: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open && settings) {
      setErrors({});
      setV({ enabled: settings.enabled, captureBodies: settings.captureBodies, retentionDays: String(settings.retentionDays), excludePaths: settings.excludePaths.join("\n") });
    }
  }, [open, settings]);
  const save = useMutation({
    mutationFn: () =>
      apiRequest("PUT", "/api/system-config/request-logs", {
        enabled: v.enabled,
        captureBodies: v.captureBodies,
        retentionDays: v.retentionDays,
        excludePaths: v.excludePaths.split("\n").map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      toast({ title: "Log settings saved", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [`${KEY}/stats`] });
      onClose();
    },
    onError: (err) => {
      const fe = fieldErrors(err);
      const pathErr = Object.entries(fe).find(([k]) => k.startsWith("excludePaths"))?.[1];
      setErrors({ ...fe, excludePaths: pathErr ?? fe.excludePaths });
      if (!Object.keys(fe).length) toast({ title: "Could not save", description: (err as Error).message, variant: "error" });
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Log settings" description="Applies within a few seconds to every server instance." footer={<Button onClick={() => save.mutate()} loading={save.isPending}>Save settings</Button>}>
      <div className="space-y-4">
        <Switch checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} label="Record requests" description="Store every API and webhook request with its response." />
        <Switch checked={v.captureBodies} onChange={(captureBodies) => setV({ ...v, captureBodies })} label="Store payloads and response bodies" description="Up to 64 KB each, with secrets redacted. Off keeps only method, URL, headers, status and timing." />
        <Field label="Keep logs for (days)" htmlFor="rl-days" error={errors.retentionDays} hint="Older entries are deleted every hour.">
          <Input id="rl-days" type="number" min={1} max={365} className="w-32" value={v.retentionDays} onChange={(e) => setV({ ...v, retentionDays: e.target.value })} invalid={Boolean(errors.retentionDays)} />
        </Field>
        <Field label="Don't log these paths" htmlFor="rl-exclude" error={errors.excludePaths} hint="One path prefix per line, e.g. /api/notifications/unread-count">
          <Textarea id="rl-exclude" rows={4} className="w-full font-mono text-xs" value={v.excludePaths} onChange={(e) => setV({ ...v, excludePaths: e.target.value })} invalid={Boolean(errors.excludePaths)} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function LogsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { config } = usePlatform();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [live, setLive] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const limit = config?.recordsPerPage ?? 25;

  const params = {
    search: filters.search,
    method: filters.method,
    status: filters.status,
    user: filters.user,
    from: toIso(filters.from),
    to: toIso(filters.to),
    minDurationMs: filters.minDurationMs,
  };
  const refetchInterval = live ? 5000 : false;
  const { data, isLoading, error, refetch, isFetching } = useQuery<Paginated<Summary>>({ queryKey: [KEY, { ...params, page, limit }], refetchInterval });
  const stats = useQuery<{ data: Stats; settings: Settings }>({ queryKey: [`${KEY}/stats`, params], refetchInterval });
  const settings = stats.data?.settings;

  const apply = (next: Filters) => {
    setFilters(next);
    setPage(1);
  };
  // Selects apply immediately; text and dates apply on Search.
  const pick = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = { ...draft, [k]: e.target.value };
    setDraft(next);
    apply(next);
  };

  const clear = useMutation({
    mutationFn: (olderThanDays: number) => apiRequest<{ data: { removed: number | "all" } }>("POST", `${KEY}/clear`, { olderThanDays }),
    onSuccess: (r) => {
      toast({ title: "Logs cleared", description: r.data.removed === "all" ? "All entries were deleted." : `${formatNumber(r.data.removed)} entries deleted.`, variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [KEY] });
      void queryClient.invalidateQueries({ queryKey: [`${KEY}/stats`] });
    },
    onError: (err) => toast({ title: "Could not clear logs", description: (err as Error).message, variant: "error" }),
  });
  const s = stats.data?.data;
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  return (
    <PageContainer wide>
      <PageHeader
        title="Logs"
        description="Every API and webhook request with its response, newest first."
        actions={
          <>
            <Button variant="outline" onClick={() => setLive((x) => !x)} aria-pressed={live}>
              {live ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} {live ? "Pause live" : "Live (5s)"}
            </Button>
            <Button variant="outline" onClick={() => setSettingsOpen(true)}><Settings2 className="h-4 w-4" /> Settings</Button>
            <Button
              variant="outline"
              className="text-danger"
              onClick={async () => {
                const days = settings?.retentionDays ?? 14;
                if (await confirm({ title: "Clear all logs?", description: `Every stored request is deleted. Entries older than ${days} days are already removed automatically.`, confirmText: "Clear all", destructive: true })) clear.mutate(0);
              }}
            >
              <Trash2 className="h-4 w-4" /> Clear
            </Button>
          </>
        }
      />

      {settings && !settings.enabled && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
          Request logging is off — new requests aren't recorded. Turn it on under Settings.
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={filtered ? "Matching requests" : "Requests"} value={formatNumber(s?.total)} hint={settings ? `Kept for ${settings.retentionDays} days` : undefined} />
        <StatCard label="Client errors (4xx)" value={formatNumber(s?.clientErrors)} hint={s?.total ? `${((s.clientErrors / s.total) * 100).toFixed(1)}% of requests` : undefined} />
        <StatCard label="Server errors (5xx)" value={<span className={cn(s?.serverErrors ? "text-danger" : undefined)}>{formatNumber(s?.serverErrors)}</span>} hint={s?.total ? `${((s.serverErrors / s.total) * 100).toFixed(1)}% of requests` : undefined} />
        <StatCard label="Avg response time" value={s ? duration(s.avgMs) : "—"} hint={s ? `Slowest ${duration(s.maxMs)}` : undefined} />
      </div>

      <Card className="mb-4 p-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft);
          }}
        >
          <Input className="w-full sm:col-span-2" placeholder="Path, request ID or IP" value={draft.search} onChange={(e) => setDraft({ ...draft, search: e.target.value })} aria-label="Search path, request ID or IP" />
          <Select value={draft.method} onChange={pick("method")} aria-label="Method">
            <option value="">All methods</option>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
          </Select>
          <Select value={draft.status} onChange={pick("status")} aria-label="Status">
            <option value="">All statuses</option>
            <option value="2xx">2xx success</option>
            <option value="3xx">3xx redirect</option>
            <option value="4xx">4xx client error</option>
            <option value="5xx">5xx server error</option>
          </Select>
          <Input placeholder="Username" value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} aria-label="Username" />
          <Select value={draft.minDurationMs} onChange={pick("minDurationMs")} aria-label="Duration">
            <option value="">Any duration</option>
            <option value="500">Slower than 500 ms</option>
            <option value="1000">Slower than 1 s</option>
            <option value="5000">Slower than 5 s</option>
          </Select>
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            From
            <Input type="datetime-local" className="flex-1" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} aria-label="From" />
          </label>
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            To
            <Input type="datetime-local" className="flex-1" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} aria-label="To" />
          </label>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit"><Search className="h-4 w-4" /> Search</Button>
            {filtered && <Button variant="ghost" onClick={() => { setDraft(NO_FILTERS); apply(NO_FILTERS); }}>Reset filters</Button>}
            {isFetching && <Spinner className="ml-auto h-4 w-4" />}
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="p-10 text-center"><Spinner /></div>
        ) : !data?.data.length ? (
          <EmptyState icon={<ScrollText className="h-10 w-10" />} title={filtered ? "No matching requests" : "No requests logged yet"} description={filtered ? "Try wider filters." : "Requests appear here a couple of seconds after they're made."} />
        ) : (
          <>
            <Table>
              <thead>
                <tr className="[&>th]:bg-primary [&>th]:text-primary-fg">
                  <Th>Request time</Th>
                  <Th>Method</Th>
                  <Th>Path</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Duration</Th>
                  <Th className="hidden lg:table-cell">User</Th>
                  <Th className="hidden xl:table-cell">IP</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((r) => (
                  <Tr key={r.id} onClick={() => setViewing(r.id)}>
                    <Td className="whitespace-nowrap text-xs tabular-nums">{preciseTime(r.requestedAt)}</Td>
                    <Td><MethodBadge method={r.method} /></Td>
                    <Td className="max-w-[28rem]">
                      <button className="block max-w-full truncate text-left font-mono text-xs hover:underline" onClick={(e) => { e.stopPropagation(); setViewing(r.id); }} title={r.path}>
                        {r.path}
                      </button>
                    </Td>
                    <Td><StatusCode code={r.statusCode} aborted={r.aborted} /></Td>
                    <Td className={cn("text-right whitespace-nowrap tabular-nums", r.durationMs >= 1000 && "font-medium text-warning")}>{duration(r.durationMs)}</Td>
                    <Td className="hidden lg:table-cell">{r.username ?? <span className="text-fg-muted">—</span>}</Td>
                    <Td className="hidden font-mono text-xs xl:table-cell">{r.ip}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} limit={limit} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <LogDetail id={viewing} onClose={() => setViewing(null)} />
      <SettingsDialog open={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} />
    </PageContainer>
  );
}
