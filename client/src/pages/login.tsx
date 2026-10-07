import { useState, type ReactNode } from "react";
import { Link, Redirect, useLocation, useSearch } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check } from "lucide-react";
import { loginSchema, type LoginInput } from "@shared/validation";
import { needsTwoFactor, useAuth } from "@/contexts/auth";
import { usePlatform } from "@/contexts/platform";
import { ApiError, apiRequest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { PageLoader } from "@/components/ui/display";
import { LanguageSwitcher, PolicyLinks } from "@/components/public";

/** Two-column auth layout: brand panel (System settings → Manage Frontend) and the form. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const { config } = usePlatform();
  const f = config?.frontend ?? {};
  return (
    <div className="flex min-h-full">
      <aside className="hidden w-[44%] max-w-xl flex-col justify-between bg-primary p-10 text-primary-fg lg:flex">
        <a href="/" className="flex items-center gap-3">
          <img src={config?.logo || "/favicon.svg"} alt="" className="h-9 w-9 rounded bg-white/10 object-contain p-0.5" />
          <span className="text-lg font-semibold">{config?.siteTitle ?? "WooMarket360"}</span>
        </a>
        <div>
          <h2 className="text-3xl leading-tight font-semibold">{f.heroTitle || "Reach every customer on WhatsApp, email and SMS"}</h2>
          <p className="mt-3 text-base opacity-85">{f.heroSubtitle || config?.tagline || "Campaigns, templates and delivery tracking for every channel, plus a shared WhatsApp inbox for your team."}</p>
          {!!f.features?.length && (
            <ul className="mt-8 space-y-3">
              {f.features.map((x) => (
                <li key={x} className="flex items-start gap-2 text-sm">
                  <Check className="mt-0.5 h-4 w-4 shrink-0" /> {x}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs opacity-70">{f.footerText || `© ${new Date().getFullYear()} ${config?.companyName ?? config?.siteTitle ?? ""}`}</p>
      </aside>
      <div className="flex flex-1 flex-col">
        <div className="flex justify-end p-4">
          <LanguageSwitcher />
        </div>
        <div className="flex flex-1 items-center justify-center px-4 pb-12">
          <div className="w-full max-w-sm">
            <div className="mb-8 flex flex-col items-center gap-3 text-center">
              <img src={config?.logo || "/favicon.svg"} alt="" className="h-11 w-11 rounded object-contain lg:hidden" />
              <div>
                <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
                {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">{children}</div>
            <div className="mt-6">
              <PolicyLinks />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const GOOGLE_ICON = (
  <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

const MICROSOFT_ICON = (
  <svg viewBox="0 0 21 21" className="h-4 w-4" aria-hidden>
    <path fill="#f25022" d="M1 1h9v9H1z" />
    <path fill="#7fba00" d="M11 1h9v9h-9z" />
    <path fill="#00a4ef" d="M1 11h9v9H1z" />
    <path fill="#ffb900" d="M11 11h9v9h-9z" />
  </svg>
);

export const SSO_META = {
  google: { label: "Google", icon: GOOGLE_ICON },
  microsoft: { label: "Microsoft", icon: MICROSOFT_ICON },
} as const;
export type SsoProvider = keyof typeof SSO_META;

/** "Continue with Google / Microsoft" for every provider the superadmin enabled. */
export function SsoButtons({ next }: { next?: string | null }) {
  const { config, t } = usePlatform();
  const enabled = (["google", "microsoft"] as const).filter((p) => (p === "google" ? config?.googleLogin : config?.microsoftLogin));
  if (!enabled.length) return null;
  return (
    <>
      <div className="flex flex-col gap-2">
        {enabled.map((p) => (
          <a
            key={p}
            href={`/api/auth/${p}${next ? `?next=${encodeURIComponent(next)}` : ""}`}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface text-sm font-medium hover:bg-subtle"
          >
            {SSO_META[p].icon}
            {t(p === "google" ? "auth.continueWithGoogle" : "auth.continueWithMicrosoft")}
          </a>
        ))}
      </div>
      <div className="my-4 flex items-center gap-3 text-xs text-fg-muted">
        <span className="h-px flex-1 bg-border" />
        {t("auth.or")}
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

/** Message for an SSO error code such as "microsoft_unverified". */
export function ssoErrorMessage(code: string | null): string | null {
  if (!code) return null;
  const general: Record<string, string> = {
    banned: "This account has been suspended.",
    inactive: "Your account is inactive. Contact your administrator.",
    registration_closed: "New registrations are currently closed.",
  };
  const m = /^(google|microsoft)_(.+)$/.exec(code);
  if (!m) return null;
  const name = SSO_META[m[1] as SsoProvider].label;
  const reason = m[2];
  if (general[reason]) return general[reason];
  const messages: Record<string, string> = {
    disabled: `${name} sign-in isn't enabled.`,
    state: `The ${name} sign-in session expired. Please try again.`,
    cancelled: `${name} sign-in was cancelled.`,
    failed: `${name} sign-in failed. Please try again.`,
    no_email: `Your ${name} account didn't share an email address.`,
    unverified:
      m[1] === "microsoft"
        ? "Microsoft couldn't confirm that this work or school account owns its email address. Sign in with your password, or ask your administrator to allow your organisation's directory."
        : "Your Google account's email address isn't verified.",
    tenant: "Accounts from this Microsoft organisation can't sign in here.",
    linked_elsewhere: `That ${name} account is already connected to a different user.`,
  };
  return messages[reason] ?? messages.failed;
}

/** Second sign-in step: an authenticator code or a recovery code. */
function TwoFactorStep({ onDone, onCancel }: { onDone: (redirect: string) => void; onCancel: () => void }) {
  const { verifyTwoFactor } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = useRecovery ? code.trim().length >= 10 : /^\d{6}$/.test(code);
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        setError(null);
        try {
          const r = await verifyTwoFactor(code.trim());
          if (r.recoveryCodesLeft !== undefined) window.sessionStorage.setItem("wm360.recoveryLeft", String(r.recoveryCodesLeft));
          onDone(r.redirect);
        } catch (err) {
          setError((err as Error).message);
          // Expired or locked: the password step has to be done again.
          if (err instanceof ApiError && (err.code === "TWO_FACTOR_EXPIRED" || err.code === "TWO_FACTOR_LOCKED")) setTimeout(onCancel, 2500);
          setCode("");
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && (
        <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      {useRecovery ? (
        <Field label="Recovery code" htmlFor="tfa-recovery" hint="One of the codes you saved when you turned on two-factor authentication. Each works once.">
          <Input id="tfa-recovery" autoFocus autoComplete="off" spellCheck={false} placeholder="xxxxx-xxxxx" value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" />
        </Field>
      ) : (
        <Field label="Authentication code" htmlFor="tfa-code">
          <Input
            id="tfa-code"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="text-center font-mono text-lg tracking-[0.4em]"
          />
        </Field>
      )}
      <Button type="submit" loading={busy} disabled={!valid} className="w-full justify-center">
        Verify
      </Button>
      <div className="flex justify-between text-sm">
        <button type="button" className="text-primary hover:underline" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }}>
          {useRecovery ? "Use your authenticator app" : "Use a recovery code"}
        </button>
        <button type="button" className="text-fg-muted hover:text-fg" onClick={onCancel}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}

/** 6-digit email verification step, shared by sign-in and sign-up. */
export function VerifyEmailStep({ email, onDone }: { email: string; onDone: (redirect: string) => void }) {
  const { verifyEmail } = useAuth();
  const { t } = usePlatform();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await verifyEmail(email, code);
          if (needsTwoFactor(r)) window.location.assign("/login?step=2fa");
          else onDone(r.redirect);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-fg-muted">{t("auth.verifyHelp", { email })}</p>
      {error && <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
      {info && <div role="status" className="rounded-md bg-info-soft px-3 py-2 text-sm text-info">{info}</div>}
      <Field label="Verification code" htmlFor="otp">
        <Input
          id="otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          className="text-center text-lg tracking-[0.5em]"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
      </Field>
      <Button type="submit" loading={busy} disabled={code.length !== 6} className="w-full justify-center">
        {t("auth.verify")}
      </Button>
      <button
        type="button"
        className="text-sm text-primary hover:underline"
        onClick={async () => {
          const r = await apiRequest<{ message: string }>("POST", "/api/users/resend-verification", { email }).catch((err) => ({ message: (err as Error).message }));
          setInfo(r.message);
        }}
      >
        {t("auth.resend")}
      </button>
    </form>
  );
}

function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : null;
}

export default function LoginPage() {
  const { user, isLoading, login } = useAuth();
  const { config, t } = usePlatform();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const next = safeNext(params.get("next"));
  const [error, setError] = useState<string | null>(ssoErrorMessage(params.get("error")));
  const [verifyFor, setVerifyFor] = useState<string | null>(null);
  // "?step=2fa" arrives from Google/Microsoft sign-in when the account uses two-factor authentication.
  const [twoFactor, setTwoFactor] = useState(params.get("step") === "2fa");
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { username: "", password: "" } });

  if (isLoading) return <PageLoader />;
  if (user) return <Redirect to={next ?? (user.role === "superadmin" ? "/admin" : "/dashboard")} />;
  const site = config?.siteTitle ?? "WooMarket360";

  if (twoFactor) {
    return (
      <AuthShell title="Two-factor authentication" subtitle="Enter the 6-digit code from your authenticator app.">
        <TwoFactorStep onDone={(r) => navigate(next ?? r)} onCancel={() => setTwoFactor(false)} />
      </AuthShell>
    );
  }

  if (verifyFor) {
    return (
      <AuthShell title={t("auth.verifyTitle")}>
        <VerifyEmailStep email={verifyFor} onDone={(r) => navigate(next ?? r)} />
      </AuthShell>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await login(values.username, values.password);
      if (needsTwoFactor(res)) setTwoFactor(true);
      else navigate(next ?? res.redirect);
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_NOT_VERIFIED") {
        setVerifyFor((err.details as { email: string }).email);
        return;
      }
      setError((err as Error).message);
    }
  });

  return (
    <AuthShell title={t("auth.signInTitle", { site })} subtitle={config?.tagline ?? undefined}>
      {config?.maintenance.enabled && (
        <div role="status" className="mb-4 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {config.maintenance.title}: only administrators can sign in right now.
        </div>
      )}
      <SsoButtons next={next} />
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && (
          <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
        <Field label={t("auth.username")} htmlFor="username" error={form.formState.errors.username?.message}>
          <Input id="username" autoComplete="username" autoFocus {...form.register("username")} invalid={!!form.formState.errors.username} />
        </Field>
        <Field label={t("auth.password")} htmlFor="password" error={form.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} invalid={!!form.formState.errors.password} />
        </Field>
        <Button type="submit" loading={form.formState.isSubmitting} className="w-full justify-center">
          {t("auth.signIn")}
        </Button>
      </form>
      {config?.userRegistration !== false && (
        <p className="mt-5 text-center text-sm text-fg-muted">
          {t("auth.noAccount")}{" "}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            {t("auth.createAccount")}
          </Link>
        </p>
      )}
    </AuthShell>
  );
}
