import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, Circle, Database, KeyRound, Loader2, Mail, Rocket, Settings2, ShieldCheck, UserCog, XCircle } from "lucide-react";
import { adminSchema, applicationSchema, databaseSchema, INSTALL_STEPS, smtpSchema, type DatabaseCheck, type Requirement } from "@shared/install";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Switch } from "@/components/ui/form";
import { Card } from "@/components/ui/display";

type Step = "welcome" | "database" | "application" | "admin" | "email" | "review" | "installing" | "done";
const STEPS: { key: Step; label: string; icon: typeof Database }[] = [
  { key: "welcome", label: "Welcome", icon: ShieldCheck },
  { key: "database", label: "Database", icon: Database },
  { key: "application", label: "Application", icon: Settings2 },
  { key: "admin", label: "Administrator", icon: UserCog },
  { key: "email", label: "Email", icon: Mail },
  { key: "review", label: "Install", icon: Rocket },
];

interface StepResult {
  key: string;
  label: string;
  status: "pending" | "done" | "failed";
  error?: string;
}

async function call<T>(url: string, code: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Setup-Code": code },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message ?? `Request failed (${res.status})`), { data });
  return data as T;
}

/** First problem per field, from a zod schema. */
function errorsOf<T>(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } } }, value: T): Record<string, string> {
  const r = schema.safeParse(value);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error!.issues) out[String(i.path[0])] ??= i.message;
  return out;
}

function Section({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 mb-5 text-sm text-fg-muted">{description}</p>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

const PASSWORD_RULES: [RegExp | ((v: string) => boolean), string][] = [
  [(v) => v.length >= 10, "10+ characters"],
  [/[a-z]/, "a lowercase letter"],
  [/[A-Z]/, "an uppercase letter"],
  [/\d/, "a number"],
];

export default function InstallerApp() {
  const [step, setStep] = useState<Step>("welcome");
  const [status, setStatus] = useState<{ requirements: Requirement[]; defaults: { siteName: string; appUrl: string; database: string } } | null>(null);
  const [code, setCode] = useState("");
  const [codeOk, setCodeOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [db, setDb] = useState({ host: "127.0.0.1", port: "3306", database: "woomarket360", user: "", password: "", createDatabase: true });
  const [dbCheck, setDbCheck] = useState<{ key: string; result: DatabaseCheck } | null>(null);
  const [appCfg, setAppCfg] = useState({ siteName: "WooMarket360", appUrl: window.location.origin, demoData: false });
  const [admin, setAdmin] = useState({ firstName: "", lastName: "", username: "admin", email: "", password: "", confirmPassword: "" });
  const [useSmtp, setUseSmtp] = useState(false);
  const [smtp, setSmtp] = useState({ host: "", port: "587", secure: false, user: "", pass: "", fromEmail: "", fromName: "" });
  const [results, setResults] = useState<StepResult[]>([]);
  const [appUp, setAppUp] = useState(false);

  useEffect(() => {
    if (window.location.pathname !== "/install") window.history.replaceState(null, "", "/install");
    document.title = "Install · WooMarket360";
    fetch("/api/install/status")
      .then((r) => r.json())
      .then((s) => {
        setStatus(s);
        setAppCfg((c) => ({ ...c, siteName: s.defaults.siteName, appUrl: s.defaults.appUrl }));
        setDb((d) => ({ ...d, database: s.defaults.database }));
      })
      .catch(() => setError("Couldn't reach the installer. Is the server still running?"));
  }, []);

  const dbKey = JSON.stringify(db);
  const dbErrors = useMemo(() => errorsOf(databaseSchema, { ...db, port: Number(db.port) }), [db]);
  const appErrors = useMemo(() => errorsOf(applicationSchema, appCfg), [appCfg]);
  const adminErrors = useMemo(() => errorsOf(adminSchema, admin), [admin]);
  const smtpErrors = useMemo(() => (useSmtp ? errorsOf(smtpSchema, { ...smtp, port: Number(smtp.port) }) : {}), [useSmtp, smtp]);
  const tested = dbCheck?.key === dbKey ? dbCheck.result : null;
  const reqsOk = status?.requirements.every((r) => r.ok) ?? false;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = () => run(async () => {
    await call("/api/install/verify", code, {});
    setCodeOk(true);
    setStep("database");
  });
  const testDb = () => run(async () => {
    const r = await call<{ data: DatabaseCheck }>("/api/install/test-database", code, { ...db, port: Number(db.port) });
    setDbCheck({ key: dbKey, result: r.data });
  });
  const install = () => {
    setStep("installing");
    setResults(INSTALL_STEPS.map((s) => ({ ...s, status: "pending" })));
    void run(async () => {
      try {
        const r = await call<{ steps: StepResult[] }>("/api/install/run", code, {
          database: { ...db, port: Number(db.port) },
          application: appCfg,
          admin,
          smtp: useSmtp ? { ...smtp, port: Number(smtp.port) } : null,
        });
        setResults(r.steps);
        setStep("done");
      } catch (err) {
        const steps = (err as { data?: { steps?: StepResult[] } }).data?.steps;
        if (steps) setResults(steps);
        throw err;
      }
    });
  };

  // After installing, wait for the application to come up in place of the installer.
  useEffect(() => {
    if (step !== "done" || appUp) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (r.ok) setAppUp(true);
      } catch {
        /* restarting */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [step, appUp]);

  const idx = STEPS.findIndex((s) => s.key === (step === "installing" || step === "done" ? "review" : step));
  const nav = (back: Step | null, next: Step | null, canNext: boolean, nextLabel = "Continue") => (
    <div className="mt-8 flex items-center justify-between border-t border-border pt-5">
      {back ? <Button variant="ghost" onClick={() => { setError(null); setStep(back); }}>Back</Button> : <span />}
      {next && <Button onClick={() => { setError(null); setStep(next); }} disabled={!canNext}>{nextLabel}</Button>}
    </div>
  );
  const fe = (e: Record<string, string>, k: string, touched: string) => (touched ? e[k] : undefined);

  return (
    <div className="min-h-full bg-bg px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="h-9 w-9 rounded" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Set up WooMarket360</h1>
            <p className="text-sm text-fg-muted">A few details and you're ready to go. This takes about two minutes.</p>
          </div>
        </div>

        <ol className="mb-6 flex flex-wrap gap-x-1 gap-y-2" aria-label="Setup steps">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const state = i < idx || step === "done" ? "done" : i === idx ? "current" : "todo";
            return (
              <li key={s.key} aria-current={state === "current" ? "step" : undefined} className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium", state === "current" ? "bg-primary text-primary-fg" : state === "done" ? "bg-primary-soft text-primary" : "bg-subtle text-fg-muted")}>
                {state === "done" ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                {s.label}
              </li>
            );
          })}
        </ol>

        <Card className="p-6 sm:p-8">
          {error && (
            <div role="alert" className="mb-5 flex gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {step === "welcome" && (
            <Section title="Welcome" description="First, a quick check of this server, and proof that you can see its console.">
              <ul className="space-y-2">
                {status ? status.requirements.map((r) => (
                  <li key={r.key} className="flex items-start gap-2 text-sm">
                    {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
                    <span>
                      {r.label}
                      <span className="block font-mono text-xs break-all text-fg-muted">{r.detail}</span>
                    </span>
                  </li>
                )) : <li className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Checking…</li>}
              </ul>
              {status && !reqsOk && <p className="text-sm text-danger">Fix the items marked ✗, then reload this page.</p>}
              <form onSubmit={(e) => { e.preventDefault(); void verify(); }} className="space-y-4">
                <Field label="Setup code" htmlFor="code" hint="Printed in the terminal where the server is running, e.g. K7QH-2MXP. It keeps strangers from installing on your server.">
                  <Input id="code" autoComplete="off" autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="w-48 font-mono tracking-widest" placeholder="XXXX-XXXX" />
                </Field>
                <div className="flex justify-end border-t border-border pt-5">
                  <Button type="submit" loading={busy} disabled={!reqsOk || normalise(code).length < 8}><KeyRound className="h-4 w-4" /> Start setup</Button>
                </div>
              </form>
            </Section>
          )}

          {step === "database" && codeOk && (
            <Section title="Database" description="WooMarket360 stores its data in MySQL 8.0.13 or newer. Enter an account that can create tables.">
              <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
                <Field label="Host" htmlFor="db-host" error={fe(dbErrors, "host", db.host)}><Input id="db-host" value={db.host} onChange={(e) => setDb({ ...db, host: e.target.value })} /></Field>
                <Field label="Port" htmlFor="db-port" error={dbErrors.port}><Input id="db-port" inputMode="numeric" value={db.port} onChange={(e) => setDb({ ...db, port: e.target.value })} /></Field>
              </div>
              <Field label="Database name" htmlFor="db-name" error={fe(dbErrors, "database", db.database)}><Input id="db-name" value={db.database} onChange={(e) => setDb({ ...db, database: e.target.value })} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Username" htmlFor="db-user" error={fe(dbErrors, "user", db.user)}><Input id="db-user" autoComplete="off" value={db.user} onChange={(e) => setDb({ ...db, user: e.target.value })} /></Field>
                <Field label="Password" htmlFor="db-pass"><Input id="db-pass" type="password" autoComplete="new-password" value={db.password} onChange={(e) => setDb({ ...db, password: e.target.value })} /></Field>
              </div>
              <Checkbox checked={db.createDatabase} onChange={(v) => setDb({ ...db, createDatabase: v })} label="Create the database if it doesn't exist" />
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={() => void testDb()} loading={busy} disabled={Object.keys(dbErrors).length > 0}><Database className="h-4 w-4" /> Test connection</Button>
                {tested && <span className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="h-4 w-4" /> Connected · MySQL {tested.version}</span>}
              </div>
              {tested && (
                <div className="rounded-md bg-subtle p-3 text-sm">
                  {!tested.databaseExists ? (
                    <p>The database <code>{db.database}</code> will be created.</p>
                  ) : tested.tableCount === 0 ? (
                    <p>The database <code>{db.database}</code> is empty and ready.</p>
                  ) : (
                    <p className="flex gap-2 text-warning">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        <code>{db.database}</code> already has {tested.tableCount} tables{tested.existingSuperadmins ? ` and ${tested.existingSuperadmins} superadmin account(s)` : ""}. Existing WooMarket360 data is kept and upgraded; your administrator is added (or updated if the username exists).
                      </span>
                    </p>
                  )}
                </div>
              )}
              {nav("welcome", "application", Boolean(tested))}
            </Section>
          )}

          {step === "application" && (
            <Section title="Application" description="How your platform is named and where people reach it. You can change these later in System settings.">
              <Field label="Site name" htmlFor="app-name" error={appErrors.siteName}><Input id="app-name" value={appCfg.siteName} onChange={(e) => setAppCfg({ ...appCfg, siteName: e.target.value })} /></Field>
              <Field label="Public address (URL)" htmlFor="app-url" error={appErrors.appUrl} hint="Used in emails, unsubscribe links and webhooks. Use your real domain in production, e.g. https://app.example.com.">
                <Input id="app-url" value={appCfg.appUrl} onChange={(e) => setAppCfg({ ...appCfg, appUrl: e.target.value })} />
              </Field>
              <Switch checked={appCfg.demoData} onChange={(demoData) => setAppCfg({ ...appCfg, demoData })} label="Add demo data" description="A sample tenant (demo / Demo@1234) with a simulator WhatsApp number, contacts and templates. Handy for a test drive; leave off for production." />
              <div className="flex gap-2 rounded-md bg-subtle p-3 text-xs text-fg-muted">
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0" /> Session, token and encryption keys are generated for you and saved with the configuration.
              </div>
              {nav("database", "admin", Object.keys(appErrors).length === 0)}
            </Section>
          )}

          {step === "admin" && (
            <Section title="Administrator" description="The superadmin account that manages the whole platform. Keep these details safe.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="First name" htmlFor="ad-first"><Input id="ad-first" value={admin.firstName} onChange={(e) => setAdmin({ ...admin, firstName: e.target.value })} /></Field>
                <Field label="Last name" htmlFor="ad-last"><Input id="ad-last" value={admin.lastName} onChange={(e) => setAdmin({ ...admin, lastName: e.target.value })} /></Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Username" htmlFor="ad-user" error={fe(adminErrors, "username", admin.username)}><Input id="ad-user" autoComplete="off" value={admin.username} onChange={(e) => setAdmin({ ...admin, username: e.target.value })} /></Field>
                <Field label="Email" htmlFor="ad-email" error={fe(adminErrors, "email", admin.email)}><Input id="ad-email" type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} /></Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Password" htmlFor="ad-pass"><Input id="ad-pass" type="password" autoComplete="new-password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} /></Field>
                <Field label="Confirm password" htmlFor="ad-pass2" error={fe(adminErrors, "confirmPassword", admin.confirmPassword)}><Input id="ad-pass2" type="password" autoComplete="new-password" value={admin.confirmPassword} onChange={(e) => setAdmin({ ...admin, confirmPassword: e.target.value })} /></Field>
              </div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Password requirements">
                {PASSWORD_RULES.map(([rule, label]) => {
                  const ok = typeof rule === "function" ? rule(admin.password) : rule.test(admin.password);
                  return <li key={label} className={cn("flex items-center gap-1", ok ? "text-success" : "text-fg-muted")}>{ok ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3 w-3" />} {label}</li>;
                })}
              </ul>
              {nav("application", "email", Object.keys(adminErrors).length === 0)}
            </Section>
          )}

          {step === "email" && (
            <Section title="Email (optional)" description="The server that sends platform emails such as verification codes and notifications. Tenants can still use their own SMTP for campaigns.">
              <Switch checked={useSmtp} onChange={setUseSmtp} label="Set up email now" description={useSmtp ? "Saved to the configuration file." : "You can add it later in System settings → Notification."} />
              {useSmtp && (
                <>
                  <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
                    <Field label="SMTP host" htmlFor="sm-host" error={fe(smtpErrors, "host", smtp.host)}><Input id="sm-host" value={smtp.host} placeholder="smtp.example.com" onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} /></Field>
                    <Field label="Port" htmlFor="sm-port" error={smtpErrors.port}><Input id="sm-port" inputMode="numeric" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} /></Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Username" htmlFor="sm-user"><Input id="sm-user" autoComplete="off" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} /></Field>
                    <Field label="Password" htmlFor="sm-pass"><Input id="sm-pass" type="password" autoComplete="new-password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} /></Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="From address" htmlFor="sm-from" error={fe(smtpErrors, "fromEmail", smtp.fromEmail)}><Input id="sm-from" type="email" value={smtp.fromEmail} placeholder="no-reply@example.com" onChange={(e) => setSmtp({ ...smtp, fromEmail: e.target.value })} /></Field>
                    <Field label="From name" htmlFor="sm-name"><Input id="sm-name" value={smtp.fromName} placeholder={appCfg.siteName} onChange={(e) => setSmtp({ ...smtp, fromName: e.target.value })} /></Field>
                  </div>
                  <Checkbox checked={smtp.secure} onChange={(secure) => setSmtp({ ...smtp, secure })} label="Use SSL/TLS from the start (usually port 465)" />
                </>
              )}
              {nav("admin", "review", Object.keys(smtpErrors).length === 0)}
            </Section>
          )}

          {step === "review" && (
            <Section title="Ready to install" description="Check the details, then install. Nothing is changed until you press the button.">
              <dl className="divide-y divide-border rounded-md border border-border text-sm">
                {[
                  ["Database", `${db.user}@${db.host}:${db.port} / ${db.database}${tested && !tested.databaseExists ? " (will be created)" : ""}`],
                  ["Site name", appCfg.siteName],
                  ["Address", appCfg.appUrl],
                  ["Administrator", `${admin.username} · ${admin.email}`],
                  ["Email", useSmtp ? `${smtp.host}:${smtp.port} as ${smtp.fromEmail}` : "Set up later"],
                  ["Demo data", appCfg.demoData ? "Yes" : "No"],
                ].map(([k, v]) => (
                  <div key={k} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[9rem_1fr]">
                    <dt className="text-fg-muted">{k}</dt>
                    <dd className="break-all">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-8 flex items-center justify-between border-t border-border pt-5">
                <Button variant="ghost" onClick={() => setStep("email")}>Back</Button>
                <Button onClick={install}><Rocket className="h-4 w-4" /> Install WooMarket360</Button>
              </div>
            </Section>
          )}

          {(step === "installing" || step === "done") && (
            <Section title={step === "done" ? "Installed" : error ? "Installation stopped" : "Installing…"} description={step === "done" ? "Everything is in place." : error ? "Fix the problem below, then try again." : "This usually takes under a minute. Keep this page open."}>
              <ul className="space-y-2.5">
                {results.map((r) => (
                  <li key={r.key} className="flex items-start gap-2 text-sm">
                    {r.status === "done" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : r.status === "failed" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : busy ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-fg-muted" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />}
                    <span>
                      {r.label}
                      {r.error && <span className="block text-xs text-danger">{r.error}</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {step === "done" ? (
                <div className="mt-6 rounded-md bg-success-soft p-4 text-sm">
                  <p className="font-medium text-success">WooMarket360 is installed.</p>
                  <p className="mt-1 text-fg-muted">Sign in as <strong>{admin.username}</strong>. The configuration was saved to the server's <code>.env</code> file; keep a backup of it, since it holds your encryption key.</p>
                  <div className="mt-4">
                    {appUp ? (
                      <Button onClick={() => (window.location.href = "/login")}>Go to sign in</Button>
                    ) : (
                      <span className="flex items-center gap-2 text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Starting the application…</span>
                    )}
                  </div>
                </div>
              ) : error && !busy ? (
                <div className="mt-8 flex items-center justify-between border-t border-border pt-5">
                  <Button variant="ghost" onClick={() => { setError(null); setStep("review"); }}>Back</Button>
                  <Button onClick={install}>Try again</Button>
                </div>
              ) : null}
            </Section>
          )}
        </Card>
        <p className="mt-6 text-center text-xs text-fg-muted">Prefer configuring by hand? Set DATABASE_URL and the other values in .env (see .env.example) and restart — the installer is skipped.</p>
      </div>
    </div>
  );
}

const normalise = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
