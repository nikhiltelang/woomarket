import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Copy, Download, KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { useAuth } from "@/contexts/auth";
import { usePlatform } from "@/contexts/platform";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { Badge, Card, CardHeader, Spinner } from "@/components/ui/display";
import { Dialog, useToast } from "@/components/ui/overlay";

const KEY = ["/api/auth/2fa"];
interface Status {
  enabled: boolean;
  enabledAt: string | null;
  required: boolean;
  recoveryCodesLeft: number;
}

function CodeInput({ id, value, onChange, autoFocus }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <Input
      id={id}
      autoFocus={autoFocus}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      placeholder="123456"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      className="w-40 text-center font-mono text-lg tracking-[0.3em]"
    />
  );
}

/** Recovery codes, shown once, with copy and download. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const { config } = usePlatform();
  const [saved, setSaved] = useState(false);
  const text = `${config?.siteTitle ?? "WooMarket360"} recovery codes\nEach code can be used once to sign in if you lose your phone.\n\n${codes.join("\n")}\n`;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">Save these somewhere safe, like a password manager. Each one signs you in once if you lose access to your authenticator app. You won't see them again.</p>
      <ol className="grid grid-cols-2 gap-2 rounded-md border border-border bg-subtle p-4 font-mono text-sm">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(codes.join("\n")); toast({ title: "Copied", variant: "success" }); }}>
          <Copy className="h-3.5 w-3.5" /> Copy
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
            a.download = "recovery-codes.txt";
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          <Download className="h-3.5 w-3.5" /> Download
        </Button>
      </div>
      <Checkbox label="I've saved my recovery codes" checked={saved} onChange={setSaved} />
      <Button className="self-start" disabled={!saved} onClick={onDone}>Done</Button>
    </div>
  );
}

/** Scan, confirm, save recovery codes. */
export function TwoFactorSetup({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const setup = useMutation({ mutationFn: () => apiRequest<{ data: { secret: string; otpauthUrl: string } }>("POST", "/api/auth/2fa/setup") });
  const enable = useMutation({
    mutationFn: () => apiRequest<{ data: { recoveryCodes: string[] } }>("POST", "/api/auth/2fa/enable", { code }),
    onSuccess: (r) => setCodes(r.data.recoveryCodes),
    onError: (err) => {
      toast({ title: "Code didn't match", description: (err as Error).message, variant: "error" });
      setCode("");
    },
  });
  useEffect(() => {
    setup.mutate(undefined, {
      onSuccess: (r) => void QRCode.toDataURL(r.data.otpauthUrl, { margin: 1, width: 200 }).then(setQr),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (codes) {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: KEY });
          void queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
          onDone();
        }}
      />
    );
  }
  if (setup.error) return <p className="text-sm text-danger">{(setup.error as Error).message}</p>;
  const secret = setup.data?.data.secret;
  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-col gap-5 text-sm">
        <li>
          <p className="font-medium">1. Scan this QR code with an authenticator app</p>
          <p className="text-fg-muted">Google Authenticator, Microsoft Authenticator, 1Password, Authy and others work.</p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <div className="flex h-[200px] w-[200px] items-center justify-center rounded-md border border-border bg-white">{qr ? <img src={qr} alt="QR code for your authenticator app" width={200} height={200} /> : <Spinner />}</div>
            {secret && (
              <div className="min-w-0 text-xs text-fg-muted">
                <p>Can't scan? Enter this key:</p>
                <p className="mt-1 font-mono text-sm break-all text-fg">{secret.match(/.{1,4}/g)?.join(" ")}</p>
                <button type="button" className="mt-1 text-primary hover:underline" onClick={() => { void navigator.clipboard.writeText(secret); toast({ title: "Key copied", variant: "success" }); }}>Copy key</button>
              </div>
            )}
          </div>
        </li>
        <li>
          <Field label="2. Enter the 6-digit code it shows" htmlFor="tfa-setup-code">
            <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) enable.mutate(); }}>
              <CodeInput id="tfa-setup-code" value={code} onChange={setCode} />
              <Button type="submit" loading={enable.isPending} disabled={code.length !== 6 || !secret}>Turn on</Button>
            </form>
          </Field>
        </li>
      </ol>
    </div>
  );
}

/** Account page card. */
export function TwoFactorCard() {
  const toast = useToast();
  const { data, isLoading } = useQuery<{ data: Status }>({ queryKey: KEY });
  const [mode, setMode] = useState<null | "setup" | "disable" | "codes">(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const close = () => {
    setMode(null);
    setPassword("");
    setCode("");
    setNewCodes(null);
  };
  const disable = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/2fa/disable", { password, code }),
    onSuccess: () => {
      toast({ title: "Two-factor authentication is off", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      close();
    },
    onError: (err) => toast({ title: "Could not turn off", description: (err as Error).message, variant: "error" }),
  });
  const regenerate = useMutation({
    mutationFn: () => apiRequest<{ data: { recoveryCodes: string[] } }>("POST", "/api/auth/2fa/recovery-codes", { code }),
    onSuccess: (r) => setNewCodes(r.data.recoveryCodes),
    onError: (err) => toast({ title: "Could not create codes", description: (err as Error).message, variant: "error" }),
  });

  // Signed in with a recovery code: remind the user how many are left.
  useEffect(() => {
    try {
      const left = window.sessionStorage.getItem("wm360.recoveryLeft");
      if (left === null) return;
      window.sessionStorage.removeItem("wm360.recoveryLeft");
      toast({ title: `You signed in with a recovery code`, description: `${left} left. Create new ones if you're running low.`, variant: Number(left) <= 2 ? "warning" : "info" });
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = data?.data;
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Two-factor authentication</span>}
        description="A code from your phone is needed to sign in, as well as your password."
        actions={s && (s.enabled ? <Badge tone="success">On</Badge> : s.required ? <Badge tone="warning">Required</Badge> : <Badge>Off</Badge>)}
      />
      <div className="flex flex-col gap-3 p-5 text-sm">
        {isLoading || !s ? (
          <Spinner />
        ) : s.enabled ? (
          <>
            <p className="text-fg-muted">On since {formatDate(s.enabledAt)} · {s.recoveryCodesLeft} recovery code{s.recoveryCodesLeft === 1 ? "" : "s"} left</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setMode("codes")}><KeyRound className="h-3.5 w-3.5" /> New recovery codes</Button>
              {!s.required && <Button size="sm" variant="outline" className="text-danger" onClick={() => setMode("disable")}>Turn off</Button>}
            </div>
            {s.required && <p className="text-xs text-fg-muted">Your platform requires it for your role, so it can't be turned off.</p>}
          </>
        ) : (
          <>
            <p className="text-fg-muted">{s.required ? "Your platform requires two-factor authentication for your role." : "Protects your account even if your password leaks."}</p>
            <Button size="sm" className="self-start" onClick={() => setMode("setup")}>Turn on</Button>
          </>
        )}
      </div>

      <Dialog open={mode === "setup"} onClose={close} title="Turn on two-factor authentication">
        {mode === "setup" && <TwoFactorSetup onDone={close} />}
      </Dialog>

      <Dialog
        open={mode === "disable"}
        onClose={close}
        size="sm"
        title="Turn off two-factor authentication?"
        footer={<Button variant="danger" loading={disable.isPending} disabled={!password || code.length < 6} onClick={() => disable.mutate()}>Turn off</Button>}
      >
        <div className="flex flex-col gap-4">
          <Field label="Password" htmlFor="tfa-off-pw"><Input id="tfa-off-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Authentication or recovery code" htmlFor="tfa-off-code"><Input id="tfa-off-code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} className="font-mono" /></Field>
        </div>
      </Dialog>

      <Dialog open={mode === "codes"} onClose={close} title="New recovery codes" description={newCodes ? undefined : "Your old codes stop working."}>
        {newCodes ? (
          <RecoveryCodes codes={newCodes} onDone={() => { void queryClient.invalidateQueries({ queryKey: KEY }); close(); }} />
        ) : (
          <Field label="Enter a code from your authenticator app" htmlFor="tfa-regen">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) regenerate.mutate(); }}>
              <CodeInput id="tfa-regen" value={code} onChange={setCode} autoFocus />
              <Button type="submit" loading={regenerate.isPending} disabled={code.length !== 6}>Create codes</Button>
            </form>
          </Field>
        )}
      </Dialog>
    </Card>
  );
}

/** Full-page setup for users the policy requires to use 2FA. */
export function TwoFactorGate() {
  const { logout } = useAuth();
  const { config } = usePlatform();
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Card className="w-full max-w-xl">
        <CardHeader
          title={<span className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /> Set up two-factor authentication</span>}
          description={`${config?.siteTitle ?? "This platform"} requires it for your account. It takes about a minute.`}
          actions={<Button size="sm" variant="ghost" onClick={() => void logout()}><LogOut className="h-3.5 w-3.5" /> Sign out</Button>}
        />
        <div className="p-5">
          <TwoFactorSetup onDone={() => window.location.reload()} />
        </div>
      </Card>
    </div>
  );
}
