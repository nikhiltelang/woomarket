import { useState } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { signupSchema } from "@shared/validation";
import { useAuth } from "@/contexts/auth";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { AuthShell } from "./login";

type SignupForm = z.input<typeof signupSchema>;

export default function SignupPage() {
  const { user, signup } = useAuth();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<SignupForm>({ resolver: zodResolver(signupSchema) });
  const errors = form.formState.errors;

  if (user) return <Redirect to="/dashboard" />;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await signup(values);
      navigate(res.redirect);
    } catch (err) {
      if (err instanceof ApiError && err.code === "USERNAME_TAKEN") form.setError("username", { message: err.message });
      else if (err instanceof ApiError && err.code === "EMAIL_TAKEN") form.setError("email", { message: err.message });
      else setError((err as Error).message);
    }
  });

  return (
    <AuthShell title="Create your account" subtitle="Start on the Free plan — upgrade any time">
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
        <Field label="Password" htmlFor="su-password" error={errors.password?.message} hint="8+ characters with upper- and lowercase letters and a number">
          <Input id="su-password" type="password" autoComplete="new-password" {...form.register("password")} invalid={!!errors.password} />
        </Field>
        <Button type="submit" loading={form.formState.isSubmitting} className="w-full justify-center">
          Create account
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-fg-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
