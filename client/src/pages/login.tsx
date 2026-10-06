import { useState } from "react";
import { Link, Redirect, useLocation, useSearch } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput } from "@shared/validation";
import { useAuth } from "@/contexts/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { PageLoader } from "@/components/ui/display";

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img src="/favicon.svg" alt="" className="h-11 w-11" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">{children}</div>
      </div>
    </div>
  );
}

function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : null;
}

export default function LoginPage() {
  const { user, isLoading, login } = useAuth();
  const [, navigate] = useLocation();
  const next = safeNext(new URLSearchParams(useSearch()).get("next"));
  const [error, setError] = useState<string | null>(null);
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { username: "", password: "" } });

  if (isLoading) return <PageLoader />;
  if (user) return <Redirect to={next ?? (user.role === "superadmin" ? "/admin" : "/dashboard")} />;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await login(values.username, values.password);
      navigate(next ?? res.redirect);
    } catch (err) {
      setError((err as Error).message);
    }
  });

  return (
    <AuthShell title="Sign in to WooMarket360" subtitle="WhatsApp marketing, CRM and team inbox">
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && (
          <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
        <Field label="Username or email" htmlFor="username" error={form.formState.errors.username?.message}>
          <Input id="username" autoComplete="username" autoFocus {...form.register("username")} invalid={!!form.formState.errors.username} />
        </Field>
        <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} invalid={!!form.formState.errors.password} />
        </Field>
        <Button type="submit" loading={form.formState.isSubmitting} className="w-full justify-center">
          Sign in
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-fg-muted">
        New to WooMarket360?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
