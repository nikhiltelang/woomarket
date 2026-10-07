import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { usePlatform } from "@/contexts/platform";
import { TwoFactorCard } from "@/components/two-factor";
import { SSO_META, ssoErrorMessage, type SsoProvider } from "./login";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui/display";
import { useConfirm, useToast } from "@/components/ui/overlay";

export default function AccountPage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [profile, setProfile] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "" });

  useEffect(() => {
    if (user) setProfile({ firstName: user.firstName ?? "", lastName: user.lastName ?? "", email: user.email, phone: user.phone ?? "" });
  }, [user]);

  const saveProfile = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/auth/profile", { ...profile, phone: profile.phone || null }),
    onSuccess: () => {
      toast({ title: "Profile saved", variant: "success" });
      refresh();
    },
    onError: (err) => toast({ title: "Could not save profile", description: (err as Error).message, variant: "error" }),
  });
  const changePassword = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/change-password", { currentPassword: pw.currentPassword, newPassword: pw.newPassword }),
    onSuccess: () => {
      toast({ title: "Password changed", variant: "success" });
      setPw({ currentPassword: "", newPassword: "", confirm: "" });
    },
    onError: (err) => toast({ title: "Could not change password", description: (err as Error).message, variant: "error" }),
  });

  if (!user) return null;
  const mismatch = pw.confirm.length > 0 && pw.confirm !== pw.newPassword;

  return (
    <PageContainer>
      <PageHeader title="Your account" description={`Signed in as @${user.username} · member since ${formatDate(user.createdAt)}`} actions={<Badge tone="primary">{user.role}</Badge>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" />
          <form
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              saveProfile.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" htmlFor="a-first">
                <Input id="a-first" value={profile.firstName} onChange={(e) => setProfile((p) => ({ ...p, firstName: e.target.value }))} />
              </Field>
              <Field label="Last name" htmlFor="a-last">
                <Input id="a-last" value={profile.lastName} onChange={(e) => setProfile((p) => ({ ...p, lastName: e.target.value }))} />
              </Field>
            </div>
            <Field label="Email" htmlFor="a-email">
              <Input id="a-email" type="email" value={profile.email} onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))} />
            </Field>
            <Field label="Phone" htmlFor="a-phone">
              <Input id="a-phone" value={profile.phone} onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value }))} />
            </Field>
            <Button type="submit" className="self-start" loading={saveProfile.isPending}>
              Save profile
            </Button>
          </form>
        </Card>
        <Card>
          <CardHeader title="Change password" />
          <form
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              changePassword.mutate();
            }}
          >
            <Field label="Current password" htmlFor="a-cur">
              <Input id="a-cur" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw((p) => ({ ...p, currentPassword: e.target.value }))} />
            </Field>
            <Field label="New password" htmlFor="a-new" hint="8+ characters with upper- and lowercase letters and a number">
              <Input id="a-new" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw((p) => ({ ...p, newPassword: e.target.value }))} />
            </Field>
            <Field label="Confirm new password" htmlFor="a-conf" error={mismatch ? "Passwords don't match" : undefined}>
              <Input id="a-conf" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} invalid={mismatch} />
            </Field>
            <Button type="submit" className="self-start" loading={changePassword.isPending} disabled={!pw.currentPassword || !pw.newPassword || mismatch}>
              Change password
            </Button>
          </form>
        </Card>
        <TwoFactorCard />
        <ConnectedAccounts />
      </div>
    </PageContainer>
  );
}

interface Identity {
  provider: SsoProvider;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** Google / Microsoft accounts the user can sign in with. */
function ConnectedAccounts() {
  const { config } = usePlatform();
  const toast = useToast();
  const confirm = useConfirm();
  const search = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const { data } = useQuery<{ data: Identity[] }>({ queryKey: ["/api/auth/identities"] });

  // Result of a "Connect" round trip (shown once, even when effects run twice in development).
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    const linked = search.get("sso_linked") as SsoProvider | null;
    const error = ssoErrorMessage(search.get("sso_error"));
    if (linked && SSO_META[linked]) toast({ title: `${SSO_META[linked].label} connected`, description: "You can now sign in with it.", variant: "success" });
    if (error) toast({ title: "Could not connect", description: error, variant: "error" });
    if (linked || error) navigate("/account", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unlink = useMutation({
    mutationFn: (p: SsoProvider) => apiRequest("DELETE", `/api/auth/identities/${p}`),
    onSuccess: () => {
      toast({ title: "Disconnected", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/auth/identities"] });
    },
    onError: (err) => toast({ title: "Could not disconnect", description: (err as Error).message, variant: "error" }),
  });

  const providers = (["google", "microsoft"] as const).filter((p) => (p === "google" ? config?.googleLogin : config?.microsoftLogin) || data?.data.some((i) => i.provider === p));
  if (!providers.length) return null;
  return (
    <Card>
      <CardHeader title="Connected sign-in" description="Sign in with these accounts instead of your password." />
      <ul className="divide-y divide-border">
        {providers.map((p) => {
          const identity = data?.data.find((i) => i.provider === p);
          const available = p === "google" ? config?.googleLogin : config?.microsoftLogin;
          return (
            <li key={p} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-md border border-border">{SSO_META[p].icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{SSO_META[p].label}</p>
                <p className="truncate text-xs text-fg-muted">
                  {identity ? `${identity.email ?? "Connected"} · ${identity.lastLoginAt ? `last used ${formatDate(identity.lastLoginAt)}` : `connected ${formatDate(identity.createdAt)}`}` : "Not connected"}
                </p>
              </div>
              {identity ? (
                <Button
                  size="sm"
                  variant="outline"
                  loading={unlink.isPending && unlink.variables === p}
                  onClick={async () => {
                    if (await confirm({ title: `Disconnect ${SSO_META[p].label}?`, description: "You'll need your password (or another connected account) to sign in. If you never set a password, use “Forgot password” first.", confirmText: "Disconnect", destructive: true })) unlink.mutate(p);
                  }}
                >
                  Disconnect
                </Button>
              ) : available ? (
                <a href={`/api/auth/${p}?link=1`} className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-subtle">
                  Connect
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
