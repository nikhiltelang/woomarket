import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth";
import { apiRequest } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui/display";
import { useToast } from "@/components/ui/overlay";

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
      </div>
    </PageContainer>
  );
}
