import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2, Copy, FlaskConical, PlugZap, Search, Send, ShieldOff, Trash2, XCircle } from "lucide-react";
import { SES_REGIONS } from "@shared/validation";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, formatDate, formatNumber, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Tabs, useConfirm, useToast } from "@/components/ui/overlay";

type Provider = "smtp" | "ses";

interface Saved {
  provider: Provider;
  fromName: string;
  fromEmail: string;
  hasPassword: boolean;
  updatedAt: string;
  // SMTP
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  // SES
  region?: string;
  accessKeyId?: string;
  configurationSet?: string;
  feedbackUrl?: string;
  snsTopicArn?: string | null;
}

interface SmtpResponse {
  data: Saved | null;
  effective: { source: "tenant" | "platform" | "env" | "simulator" | "none"; provider?: Provider; fromEmail?: string; fromName?: string; error?: string };
}

interface SesCheck {
  region: string;
  sendingEnabled: boolean;
  productionAccess: boolean;
  max24HourSend: number;
  maxSendRate: number;
  sentLast24Hours: number;
  enforcementStatus: string | null;
  identity: { name: string; type: string; verified: boolean } | null;
  configurationSet: string | null;
}

const SOURCE_TEXT: Record<string, string> = {
  tenant: "Sending through your own email settings.",
  platform: "Sending through the platform's default email settings. Add your own below to send from your domain.",
  env: "Sending through the server's SMTP configuration (environment variables).",
  simulator: "Simulated: emails are captured on the server and not delivered. Configure SMTP or Amazon SES to send real email.",
  none: "No email provider configured — email campaigns can't be sent yet.",
};

function CopyField({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-subtle pl-3">
      <code className="min-w-0 flex-1 truncate py-2 text-xs">{value}</code>
      <Button
        size="icon"
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={() => void navigator.clipboard?.writeText(value).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}
      >
        {done ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

function SesResult({ r }: { r: SesCheck }) {
  const item = (ok: boolean, text: React.ReactNode, warn = false) => (
    <li className="flex items-start gap-2">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : warn ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
      <span>{text}</span>
    </li>
  );
  return (
    <div className="rounded-md border border-border p-4 text-sm">
      <p className="mb-2 font-medium">Amazon SES · {r.region}</p>
      <ul className="space-y-1.5">
        {item(true, "Credentials accepted")}
        {item(r.sendingEnabled, r.sendingEnabled ? "Sending is enabled" : "Sending is disabled for this account")}
        {item(
          r.productionAccess,
          r.productionAccess ? (
            "Production access: you can email any address"
          ) : (
            <>Sandbox: SES only delivers to verified addresses, at 1 email/second and 200 a day. <a className="text-primary underline" href="https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html" target="_blank" rel="noreferrer">Request production access</a> before sending campaigns.</>
          ),
          true,
        )}
        {item(true, `Quota: ${formatNumber(r.sentLast24Hours)} of ${formatNumber(r.max24HourSend)} sent in the last 24 hours · up to ${formatNumber(r.maxSendRate)} per second`)}
        {r.identity
          ? item(r.identity.verified, r.identity.verified ? `Sender verified (${r.identity.type === "DOMAIN" ? "domain" : "address"} ${r.identity.name})` : `${r.identity.name} is added to SES but not verified yet. Finish verification (DNS records or the confirmation email).`)
          : item(false, "The From address and its domain aren't verified identities in this region. Add and verify one under SES → Identities.")}
        {r.configurationSet && item(true, `Configuration set "${r.configurationSet}" found`)}
        {r.enforcementStatus && r.enforcementStatus !== "HEALTHY" && item(false, `Account status: ${r.enforcementStatus.toLowerCase()} — check the SES reputation dashboard.`)}
      </ul>
    </div>
  );
}

/** Email sending settings (SMTP or Amazon SES) for a tenant, or the platform default (`platform`). */
export function SmtpSettings({ platform = false, canEdit }: { platform?: boolean; canEdit: boolean }) {
  const toast = useToast();
  const key = [platform ? "/api/admin/getSmtpConfig" : "/api/smtp/config"];
  const { data } = useQuery<SmtpResponse>({ queryKey: key });
  const [provider, setProvider] = useState<Provider>("smtp");
  const [v, setV] = useState({ host: "", port: "587", secure: false, user: "", password: "", fromName: "", fromEmail: "" });
  const [ses, setSes] = useState({ region: "us-east-1", accessKeyId: "", secretAccessKey: "", configurationSet: "" });
  const [sendTo, setSendTo] = useState("");
  const [check, setCheck] = useState<SesCheck | null>(null);

  const saved = data?.data;
  useEffect(() => {
    if (!saved) return;
    setProvider(saved.provider);
    setV((s) => ({ ...s, fromName: saved.fromName, fromEmail: saved.fromEmail, password: "", ...(saved.provider === "smtp" ? { host: saved.host ?? "", port: String(saved.port ?? 587), secure: Boolean(saved.secure), user: saved.user ?? "" } : {}) }));
    if (saved.provider === "ses") setSes({ region: saved.region ?? "us-east-1", accessKeyId: saved.accessKeyId ?? "", secretAccessKey: "", configurationSet: saved.configurationSet ?? "" });
  }, [saved]);
  useEffect(() => setCheck(null), [provider, ses.region, ses.accessKeyId, ses.secretAccessKey, ses.configurationSet, v.fromEmail]);

  const keepSecret = saved?.hasPassword && saved.provider === provider;
  const body = () =>
    provider === "ses"
      ? { provider, region: ses.region, accessKeyId: ses.accessKeyId.trim(), secretAccessKey: ses.secretAccessKey || undefined, configurationSet: ses.configurationSet.trim(), fromName: v.fromName, fromEmail: v.fromEmail }
      : { provider, host: v.host, port: Number(v.port), secure: v.secure, user: v.user, password: v.password || undefined, fromName: v.fromName, fromEmail: v.fromEmail };

  const save = useMutation({
    mutationFn: () => apiRequest("POST", platform ? "/api/admin/smtpConfig" : "/api/smtp/config", body()),
    onSuccess: () => {
      toast({ title: "Email settings saved", variant: "success" });
      setV((s) => ({ ...s, password: "" }));
      setSes((s) => ({ ...s, secretAccessKey: "" }));
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  const test = useMutation({
    mutationFn: (mode: "connect" | "send") => apiRequest<{ sent: boolean; simulated?: boolean; provider?: Provider; ses?: SesCheck }>("POST", "/api/smtp/test", mode === "connect" ? body() : { sendTo }),
    onSuccess: (r) => {
      if (r.ses) setCheck(r.ses);
      toast({ title: r.sent ? (r.simulated ? "Test email captured by the simulator" : `Test email sent${r.provider === "ses" ? " through Amazon SES" : ""}`) : r.ses ? "Amazon SES check complete" : "Connection successful", variant: "success" });
    },
    onError: (err) => toast({ title: "Test failed", description: (err as Error).message, variant: "error" }),
  });

  const eff = data?.effective;
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const sesValid = /^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(ses.accessKeyId.trim()) && (ses.secretAccessKey || keepSecret);
  const smtpValid = v.host && v.user && (v.password || keepSecret);
  const canSave = Boolean(v.fromEmail && v.fromName && (provider === "ses" ? sesValid : smtpValid));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={platform ? "Platform email (default for all tenants)" : "Email sending"}
          description={saved ? `${saved.provider === "ses" ? "Amazon SES" : "SMTP"} · last updated ${formatDate(saved.updatedAt)}` : "Used to send email campaigns and test emails."}
        />
        <div className="flex flex-col gap-4 p-5">
          {eff && (
            <p className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${eff.source === "none" ? "bg-danger-soft text-danger" : eff.source === "simulator" ? "bg-info-soft text-info" : "bg-success-soft text-success"}`}>
              {eff.source === "simulator" && <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>
                {SOURCE_TEXT[eff.source]}
                {eff.fromEmail && eff.source !== "simulator" && ` From: ${eff.fromName} <${eff.fromEmail}>${eff.provider === "ses" ? " via Amazon SES" : ""}`}
              </span>
            </p>
          )}

          <div>
            <p className="mb-1.5 text-sm font-medium">Provider</p>
            <Tabs value={provider} onChange={(p) => canEdit && setProvider(p)} tabs={[{ value: "smtp", label: "SMTP server" }, { value: "ses", label: "Amazon SES" }]} />
          </div>

          {provider === "smtp" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Host" htmlFor="smtp-host" className="sm:col-span-2">
                <Input id="smtp-host" value={v.host} onChange={set("host")} placeholder="smtp.example.com" disabled={!canEdit} />
              </Field>
              <Field label="Port" htmlFor="smtp-port">
                <Input id="smtp-port" type="number" value={v.port} onChange={set("port")} disabled={!canEdit} />
              </Field>
              <Field label="Username" htmlFor="smtp-user">
                <Input id="smtp-user" value={v.user} onChange={set("user")} autoComplete="off" disabled={!canEdit} />
              </Field>
              <Field label="Password" htmlFor="smtp-pass" hint={keepSecret ? "Leave blank to keep the saved password" : undefined} className="sm:col-span-2">
                <Input id="smtp-pass" type="password" value={v.password} onChange={set("password")} autoComplete="new-password" disabled={!canEdit} />
              </Field>
              <div className="sm:col-span-3">
                <Checkbox label="Use implicit TLS (usually port 465). Leave off for STARTTLS on 587." checked={v.secure} onChange={(secure) => setV((s) => ({ ...s, secure }))} disabled={!canEdit} />
              </div>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Region" htmlFor="ses-region" hint="Where your SES identities are verified.">
                <Select id="ses-region" value={ses.region} onChange={(e) => setSes({ ...ses, region: e.target.value })} disabled={!canEdit}>
                  {SES_REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </Select>
              </Field>
              <Field label="Access key ID" htmlFor="ses-key" className="sm:col-span-2" hint="An IAM user with ses:SendEmail, ses:SendRawEmail and ses:GetAccount (ses:GetEmailIdentity for the check).">
                <Input id="ses-key" value={ses.accessKeyId} onChange={(e) => setSes({ ...ses, accessKeyId: e.target.value.trim() })} autoComplete="off" placeholder="AKIA…" className="font-mono" disabled={!canEdit} />
              </Field>
              <Field label="Secret access key" htmlFor="ses-secret" className="sm:col-span-2" hint={keepSecret ? "Leave blank to keep the saved secret" : "Stored encrypted; never shown again."}>
                <Input id="ses-secret" type="password" value={ses.secretAccessKey} onChange={(e) => setSes({ ...ses, secretAccessKey: e.target.value })} autoComplete="new-password" disabled={!canEdit} />
              </Field>
              <Field label="Configuration set (optional)" htmlFor="ses-cs" hint="For event publishing or dedicated IPs.">
                <Input id="ses-cs" value={ses.configurationSet} onChange={(e) => setSes({ ...ses, configurationSet: e.target.value })} disabled={!canEdit} />
              </Field>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="From name" htmlFor="smtp-fn">
              <Input id="smtp-fn" value={v.fromName} onChange={set("fromName")} disabled={!canEdit} />
            </Field>
            <Field
              label="From email"
              htmlFor="smtp-fe"
              className="sm:col-span-2"
              hint={provider === "ses" ? "Must be a verified address, or on a verified domain, in this SES region." : "Must be allowed by your SMTP provider (SPF/DKIM aligned for good deliverability)."}
            >
              <Input id="smtp-fe" type="email" value={v.fromEmail} onChange={set("fromEmail")} disabled={!canEdit} />
            </Field>
          </div>

          {check && provider === "ses" && <SesResult r={check} />}

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!canSave}>
                Save settings
              </Button>
              <Button variant="outline" onClick={() => test.mutate("connect")} loading={test.isPending && test.variables === "connect"} disabled={provider === "ses" ? !sesValid || !v.fromEmail : !v.host || !v.user}>
                <PlugZap className="h-4 w-4" /> {provider === "ses" ? "Check SES account" : "Test connection"}
              </Button>
            </div>
          )}
          {canEdit && eff?.source !== "none" && (
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Input type="email" className="max-w-xs" placeholder="you@example.com" value={sendTo} onChange={(e) => setSendTo(e.target.value)} aria-label="Send test email to" />
              <Button variant="outline" onClick={() => test.mutate("send")} loading={test.isPending && test.variables === "send"} disabled={!sendTo}>
                <Send className="h-4 w-4" /> Send test email
              </Button>
              <span className="self-center text-xs text-fg-muted">Uses the saved settings.</span>
            </div>
          )}
        </div>
      </Card>

      {saved?.provider === "ses" && saved.feedbackUrl && (
        <Card>
          <CardHeader
            title="Bounces & complaints"
            description="Amazon SES reports undeliverable addresses and spam complaints through Amazon SNS. Hard-bounced and complaining addresses are suppressed automatically, which keeps your SES reputation healthy."
          />
          <div className="space-y-4 p-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {saved.snsTopicArn ? (
                <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> Receiving from {saved.snsTopicArn.split(":").pop()}</Badge>
              ) : (
                <Badge tone="warning">Not connected yet</Badge>
              )}
            </div>
            <Field label="Notification endpoint (HTTPS)">
              <CopyField value={saved.feedbackUrl} label="notification endpoint" />
            </Field>
            <ol className="list-decimal space-y-1.5 pl-5 text-fg-muted">
              <li>In Amazon SNS ({saved.region}), create a topic, e.g. <code>ses-feedback</code>.</li>
              <li>Add a subscription: protocol <strong>HTTPS</strong>, endpoint = the URL above. It's confirmed automatically.</li>
              <li>
                In Amazon SES → your verified identity → <strong>Notifications</strong>, send <strong>Bounce</strong> and <strong>Complaint</strong> (and optionally Delivery) feedback to that topic — or add an SNS event destination to your configuration set.
              </li>
            </ol>
            <p className="text-xs text-fg-muted">Messages are accepted only with a valid Amazon signature, and only from the first topic that connects. The endpoint must be reachable from the internet (your public URL is {new URL(saved.feedbackUrl).origin}).</p>
          </div>
        </Card>
      )}

      <SuppressionList canEdit={canEdit} />
    </div>
  );
}

interface Suppression {
  id: number;
  email: string;
  reason: "bounce" | "complaint" | "manual";
  detail: string | null;
  createdAt: string;
}

const REASON: Record<Suppression["reason"], { label: string; tone: "danger" | "warning" | "neutral" }> = {
  bounce: { label: "Hard bounce", tone: "danger" },
  complaint: { label: "Spam complaint", tone: "warning" },
  manual: { label: "Added manually", tone: "neutral" },
};

/** Addresses never emailed again (hard bounces, complaints, manual), for this tenant or the platform. */
export function SuppressionList({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [add, setAdd] = useState("");
  const key = "/api/smtp/suppressions";
  const { data } = useQuery<{ data: Suppression[]; total: number; page: number; limit: number }>({ queryKey: [key, { page, limit: 20, search: query }] });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [key] });
  const create = useMutation({
    mutationFn: () => apiRequest("POST", key, { email: add }),
    onSuccess: () => {
      setAdd("");
      refresh();
      toast({ title: "Address suppressed", variant: "success" });
    },
    onError: (err) => toast({ title: "Could not add", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${key}/${id}`),
    onSuccess: refresh,
    onError: (err) => toast({ title: "Could not remove", description: (err as Error).message, variant: "error" }),
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Suppression list"
        description="These addresses are skipped by every email campaign and API send. Bounces and complaints are added automatically when using Amazon SES."
        actions={
          <form className="flex" role="search" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(search.trim()); }}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search address" className="w-48 rounded-r-none" aria-label="Search suppressed addresses" />
            <Button type="submit" variant="outline" className="rounded-l-none" aria-label="Search"><Search className="h-4 w-4" /></Button>
          </form>
        }
      />
      {canEdit && (
        <form className="flex flex-wrap gap-2 border-b border-border px-5 py-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Input type="email" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="address@example.com" className="max-w-xs" aria-label="Address to suppress" />
          <Button type="submit" variant="outline" disabled={!add} loading={create.isPending}><ShieldOff className="h-4 w-4" /> Suppress address</Button>
        </form>
      )}
      {!data?.data.length ? (
        <EmptyState title={query ? "No matching addresses" : "No suppressed addresses"} description={query ? undefined : "Nothing has bounced or been reported as spam."} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Address</Th>
                <Th>Reason</Th>
                <Th className="hidden md:table-cell">Details</Th>
                <Th className="hidden sm:table-cell">Added</Th>
                {canEdit && <Th className="text-right">Action</Th>}
              </tr>
            </thead>
            <tbody>
              {data.data.map((s) => (
                <Tr key={s.id}>
                  <Td className="font-mono text-xs">{s.email}</Td>
                  <Td><Badge tone={REASON[s.reason]?.tone ?? "neutral"}>{REASON[s.reason]?.label ?? s.reason}</Badge></Td>
                  <Td className={cn("hidden max-w-xs truncate text-xs text-fg-muted md:table-cell")} title={s.detail ?? undefined}>{s.detail ?? "—"}</Td>
                  <Td className="hidden text-xs text-fg-muted sm:table-cell">{relativeTime(s.createdAt)}</Td>
                  {canEdit && (
                    <Td className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${s.email}`}
                        onClick={async () => {
                          if (await confirm({ title: `Email ${s.email} again?`, description: s.reason === "complaint" ? "This person reported your email as spam. Only remove it if they asked to receive email again." : "Future campaigns will include this address.", confirmText: "Remove", destructive: s.reason === "complaint" })) remove.mutate(s.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} limit={20} total={data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
