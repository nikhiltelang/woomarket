import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, History, KeyRound, Pencil, Plus, Send, Trash2, Webhook, XCircle } from "lucide-react";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_NAMES, WEBHOOK_HEADERS, WEBHOOK_MAX_ATTEMPTS, type WebhookEvent } from "@shared/webhooks";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Switch } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, PageLoader, Spinner } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, Tabs, useConfirm, useToast } from "@/components/ui/overlay";
import { Code, CopyText } from "./api-keys";

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  source: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  disabledReason: string | null;
  createdAt: string;
  stats: { succeeded: number; failed: number; pending: number };
}
interface Delivery {
  id: number;
  eventId: string;
  event: string;
  payload: Record<string, unknown>;
  status: "pending" | "sending" | "succeeded" | "failed";
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}
interface SendResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  durationMs: number;
}

const KEY = "/api/webhooks";
const SOURCE_LABEL: Record<string, string> = { zapier: "Zapier", make: "Make", api: "API" };
const GROUPS = [...new Set(WEBHOOK_EVENT_NAMES.map((e) => WEBHOOK_EVENTS[e].group))];

function EventPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const all = value.includes("*");
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">Events</legend>
      <Checkbox label="All events, including ones added later" checked={all} onChange={(on) => onChange(on ? ["*"] : [])} />
      {!all && (
        <div className="grid gap-4 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g}>
              <p className="mb-1.5 text-xs font-medium tracking-wide text-fg-muted uppercase">{g}</p>
              <div className="flex flex-col gap-1.5">
                {WEBHOOK_EVENT_NAMES.filter((e) => WEBHOOK_EVENTS[e].group === g).map((e) => (
                  <Checkbox
                    key={e}
                    label={<span title={WEBHOOK_EVENTS[e].description}>{WEBHOOK_EVENTS[e].label} <code className="text-[11px] text-fg-muted">{e}</code></span>}
                    checked={value.includes(e)}
                    onChange={(on) => onChange(on ? [...value, e] : value.filter((x) => x !== e))}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function EndpointDialog({ editing, open, onClose, onCreated }: { editing: Endpoint | null; open: boolean; onClose: () => void; onCreated: (secret: string) => void }) {
  const toast = useToast();
  const [v, setV] = useState({ url: "", description: "", events: ["message.received", "contact.created"] as string[] });
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setV(editing ? { url: editing.url, description: editing.description ?? "", events: editing.events } : { url: "", description: "", events: ["message.received", "contact.created"] });
  }
  const save = useMutation({
    mutationFn: () => {
      const body = { url: v.url.trim(), description: v.description.trim() || null, events: v.events };
      return editing ? apiRequest<{ data: Endpoint; secret?: string }>("PUT", `${KEY}/${editing.id}`, body) : apiRequest<{ data: Endpoint; secret?: string }>("POST", KEY, body);
    },
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: [KEY] });
      onClose();
      if (r.secret) onCreated(r.secret);
      else toast({ title: "Webhook saved", variant: "success" });
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? "Edit webhook" : "Add webhook"}
      footer={<Button onClick={() => save.mutate()} loading={save.isPending} disabled={!/^https?:\/\/\S+$/.test(v.url.trim()) || !v.events.length}>{editing ? "Save" : "Add webhook"}</Button>}
    >
      <div className="flex flex-col gap-5">
        <Field label="Endpoint URL" htmlFor="wh-url" hint="We POST JSON here. It must be a public https:// address.">
          <Input id="wh-url" value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} placeholder="https://hooks.zapier.com/hooks/catch/…" />
        </Field>
        <Field label="Description (optional)" htmlFor="wh-desc">
          <Input id="wh-desc" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={200} placeholder="CRM sync" />
        </Field>
        <EventPicker value={v.events} onChange={(events) => setV({ ...v, events })} />
      </div>
    </Dialog>
  );
}

function SecretDialog({ endpoint, fresh, onClose }: { endpoint: Endpoint | null; fresh: string | null; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [secret, setSecret] = useState<string | null>(null);
  const shown = fresh ?? secret;
  const reveal = useMutation({ mutationFn: () => apiRequest<{ secret: string }>("GET", `${KEY}/${endpoint!.id}/secret`), onSuccess: (r) => setSecret(r.secret) });
  const rotate = useMutation({
    mutationFn: () => apiRequest<{ secret: string }>("POST", `${KEY}/${endpoint!.id}/rotate-secret`),
    onSuccess: (r) => {
      setSecret(r.secret);
      toast({ title: "New secret created", description: "Update it in the receiving app now; the old one no longer verifies.", variant: "success" });
    },
  });
  return (
    <Dialog open={Boolean(endpoint || fresh)} onClose={() => { setSecret(null); onClose(); }} title="Signing secret" description="Use it to check that requests really come from us (see “Verify signatures” below).">
      <div className="flex flex-col gap-4">
        {fresh && <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">Webhook added. Copy the secret into the app that receives it.</p>}
        {shown ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-subtle p-3">
            <code className="min-w-0 flex-1 font-mono text-sm break-all">{shown}</code>
            <CopyText text={shown} label="secret" />
          </div>
        ) : (
          <Button variant="outline" className="self-start" loading={reveal.isPending} onClick={() => reveal.mutate()}><KeyRound className="h-4 w-4" /> Reveal secret</Button>
        )}
        {endpoint && (
          <Button
            variant="ghost"
            className="self-start text-danger"
            loading={rotate.isPending}
            onClick={async () => {
              if (await confirm({ title: "Create a new secret?", description: "The current secret stops verifying immediately.", confirmText: "Create new secret", destructive: true })) rotate.mutate();
            }}
          >
            Roll secret
          </Button>
        )}
      </div>
    </Dialog>
  );
}

function TestDialog({ endpoint, onClose }: { endpoint: Endpoint | null; onClose: () => void }) {
  const firstEvent = (endpoint?.events.find((e) => e !== "*") ?? "message.received") as WebhookEvent;
  const [event, setEvent] = useState<WebhookEvent>(firstEvent);
  const [result, setResult] = useState<SendResult | null>(null);
  const send = useMutation({
    mutationFn: () => apiRequest<{ data: SendResult }>("POST", `${KEY}/${endpoint!.id}/test`, { event }),
    onSuccess: (r) => {
      setResult(r.data);
      void queryClient.invalidateQueries({ queryKey: [`${KEY}/${endpoint!.id}/deliveries`] });
    },
    onError: (err) => setResult({ ok: false, status: null, body: null, error: (err as Error).message, durationMs: 0 }),
  });
  return (
    <Dialog open={Boolean(endpoint)} onClose={() => { setResult(null); onClose(); }} title="Send a test event" description={endpoint?.url}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Event" htmlFor="wh-test-ev" className="min-w-0 flex-1">
            <Select id="wh-test-ev" value={event} onChange={(e) => setEvent(e.target.value as WebhookEvent)}>
              {WEBHOOK_EVENT_NAMES.map((e) => <option key={e} value={e}>{WEBHOOK_EVENTS[e].label} ({e})</option>)}
            </Select>
          </Field>
          <Button onClick={() => send.mutate()} loading={send.isPending}><Send className="h-4 w-4" /> Send test</Button>
        </div>
        <p className="text-xs text-fg-muted">Sends sample data with <code>"test": true</code>. Tests aren't retried.</p>
        {result && (
          <div className={cn("rounded-md border p-3 text-sm", result.ok ? "border-success/40 bg-success-soft/40" : "border-danger/40 bg-danger-soft/40")}>
            <p className="flex items-center gap-2 font-medium">
              {result.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-danger" />}
              {result.ok ? "Delivered" : "Failed"}
              {result.status !== null && <Badge>{result.status}</Badge>}
              {result.durationMs > 0 && <span className="text-xs font-normal text-fg-muted">{result.durationMs} ms</span>}
            </p>
            {result.error && <p className="mt-1 text-danger">{result.error}</p>}
            {result.body && <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface p-2 font-mono text-xs whitespace-pre-wrap">{result.body}</pre>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const DELIVERY_TONE = { succeeded: "success", failed: "danger", pending: "warning", sending: "info" } as const;

function DeliveriesDialog({ endpoint, onClose }: { endpoint: Endpoint | null; onClose: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const key = `${KEY}/${endpoint?.id}/deliveries`;
  const { data, isLoading } = useQuery<{ data: Delivery[] }>({ queryKey: [key, status ? { status } : {}], enabled: Boolean(endpoint), refetchInterval: 5000 });
  const retry = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `${KEY}/deliveries/${id}/retry`),
    onSuccess: () => {
      toast({ title: "Queued for delivery", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [key] });
    },
    onError: (err) => toast({ title: "Could not retry", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog open={Boolean(endpoint)} onClose={() => { setOpen(null); onClose(); }} size="xl" title="Recent deliveries" description={endpoint?.url}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Tabs value={status} onChange={setStatus} tabs={[{ value: "", label: "All" }, { value: "succeeded", label: "Succeeded" }, { value: "failed", label: "Failed" }, { value: "pending", label: "Retrying" }]} />
        <span className="text-xs text-fg-muted">Kept for 30 days</span>
      </div>
      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <p className="py-8 text-center text-sm text-fg-muted">No deliveries yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Event</Th>
              <Th>Status</Th>
              <Th>Response</Th>
              <Th>When</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.data.map((d) => (
              <Tr key={d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>
                <Td>
                  <code className="text-xs">{d.event}</code>
                  {(d.payload as { test?: boolean }).test && <Badge className="ml-1.5">test</Badge>}
                  {open === d.id && (
                    <div className="mt-2 space-y-2" onClick={(e) => e.stopPropagation()}>
                      <p className="text-xs text-fg-muted">Delivery ID <code>{d.eventId}</code></p>
                      <pre className="max-h-56 overflow-auto rounded bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(d.payload, null, 2)}</pre>
                      {(d.responseBody || d.error) && <pre className="max-h-32 overflow-auto rounded bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap">{d.error ?? d.responseBody}</pre>}
                    </div>
                  )}
                </Td>
                <Td>
                  <Badge tone={DELIVERY_TONE[d.status]}>{d.status === "pending" && d.attempts > 0 ? "retrying" : d.status}</Badge>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {d.attempts} of {WEBHOOK_MAX_ATTEMPTS} tries{d.status === "pending" && d.nextAttemptAt ? ` · next ${relativeTime(d.nextAttemptAt)}` : ""}
                  </p>
                </Td>
                <Td className="text-xs">
                  {d.responseStatus ?? "—"}
                  {d.durationMs !== null && <span className="text-fg-muted"> · {d.durationMs} ms</span>}
                  {d.error && <p className="max-w-56 truncate text-danger" title={d.error}>{d.error}</p>}
                </Td>
                <Td className="text-xs whitespace-nowrap text-fg-muted">{formatDate(d.createdAt)}</Td>
                <Td>
                  {d.status === "failed" && !(d.payload as { test?: boolean }).test && (
                    <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); retry.mutate(d.id); }} loading={retry.isPending && retry.variables === d.id}>
                      Retry
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Dialog>
  );
}

function VerifyGuide() {
  const [lang, setLang] = useState<"node" | "python" | "php">("node");
  const code = {
    node: `import crypto from "node:crypto";
import express from "express";

const app = express();
// Verify against the raw body, before any JSON parsing.
app.post("/webhooks/woomarket", express.raw({ type: "application/json" }), (req, res) => {
  const header = req.get("${WEBHOOK_HEADERS.signature}") ?? "";
  const [, t, v1] = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header) ?? [];
  const expected = crypto.createHmac("sha256", process.env.WOOMARKET_WEBHOOK_SECRET)
    .update(\`\${t}.\${req.body}\`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  if (!v1 || !fresh || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) return res.sendStatus(401);

  const event = JSON.parse(req.body);
  // Deliveries can repeat: skip event.id values you've already handled.
  console.log(event.event, event.data);
  res.sendStatus(200);
});`,
    python: `import hmac, hashlib, time, json, os
from flask import Flask, request, abort

app = Flask(__name__)

@app.post("/webhooks/woomarket")
def woomarket():
    header = request.headers.get("${WEBHOOK_HEADERS.signature}", "")
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    body = request.get_data(as_text=True)
    expected = hmac.new(os.environ["WOOMARKET_WEBHOOK_SECRET"].encode(), f"{parts.get('t')}.{body}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, parts.get("v1", "")) or abs(time.time() - int(parts.get("t", 0))) > 300:
        abort(401)
    event = json.loads(body)
    print(event["event"], event["data"])
    return "", 200`,
    php: `<?php
$body = file_get_contents("php://input");
preg_match('/^t=(\\d+),v1=([0-9a-f]{64})$/', $_SERVER["HTTP_X_WM_SIGNATURE"] ?? "", $m);
$expected = hash_hmac("sha256", ($m[1] ?? "") . "." . $body, getenv("WOOMARKET_WEBHOOK_SECRET"));
if (!$m || !hash_equals($expected, $m[2]) || abs(time() - (int) $m[1]) > 300) {
    http_response_code(401);
    exit;
}
$event = json_decode($body, true);
error_log($event["event"]);
http_response_code(200);`,
  }[lang];
  return (
    <Card>
      <CardHeader title="Verify signatures" description={`Every request carries ${WEBHOOK_HEADERS.signature}: t=<unix time>,v1=<HMAC-SHA256 of "t.body" with your secret>. Reply with any 2xx within 10 seconds.`} />
      <div className="flex flex-col gap-3 p-5">
        <Tabs value={lang} onChange={setLang} tabs={[{ value: "node", label: "Node.js" }, { value: "python", label: "Python" }, { value: "php", label: "PHP" }]} />
        <Code>{code}</Code>
        <ul className="list-disc space-y-1 pl-5 text-xs text-fg-muted">
          <li>Failed deliveries are retried after 1 minute, 5 minutes, 30 minutes, 2, 6 and 12 hours ({WEBHOOK_MAX_ATTEMPTS} tries in all).</li>
          <li>A webhook is turned off after 20 deliveries in a row fail for good, or straight away if it answers <code>410 Gone</code>.</li>
          <li>Redirects aren't followed. Use the final URL.</li>
          <li>Deliveries can occasionally arrive twice or out of order; use <code>id</code> and <code>createdAt</code> to de-duplicate.</li>
        </ul>
      </div>
    </Card>
  );
}

function ZapierGuide() {
  const base = window.location.origin;
  return (
    <Card>
      <CardHeader title="Zapier and Make" description="Two ways to connect." />
      <div className="grid gap-5 p-5 text-sm md:grid-cols-2">
        <div>
          <p className="font-medium">Quickest: a catch hook</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-fg-muted">
            <li>In Zapier choose <em>Webhooks by Zapier → Catch Hook</em> (in Make: <em>Webhooks → Custom webhook</em>).</li>
            <li>Copy the URL it gives you.</li>
            <li>Click <em>Add webhook</em> here, paste it and pick events.</li>
            <li>Use <em>Send test</em> so Zapier/Make can see the fields.</li>
          </ol>
        </div>
        <div>
          <p className="font-medium">For your own Zapier/Make app: REST hooks</p>
          <p className="mt-2 text-fg-muted">Authenticate with an access key (Basic auth), then:</p>
          <ul className="mt-2 space-y-1.5 text-xs">
            {[
              ["GET", "/api/v1/me", "test the connection"],
              ["POST", "/api/v1/webhooks", 'subscribe: {"url", "event"}'],
              ["DELETE", "/api/v1/webhooks/{id}", "unsubscribe"],
              ["GET", "/api/v1/webhooks/samples/{event}", "sample data"],
              ["GET", "/api/v1/webhooks/events", "list events"],
            ].map(([m, path, what]) => (
              <li key={path + m} className="flex flex-wrap gap-x-2">
                <code className="w-14 font-semibold">{m}</code>
                <code className="break-all">{path}</code>
                <span className="text-fg-muted">{what}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-fg-muted">Base URL: <code>{base}</code></p>
        </div>
      </div>
    </Card>
  );
}

export default function WebhooksPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading, error, refetch } = useQuery<{ data: Endpoint[] }>({ queryKey: [KEY], refetchInterval: 15_000 });
  const [editing, setEditing] = useState<Endpoint | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [secretFor, setSecretFor] = useState<Endpoint | null>(null);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [testing, setTesting] = useState<Endpoint | null>(null);
  const [history, setHistory] = useState<Endpoint | null>(null);

  const toggle = useMutation({
    mutationFn: (e: Endpoint) => apiRequest("PUT", `${KEY}/${e.id}`, { enabled: !e.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
    onError: (err) => toast({ title: "Could not update", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `${KEY}/${id}`),
    onSuccess: () => {
      toast({ title: "Webhook deleted", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [KEY] });
    },
  });
  const endpoints = useMemo(() => data?.data ?? [], [data]);

  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <PageContainer>
      <PageHeader
        title="Webhooks"
        description="Get a signed POST to your own app, Zapier or Make when messages arrive, contacts change or campaigns finish."
        actions={<Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="h-4 w-4" /> Add webhook</Button>}
      />
      <div className="flex flex-col gap-6">
        {endpoints.length === 0 ? (
          <Card>
            <EmptyState icon={<Webhook className="h-10 w-10" />} title="No webhooks yet" description="Add a URL to start receiving events such as “message received” or “contact created”." action={<Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="h-4 w-4" /> Add webhook</Button>} />
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {endpoints.map((e) => (
                <li key={e.id} className="flex flex-col gap-3 p-5 lg:flex-row lg:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="truncate text-sm font-medium">{e.url}</code>
                      {SOURCE_LABEL[e.source] && <Badge tone="info">{SOURCE_LABEL[e.source]}</Badge>}
                      {!e.enabled && <Badge tone="warning">Off</Badge>}
                    </div>
                    {e.description && <p className="mt-0.5 text-sm text-fg-muted">{e.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {e.events.includes("*") ? <Badge>All events</Badge> : e.events.map((ev) => <Badge key={ev}>{ev}</Badge>)}
                    </div>
                    {e.disabledReason && !e.enabled && (
                      <p className="mt-2 flex items-start gap-1.5 text-xs text-warning"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{e.disabledReason} Fix the receiver, then turn it back on.</p>
                    )}
                    <p className="mt-2 text-xs text-fg-muted">
                      Last 7 days: {e.stats.succeeded} delivered · <span className={e.stats.failed ? "text-danger" : ""}>{e.stats.failed} failed</span>
                      {e.stats.pending ? ` · ${e.stats.pending} retrying` : ""}
                      {e.lastSuccessAt ? ` · last success ${relativeTime(e.lastSuccessAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Switch checked={e.enabled} onChange={() => toggle.mutate(e)} label={<span className="sr-only">Enabled</span>} />
                    <Button size="sm" variant="ghost" onClick={() => setTesting(e)}><Send className="h-3.5 w-3.5" /> Test</Button>
                    <Button size="sm" variant="ghost" onClick={() => setHistory(e)}><History className="h-3.5 w-3.5" /> Deliveries</Button>
                    <Button size="sm" variant="ghost" onClick={() => setSecretFor(e)}><KeyRound className="h-3.5 w-3.5" /> Secret</Button>
                    <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => { setEditing(e); setFormOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Delete"
                      onClick={async () => {
                        if (await confirm({ title: "Delete this webhook?", description: e.source === "zapier" || e.source === "make" ? "It was created by an integration; the Zap or scenario will stop receiving events." : "Events stop being sent to this URL.", confirmText: "Delete", destructive: true })) remove.mutate(e.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <ZapierGuide />
        <VerifyGuide />
      </div>

      <EndpointDialog editing={editing} open={formOpen} onClose={() => setFormOpen(false)} onCreated={(s) => setFreshSecret(s)} />
      <SecretDialog endpoint={secretFor} fresh={freshSecret} onClose={() => { setSecretFor(null); setFreshSecret(null); }} />
      <TestDialog key={testing?.id ?? "none"} endpoint={testing} onClose={() => setTesting(null)} />
      <DeliveriesDialog endpoint={history} onClose={() => setHistory(null)} />
    </PageContainer>
  );
}
