import { useState } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { signupSchema } from "@shared/validation";
import { passwordProblems } from "@shared/platform";
import { useAuth } from "@/contexts/auth";
import { usePlatform } from "@/contexts/platform";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/display";
import { AuthShell, SsoButtons, VerifyEmailStep } from "./login";

type SignupForm = z.input<typeof signupSchema>;

export default function SignupPage() {
  const { user, signup } = useAuth();
  const { config, t } = usePlatform();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [verifyFor, setVerifyFor] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const form = useForm<SignupForm>({ resolver: zodResolver(signupSchema) });
  const errors = form.formState.errors;

  if (user) return <Redirect to="/dashboard" />;
  if (verifyFor) {
    return (
      <AuthShell title={t("auth.verifyTitle")}>
        <VerifyEmailStep email={verifyFor} onDone={(r) => navigate(r)} />
      </AuthShell>
    );
  }
  if (config && !config.userRegistration) {
    return (
      <AuthShell title={t("auth.signupTitle")}>
        <EmptyState title="Registration is closed" description="New accounts can't be created right now. Contact the platform owner for access." action={<Link href="/login" className="text-sm font-medium text-primary hover:underline">{t("auth.signIn")}</Link>} />
      </AuthShell>
    );
  }
  const strong = config?.forceSecurePassword ?? true;
  const termsPage = config?.policies.find((p) => p.slug === "terms") ?? config?.policies[0];
  const privacy = config?.policies.find((p) => p.slug === "privacy-policy");

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    if (strong) {
      const problem = passwordProblems(values.password);
      if (problem) return form.setError("password", { message: problem });
    }
    if (config?.agreePolicy && !terms) return setError("Please accept the terms to continue");
    try {
      const res = await signup({ ...values, acceptTerms: terms });
      if ("verificationRequired" in res) setVerifyFor(res.email);
      else navigate(res.redirect);
    } catch (err) {
      if (err instanceof ApiError && err.code === "USERNAME_TAKEN") form.setError("username", { message: err.message });
      else if (err instanceof ApiError && err.code === "EMAIL_TAKEN") form.setError("email", { message: err.message });
      else if (err instanceof ApiError && (err.details as Record<string, string[]>)?.password) form.setError("password", { message: (err.details as Record<string, string[]>).password[0] });
      else setError((err as Error).message);
    }
  });

  return (
    <AuthShell title={t("auth.signupTitle")} subtitle="Start on the Free plan — upgrade any time">
      <SsoButtons />
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && (
          <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" htmlFor="firstName">
            <Input id="firstName" autoComplete="given-name" {...form.register("firstName")} />
          </Field>
          <Field label="Last name" htmlFor="lastName">
            <Input id="lastName" autoComplete="family-name" {...form.register("lastName")} />
          </Field>
        </div>
        <Field label="Username" htmlFor="su-username" error={errors.username?.message}>
          <Input id="su-username" autoComplete="username" {...form.register("username")} invalid={!!errors.username} />
        </Field>
        <Field label="Work email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} invalid={!!errors.email} />
        </Field>
        <Field
          label={t("auth.password")}
          htmlFor="su-password"
          error={errors.password?.message}
          hint={strong ? "8+ characters with upper- and lowercase letters and a number" : "At least 6 characters"}
        >
          <Input id="su-password" type="password" autoComplete="new-password" {...form.register("password")} invalid={!!errors.password} />
        </Field>
        {config?.agreePolicy && termsPage && (
          <Checkbox
            checked={terms}
            onChange={setTerms}
            label={
              <span>
                {t("auth.agreeTerms")}{" "}
                <a href={`/policy/${termsPage.slug}`} target="_blank" rel="noopener" className="text-primary underline">
                  {termsPage.title}
                </a>
                {privacy && privacy !== termsPage && (
                  <>
                    {" "}
                    and{" "}
                    <a href={`/policy/${privacy.slug}`} target="_blank" rel="noopener" className="text-primary underline">
                      {privacy.title}
                    </a>
                  </>
                )}
              </span>
            }
          />
        )}
        <Button type="submit" loading={form.formState.isSubmitting} className="w-full justify-center">
          {t("auth.createAccount")}
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-fg-muted">
        {t("auth.haveAccount")}{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          {t("auth.signIn")}
        </Link>
      </p>
    </AuthShell>
  );
}
