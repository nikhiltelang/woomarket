import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Download, KeyRound, Plus, Trash2 } from "lucide-react";
import { API_CHANNELS, MAX_API_AUDIENCE, MAX_API_GROUPS, MAX_API_RECIPIENTS, SIGNATURE_WINDOW_SECONDS, type ApiChannel } from "@shared/public-api";
import { useChannel } from "@/contexts/channel";
import { apiRequest, fieldErrors, queryClient } from "@/lib/api";
import { cn, formatDate, formatNumber, relativeTime } from "@/lib/utils";
import { channelMeta } from "@/lib/channels";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, PageLoader, StatusBadge } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, Tabs, useConfirm, useToast } from "@/components/ui/overlay";

interface KeyRow {
  id: string;
  name: string;
  accessKeyId: string;
  secretLast4: string;
  channels: ApiChannel[];
  defaultChannelId: string | null;
  status: "active" | "revoked" | "expired";
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  requestCount: number;
  createdAt: string;
}
const KEY = "/api/api-keys";

function CopyText({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={`Copy ${label}`}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

function Code({ children, copy }: { children: string; copy?: boolean }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-border bg-subtle p-3 pr-12 font-mono text-xs leading-relaxed">{children}</pre>
      {copy !== false && (
        <div className="absolute top-1.5 right-1.5">
          <CopyText text={children} label="code" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create + reveal
// ---------------------------------------------------------------------------

function CreateKeyDialog({ open, onClose, onCreated, numbers }: { open: boolean; onClose: () => void; onCreated: (k: KeyRow, secret: string) => void; numbers: { id: string; name: string; phoneNumber: string | null }[] }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<ApiChannel[]>([...API_CHANNELS]);
  const [defaultChannelId, setDefault] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setName("");
      setChannels([...API_CHANNELS]);
      setDefault("");
      setExpiresOn("");
      setErrors({});
    }
  }, [open]);
  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ data: KeyRow; secretAccessKey: string }>("POST", KEY, {
        name,
        channels,
        defaultChannelId: channels.includes("whatsapp") && defaultChannelId ? defaultChannelId : null,
        expiresAt: expiresOn ? new Date(`${expiresOn}T23:59:59`).toISOString() : null,
      }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: [KEY] });
      onCreated(r.data, r.secretAccessKey);
    },
    onError: (err) => {
      const fe = fieldErrors(err);
      setErrors(fe);
      if (!Object.keys(fe).length) toast({ title: "Could not create key", description: (err as Error).message, variant: "error" });
    },
  });
  const toggle = (c: ApiChannel, on: boolean) => setChannels((list) => (on ? [...new Set([...list, c])] : list.filter((x) => x !== c)));

  return (
    <Dialog open={open} onClose={onClose} title="Create access key" description="Your application uses the key to send through the API." footer={<Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || !channels.length}>Create key</Button>}>
      <div className="space-y-4">
        <Field label="Name" htmlFor="ak-name" required error={errors.name} hint="Where it's used, e.g. “Shop backend (production)”.">
          <Input id="ak-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} invalid={Boolean(errors.name)} />
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Allowed channels</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {API_CHANNELS.map((c) => <Checkbox key={c} label={channelMeta(c).label} checked={channels.includes(c)} onChange={(on) => toggle(c, on)} />)}
          </div>
          {errors.channels && <p className="mt-1 text-xs text-danger">{errors.channels}</p>}
        </fieldset>
        {channels.includes("whatsapp") && numbers.length > 1 && (
          <Field label="Default WhatsApp number" htmlFor="ak-from" hint='Used when a request has no "from".'>
            <Select id="ak-from" value={defaultChannelId} onChange={(e) => setDefault(e.target.value)}>
              <option value="">None — requests must say "from"</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{n.name}{n.phoneNumber ? ` · ${n.phoneNumber}` : ""}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Expires (optional)" htmlFor="ak-exp" error={errors.expiresAt} hint="Leave empty for a key that works until you revoke it.">
          <Input id="ak-exp" type="date" className="w-48" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function RevealDialog({ created, onClose }: { created: { key: KeyRow; secret: string } | null; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [created]);
  if (!created) return null;
  const download = () => {
    const blob = new Blob([`Access key name,Access key ID,Secret access key\n"${created.key.name.replace(/"/g, '""')}",${created.key.accessKeyId},${created.secret}\n`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${created.key.accessKeyId}_credentials.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setSaved(true);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Save your secret access key"
      footer={
        <>
          <Button variant="outline" onClick={download}><Download className="h-4 w-4" /> Download .csv</Button>
          <Button onClick={onClose}>{saved ? "Done" : "I've saved it"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          This is the only time the secret is shown. Store it in your application's secret manager; if it's lost, create a new key.
        </div>
        {[
          ["Access key ID", created.key.accessKeyId],
          ["Secret access key", created.secret],
        ].map(([label, value]) => (
          <div key={label}>
            <p className="mb-1 text-sm font-medium">{label}</p>
            <div className="flex items-center gap-1 rounded-md border border-border bg-subtle pl-3">
              <code className="min-w-0 flex-1 truncate py-2 font-mono text-sm">{value}</code>
              <CopyText text={value} label={label} />
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

function Docs() {
  const base = window.location.origin;
  const [auth, setAuth] = useState<"basic" | "signed">("basic");
  const [lang, setLang] = useState<"node" | "python" | "php">("node");
  const [example, setExample] = useState<ApiChannel>("email");
  const groupList = useQuery<{ data: { id: string; name: string; contactCount: number }[] }>({ queryKey: ["/api/groups"] });
  const sampleGroup = groupList.data?.data[0];
  const bodies: Record<ApiChannel, string> = {
    email: JSON.stringify({ channel: "email", subject: "Your order has shipped", html: "<p>Hi {{first_name}}, your order is on its way.</p>", senderName: "Acme Store", recipients: ["ada@example.com", { email: "grace@example.com", name: "Grace Hopper" }] }, null, 2),
    sms: JSON.stringify({ channel: "sms", message: "Hi {{first_name}}, your code is 4821.", recipients: ["+14155550123", { phone: "+447700900123", name: "Grace" }] }, null, 2),
    whatsapp: JSON.stringify({ channel: "whatsapp", template: { name: "order_update", language: "en_US" }, recipients: [{ phone: "+14155550123", name: "Ada", variables: ["Ada", "#1042"] }] }, null, 2),
  };
  const groupBodies: Record<ApiChannel, string> = {
    email: JSON.stringify({ channel: "email", subject: "Autumn sale starts today", html: "<p>Hi {{first_name}}, 20% off everything.</p>", groups: [sampleGroup?.name ?? "VIP customers", "Newsletter"] }, null, 2),
    sms: JSON.stringify({ channel: "sms", message: "Hi {{first_name}}, the sale starts today!", groups: [sampleGroup?.id ?? "<group id>"], recipients: ["+14155550123"] }, null, 2),
    whatsapp: JSON.stringify({ channel: "whatsapp", template: { name: "summer_sale", variables: ["{{first_name}}", "20%"] }, groups: [sampleGroup?.name ?? "VIP customers"] }, null, 2),
  };
  const response = JSON.stringify({ data: { id: "4f6c…", channel: "email", name: "API · email · 2026-10-07 09:30 UTC", status: "sending", scheduledAt: null, testMode: false, recipients: { requested: 3, accepted: 2, rejected: [{ recipient: "old@example.com", reason: "unsubscribed" }] }, groups: [] } }, null, 2);
  const curl = `curl ${base}/api/v1/send \\
  -u "$WM_ACCESS_KEY_ID:$WM_SECRET_ACCESS_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1042-shipped" \\
  -d '${JSON.stringify(JSON.parse(bodies.sms))}'`;
  const signedCode = {
    node: `import crypto from "node:crypto";

const body = JSON.stringify({ channel: "sms", message: "Hello!", recipients: ["+14155550123"] });
const ts = Math.floor(Date.now() / 1000).toString();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const toSign = [ts, "POST", "/api/v1/send", sha(body)].join("\\n");
const signature = crypto.createHmac("sha256", process.env.WM_SECRET_ACCESS_KEY).update(toSign).digest("hex");

const res = await fetch("${base}/api/v1/send", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-WM-Access-Key-Id": process.env.WM_ACCESS_KEY_ID,
    "X-WM-Timestamp": ts,
    "X-WM-Signature": signature,
  },
  body, // send exactly the bytes you signed
});
console.log(res.status, await res.json());`,
    python: `import hashlib, hmac, json, os, time, requests

body = json.dumps({"channel": "sms", "message": "Hello!", "recipients": ["+14155550123"]})
ts = str(int(time.time()))
to_sign = "\\n".join([ts, "POST", "/api/v1/send", hashlib.sha256(body.encode()).hexdigest()])
signature = hmac.new(os.environ["WM_SECRET_ACCESS_KEY"].encode(), to_sign.encode(), hashlib.sha256).hexdigest()

res = requests.post("${base}/api/v1/send", data=body, headers={
    "Content-Type": "application/json",
    "X-WM-Access-Key-Id": os.environ["WM_ACCESS_KEY_ID"],
    "X-WM-Timestamp": ts,
    "X-WM-Signature": signature,
})
print(res.status_code, res.json())`,
    php: `<?php
$body = json_encode(["channel" => "sms", "message" => "Hello!", "recipients" => ["+14155550123"]]);
$ts = (string) time();
$toSign = implode("\\n", [$ts, "POST", "/api/v1/send", hash("sha256", $body)]);
$signature = hash_hmac("sha256", $toSign, getenv("WM_SECRET_ACCESS_KEY"));

$ch = curl_init("${base}/api/v1/send");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => $body,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    "Content-Type: application/json",
    "X-WM-Access-Key-Id: " . getenv("WM_ACCESS_KEY_ID"),
    "X-WM-Timestamp: $ts",
    "X-WM-Signature: $signature",
  ],
]);
echo curl_exec($ch);`,
  };
  const errorsList: [string, string, string][] = [
    ["400", "BAD_REQUEST", "The body is invalid; details lists each field."],
    ["401", "INVALID_CREDENTIALS / INVALID_SIGNATURE", "Wrong key ID, secret or signature."],
    ["401", "TIMESTAMP_OUT_OF_RANGE / REPLAYED_REQUEST", `Signed request older than ${SIGNATURE_WINDOW_SECONDS / 60} minutes, or sent twice.`],
    ["401", "KEY_REVOKED / KEY_EXPIRED", "The key no longer works; create a new one."],
    ["403", "API_NOT_INCLUDED / CHANNEL_NOT_ALLOWED", "Your account level or this key doesn't allow it."],
    ["403", "PLAN_LIMIT / LEVEL_LIMIT", "A plan or monthly message limit was reached."],
    ["409", "IDEMPOTENCY_KEY_REUSED", "Same Idempotency-Key with a different body."],
    ["422", "GROUP_NOT_FOUND / AMBIGUOUS_GROUP / EMPTY_AUDIENCE", "A group name or id didn't match, matched several groups, or has no reachable members."],
    ["422", "NO_VALID_RECIPIENTS / TEMPLATE_NOT_AVAILABLE / SMTP_NOT_CONFIGURED", "Nothing can be sent as asked; the message explains why."],
    ["429", "RATE_LIMITED", "More than 120 requests a minute for one key."],
  ];

  return (
    <Card>
      <CardHeader title="Developer guide" description="One endpoint sends email, SMS and WhatsApp." />
      <div className="space-y-6 p-5 text-sm">
        <section>
          <h3 className="mb-2 font-medium">Endpoint</h3>
          <Code>{`POST ${base}/api/v1/send`}</Code>
          <p className="mt-2 text-fg-muted">
            Up to {formatNumber(MAX_API_RECIPIENTS)} listed recipients per request, or whole contact groups (see below). Each request becomes a campaign you can follow in the app (delivery, opens, failures). Responses are <code>202 Accepted</code>: messages are queued and delivered in the background. Add <code>scheduleAt</code> (ISO 8601) to send later.
          </p>
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">Authentication</h3>
            <Tabs value={auth} onChange={setAuth} tabs={[{ value: "basic", label: "Basic (simplest)" }, { value: "signed", label: "Signed (recommended)" }]} />
          </div>
          {auth === "basic" ? (
            <>
              <p className="mb-2 text-fg-muted">Send the Access Key ID and Secret Access Key as HTTP Basic credentials, over HTTPS only.</p>
              <Code>{curl}</Code>
            </>
          ) : (
            <>
              <p className="mb-2 text-fg-muted">
                The secret never leaves your server. Sign each request with HMAC-SHA256 over four lines — unix timestamp, method, path, and the hex SHA-256 of the exact body — and send the hex signature with the key ID and timestamp. Timestamps must be within {SIGNATURE_WINDOW_SECONDS / 60} minutes, and each signature works once.
              </p>
              <Code copy={false}>{`string to sign = timestamp + "\\n" + "POST" + "\\n" + "/api/v1/send" + "\\n" + hex(sha256(body))
X-WM-Access-Key-Id: AKWM…
X-WM-Timestamp:     1791375000
X-WM-Signature:     hex(hmac_sha256(secret, string to sign))`}</Code>
              <div className="mt-3 mb-2"><Tabs value={lang} onChange={setLang} tabs={[{ value: "node", label: "Node.js" }, { value: "python", label: "Python" }, { value: "php", label: "PHP" }]} /></div>
              <Code>{signedCode[lang]}</Code>
            </>
          )}
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">Request body</h3>
            <Tabs value={example} onChange={setExample} tabs={API_CHANNELS.map((c) => ({ value: c, label: channelMeta(c).label }))} />
          </div>
          <Code>{bodies[example]}</Code>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-fg-muted">
            {example === "email" && <li><code>subject</code> and <code>html</code> or <code>text</code> are required. Merge tags: <code>{"{{name}}"}</code>, <code>{"{{first_name}}"}</code>, <code>{"{{email}}"}</code>. An unsubscribe link is added automatically.</li>}
            {example === "sms" && <li>Phone numbers in international format with <code>+</code>. Up to 1,600 characters; long texts are billed as several segments.</li>}
            {example === "whatsapp" && <li>Uses an approved template. <code>variables</code> fill {"{{1}}"}, {"{{2}}"}… in order. Add <code>from</code> (number id or phone) if your account has several numbers.</li>}
            <li>Contacts' custom fields work as merge tags too, e.g. <code>{"{{age}}"}</code> or <code>{"{{city}}"}</code>, for group members and other saved contacts; a field a contact doesn't have is left blank.</li>
            <li>Recipients who unsubscribed are skipped and listed under <code>rejected</code>.</li>
          </ul>
        </section>

        <section>
          <h3 className="mb-2 font-medium">Sending to groups</h3>
          <p className="mb-2 text-fg-muted">
            Add <code>groups</code> — up to {MAX_API_GROUPS} group ids or exact group names — instead of, or together with, <code>recipients</code>. Every active member of each group is included once, even if they're in several groups or also listed in <code>recipients</code>; up to {formatNumber(MAX_API_AUDIENCE)} people per request.
          </p>
          <Code>{groupBodies[example]}</Code>
          <ul className="mt-2 mb-3 list-disc space-y-1 pl-5 text-fg-muted">
            <li>Email reaches members with an email address; SMS reaches members with a phone number.</li>
            <li>WhatsApp sends from one number to that number's contacts. Without <code>from</code>, the group's own number is used. Fill template variables for everyone with <code>template.variables</code> — merge tags such as <code>{"{{first_name}}"}</code> are replaced per member.</li>
            <li>The response's <code>groups</code> field shows how many members of each group were reached.</li>
          </ul>
          <p className="mb-1.5 text-xs font-medium tracking-wide text-fg-muted uppercase">Your groups</p>
          {groupList.data?.data.length ? (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-subtle"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Group id</th><th className="px-3 py-2 text-right">Members</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {groupList.data.data.map((g) => (
                    <tr key={g.id}>
                      <td className="px-3 py-1.5">{g.name}</td>
                      <td className="px-3 py-1.5"><span className="inline-flex items-center gap-1 font-mono">{g.id}<CopyText text={g.id} label={`id of ${g.name}`} /></span></td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(g.contactCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-fg-muted">No groups yet — create them under Audience → Groups.</p>
          )}
        </section>

        <section>
          <h3 className="mb-2 font-medium">Response</h3>
          <Code>{response}</Code>
          <p className="mt-2 text-fg-muted"><code>testMode: true</code> means no real provider is configured for that channel yet, so messages go to the simulator.</p>
        </section>

        <section>
          <h3 className="mb-2 font-medium">Retries</h3>
          <p className="text-fg-muted">Send an <code>Idempotency-Key</code> header (any unique string, e.g. your order ID). If you retry with the same key within 24 hours, you get the first response back and nothing is sent twice.</p>
        </section>

        <section>
          <h3 className="mb-2 font-medium">Errors</h3>
          <p className="mb-2 text-fg-muted">Errors are JSON: <code>{`{ "success": false, "message": "…", "code": "…", "details": … }`}</code></p>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-subtle"><tr><th className="px-3 py-2">Status</th><th className="px-3 py-2">Code</th><th className="px-3 py-2">Meaning</th></tr></thead>
              <tbody className="divide-y divide-border">
                {errorsList.map(([s, c, m]) => (
                  <tr key={c}><td className="px-3 py-2 tabular-nums">{s}</td><td className="px-3 py-2 font-mono">{c}</td><td className="px-3 py-2">{m}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: KeyRow["status"] }) {
  if (status === "active") return <Badge tone="success">Active</Badge>;
  if (status === "expired") return <Badge tone="warning">Expired</Badge>;
  return <StatusBadge status="revoked" />;
}

export default function ApiKeysPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { channels: numbers } = useChannel();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ key: KeyRow; secret: string } | null>(null);
  const { data, isLoading, error, refetch } = useQuery<{ data: KeyRow[]; access: { allowed: boolean; levelName: string | null } }>({ queryKey: [KEY] });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "revoke" | "delete" }) => (action === "revoke" ? apiRequest("POST", `${KEY}/${id}/revoke`) : apiRequest("DELETE", `${KEY}/${id}`)),
    onSuccess: (_r, v) => {
      toast({ title: v.action === "revoke" ? "Key revoked" : "Key deleted", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [KEY] });
    },
    onError: (err) => toast({ title: "Action failed", description: (err as Error).message, variant: "error" }),
  });
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  const keys = data?.data ?? [];
  const access = data?.access;

  return (
    <PageContainer wide>
      <PageHeader
        title="API keys"
        description="Let your own applications send email, SMS and WhatsApp through one endpoint."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Create access key</Button>}
      />
      {access && !access.allowed && (
        <div className="mb-4 flex gap-2 rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          API access isn't included in your account level{access.levelName ? ` (${access.levelName})` : ""}. You can create keys, but requests are refused until the platform administrator enables it.
        </div>
      )}
      <Card className="mb-6 overflow-hidden">
        {!keys.length ? (
          <EmptyState icon={<KeyRound className="h-10 w-10" />} title="No access keys yet" description="Create a key, then use its Access Key ID and Secret Access Key in your application." action={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Create access key</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Access key ID</Th>
                <Th className="hidden md:table-cell">Channels</Th>
                <Th className="hidden lg:table-cell">Last used</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <Tr key={k.id}>
                  <Td>
                    <p className="font-medium">{k.name}</p>
                    <p className="text-xs text-fg-muted">Created {formatDate(k.createdAt)}{k.expiresAt ? ` · expires ${formatDate(k.expiresAt)}` : ""}</p>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      <code className="font-mono text-xs">{k.accessKeyId}</code>
                      <CopyText text={k.accessKeyId} label="access key ID" />
                    </div>
                    <p className="font-mono text-xs text-fg-muted">secret ••••{k.secretLast4}</p>
                  </Td>
                  <Td className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">{k.channels.map((c) => <Badge key={c}>{channelMeta(c).label}</Badge>)}</div>
                  </Td>
                  <Td className="hidden lg:table-cell">
                    {k.lastUsedAt ? (
                      <>
                        <p>{relativeTime(k.lastUsedAt)}</p>
                        <p className="text-xs text-fg-muted">{formatNumber(k.requestCount)} requests · {k.lastUsedIp}</p>
                      </>
                    ) : (
                      <span className="text-fg-muted">Never</span>
                    )}
                  </Td>
                  <Td><StatusPill status={k.status} /></Td>
                  <Td className="text-right whitespace-nowrap">
                    {k.status === "active" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-danger"
                        onClick={async () => {
                          if (await confirm({ title: `Revoke "${k.name}"?`, description: "Applications using this key stop working immediately. This can't be undone.", confirmText: "Revoke", destructive: true })) act.mutate({ id: k.id, action: "revoke" });
                        }}
                      >
                        Revoke
                      </Button>
                    ) : (
                      <Button size="icon" variant="ghost" aria-label={`Delete ${k.name}`} onClick={() => act.mutate({ id: k.id, action: "delete" })}>
                        <Trash2 className={cn("h-4 w-4 text-danger")} />
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Docs />
      <CreateKeyDialog
        open={creating}
        numbers={numbers}
        onClose={() => setCreating(false)}
        onCreated={(key, secret) => {
          setCreating(false);
          setCreated({ key, secret });
        }}
      />
      <RevealDialog created={created} onClose={() => setCreated(null)} />
    </PageContainer>
  );
}

