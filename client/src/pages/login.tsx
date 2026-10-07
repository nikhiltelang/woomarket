import { useState, type ReactNode } from "react";
import { Link, Redirect, useLocation, useSearch } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check } from "lucide-react";
import { loginSchema, type LoginInput } from "@shared/validation";
import { useAuth } from "@/contexts/auth";
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
        <div className="flex items-center gap-3">
          <img src={config?.logo || "/favicon.svg"} alt="" className="h-9 w-9 rounded bg-white/10 object-contain p-0.5" />
          <span className="text-lg font-semibold">{config?.siteTitle ?? "WooMarket360"}</span>
        </div>
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

export function GoogleButton({ next }: { next?: string | null }) {
  const { config, t } = usePlatform();
  if (!config?.googleLogin) return null;
  return (
    <>
      <a
        href={`/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ""}`}
        className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface text-sm font-medium hover:bg-subtle"
      >
        <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
          <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
          <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
          <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
        </svg>
        {t("auth.continueWithGoogle")}
      </a>
      <div className="my-4 flex items-center gap-3 text-xs text-fg-muted">
        <span className="h-px flex-1 bg-border" />
        {t("auth.or")}
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
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
          onDone(r.redirect);
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

const OAUTH_ERRORS: Record<string, string> = {
  google_disabled: "Google sign-in isn't enabled.",
  google_state: "The Google sign-in session expired. Please try again.",
  google_cancelled: "Google sign-in was cancelled.",
  google_failed: "Google sign-in failed. Please try again.",
  google_unverified: "Your Google account's email address isn't verified.",
  banned: "This account has been suspended.",
  inactive: "Your account is inactive. Contact your administrator.",
  registration_closed: "New registrations are currently closed.",
};

export default function LoginPage() {
  const { user, isLoading, login } = useAuth();
  const { config, t } = usePlatform();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const next = safeNext(params.get("next"));
  const [error, setError] = useState<string | null>(OAUTH_ERRORS[params.get("error") ?? ""] ?? null);
  const [verifyFor, setVerifyFor] = useState<string | null>(null);
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { username: "", password: "" } });

  if (isLoading) return <PageLoader />;
  if (user) return <Redirect to={next ?? (user.role === "superadmin" ? "/admin" : "/dashboard")} />;
  const site = config?.siteTitle ?? "WooMarket360";

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
      navigate(next ?? res.redirect);
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
      <GoogleButton next={next} />
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
