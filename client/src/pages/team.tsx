import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { KeyRound, Plus, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { createTeamMemberSchema } from "@shared/validation";
import { ADMIN_ONLY_PERMISSIONS, DEFAULT_TEAM_PERMISSIONS, PERMISSION_GROUPS } from "@shared/roles";
import type { Paginated, PublicUser } from "@shared/api-types";
import type { ActivityLog } from "@shared/schema";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { displayName, formatDate, relativeTime } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { Avatar, Card, EmptyState, PageHeader, PageLoader, StatusBadge } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, Tabs, useConfirm, useToast } from "@/components/ui/overlay";

type MemberForm = z.input<typeof createTeamMemberSchema>;

function PermissionEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {PERMISSION_GROUPS.map((g) => (
        <fieldset key={g.label}>
          <legend className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">{g.label}</legend>
          <div className="flex flex-col gap-1.5">
            {g.permissions.map((p) => {
              const adminOnly = ADMIN_ONLY_PERMISSIONS.includes(p);
              return (
                <Checkbox
                  key={p}
                  label={
                    <span className={adminOnly ? "text-fg-muted" : undefined}>
                      {p.split(":")[1]}
                      {adminOnly && " (admin only)"}
                    </span>
                  }
                  disabled={adminOnly}
                  checked={value.includes(p)}
                  onChange={(on) => onChange(on ? [...value, p] : value.filter((x) => x !== p))}
                />
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const form = useForm<MemberForm>({ resolver: zodResolver(createTeamMemberSchema) });
  const [perms, setPerms] = useState<string[]>(DEFAULT_TEAM_PERMISSIONS);
  useEffect(() => {
    if (open) {
      form.reset({ username: "", email: "", password: "", firstName: "", lastName: "" });
      setPerms(DEFAULT_TEAM_PERMISSIONS);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useMutation({
    mutationFn: (v: MemberForm) => apiRequest("POST", "/api/team/members", { ...v, permissions: perms }),
    onSuccess: () => {
      toast({ title: "Team member added", description: "Share the username and password with them securely.", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/team/members"] });
      onClose();
    },
    onError: (err) => toast({ title: "Could not add member", description: (err as Error).message, variant: "error" }),
  });
  const e = form.formState.errors;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Add team member"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={form.handleSubmit((v) => create.mutate(v))} loading={create.isPending}>
            Add member
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="m-first">
            <Input id="m-first" {...form.register("firstName")} />
          </Field>
          <Field label="Last name" htmlFor="m-last">
            <Input id="m-last" {...form.register("lastName")} />
          </Field>
          <Field label="Username" htmlFor="m-user" error={e.username?.message}>
            <Input id="m-user" autoComplete="off" {...form.register("username")} invalid={!!e.username} />
          </Field>
          <Field label="Email" htmlFor="m-email" error={e.email?.message}>
            <Input id="m-email" type="email" {...form.register("email")} invalid={!!e.email} />
          </Field>
          <Field label="Initial password" htmlFor="m-pass" error={e.password?.message} className="sm:col-span-2">
            <Input id="m-pass" type="password" autoComplete="new-password" {...form.register("password")} invalid={!!e.password} />
          </Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Permissions</p>
          <PermissionEditor value={perms} onChange={setPerms} />
        </div>
      </div>
    </Dialog>
  );
}

function MemberDialog({ member, onClose }: { member: PublicUser | null; onClose: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [perms, setPerms] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  useEffect(() => {
    setPerms(member?.permissions ?? []);
    setPassword("");
  }, [member]);

  const savePerms = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/team/members/${member!.id}/permissions`, { permissions: perms }),
    onSuccess: () => {
      toast({ title: "Permissions updated", description: "They apply on the member's next request.", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/team/members"] });
      onClose();
    },
    onError: (err) => toast({ title: "Update failed", description: (err as Error).message, variant: "error" }),
  });
  const resetPassword = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/team/members/${member!.id}/password`, { password }),
    onSuccess: () => {
      toast({ title: "Password reset", variant: "success" });
      setPassword("");
    },
    onError: (err) => toast({ title: "Reset failed", description: (err as Error).message, variant: "error" }),
  });

  const isAdmin = user?.role === "admin";
  return (
    <Dialog
      open={Boolean(member)}
      onClose={onClose}
      size="lg"
      title={member ? displayName(member) : ""}
      description={member ? `@${member.username} · ${member.email}` : undefined}
      footer={
        isAdmin && (
          <Button onClick={() => savePerms.mutate()} loading={savePerms.isPending}>
            <ShieldCheck className="h-4 w-4" /> Save permissions
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-6">
        <PermissionEditor value={perms} onChange={isAdmin ? setPerms : () => {}} />
        {isAdmin && (
          <div className="border-t border-border pt-4">
            <p className="mb-2 text-sm font-medium">Reset password</p>
            <div className="flex gap-2">
              <Input type="password" autoComplete="new-password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="New password" />
              <Button variant="outline" onClick={() => resetPassword.mutate()} loading={resetPassword.isPending} disabled={password.length < 8}>
                <KeyRound className="h-4 w-4" /> Reset
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ActivityTab() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery<Paginated<ActivityLog & { username: string | null }>>({
    queryKey: ["/api/team/activity-logs", { page, limit: 25 }],
    placeholderData: (p) => p,
  });
  if (isLoading) return <PageLoader />;
  if (!data?.data.length) return <EmptyState title="No activity yet" />;
  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Who</Th>
            <Th>Action</Th>
            <Th className="hidden md:table-cell">IP address</Th>
          </tr>
        </thead>
        <tbody>
          {data.data.map((l) => (
            <Tr key={l.id}>
              <Td className="whitespace-nowrap text-fg-muted" title={formatDate(l.createdAt)}>
                {relativeTime(l.createdAt)}
              </Td>
              <Td>{l.username ?? "deleted user"}</Td>
              <Td>
                <span className="font-medium">{l.action.replace(/_/g, " ")}</span>
                {l.entityType && <span className="ml-1 text-xs text-fg-muted">({l.entityType})</span>}
              </Td>
              <Td className="hidden font-mono text-xs text-fg-muted md:table-cell">{l.ipAddress}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <Pagination page={page} limit={25} total={data.total} onPage={setPage} />
    </>
  );
}

export default function TeamPage() {
  const { user, can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<"members" | "activity">("members");
  const [inviting, setInviting] = useState(false);
  const [viewing, setViewing] = useState<PublicUser | null>(null);
  const { data, isLoading } = useQuery<Paginated<PublicUser>>({ queryKey: ["/api/team/members", { limit: 200 }] });

  const setStatus = useMutation({
    mutationFn: (m: PublicUser) => apiRequest("PATCH", `/api/team/members/${m.id}/status`, { status: m.status === "active" ? "inactive" : "active" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/team/members"] }),
    onError: (err) => toast({ title: "Update failed", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/team/members/${id}`),
    onSuccess: () => {
      toast({ title: "Team member removed", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/team/members"] });
    },
  });

  const isAdmin = user?.role === "admin";
  return (
    <PageContainer>
      <PageHeader
        title="Team"
        description="Invite agents and control exactly what each one can do."
        actions={
          isAdmin &&
          can("team:create") && (
            <Button onClick={() => setInviting(true)}>
              <Plus className="h-4 w-4" /> Add member
            </Button>
          )
        }
      />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "members", label: "Members" },
            { value: "activity", label: "Activity log" },
          ]}
        />
      </div>
      <Card>
        {tab === "activity" ? (
          <ActivityTab />
        ) : isLoading ? (
          <PageLoader />
        ) : !data?.data.length ? (
          <EmptyState icon={<UserPlus className="h-10 w-10" />} title="No team members yet" description="Add agents to share the inbox and run campaigns together." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Member</Th>
                <Th>Status</Th>
                <Th className="hidden md:table-cell">Permissions</Th>
                <Th className="hidden md:table-cell">Last login</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((m) => (
                <Tr key={m.id} onClick={() => setViewing(m)}>
                  <Td>
                    <div className="flex items-center gap-3">
                      <Avatar name={displayName(m)} className="h-8 w-8" />
                      <div>
                        <p className="font-medium">{displayName(m)}</p>
                        <p className="text-xs text-fg-muted">
                          @{m.username} · {m.email}
                        </p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <StatusBadge status={m.status} />
                  </Td>
                  <Td className="hidden text-fg-muted md:table-cell">{m.permissions.length} granted</Td>
                  <Td className="hidden text-fg-muted md:table-cell">{m.lastLogin ? relativeTime(m.lastLogin) : "Never"}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <span onClick={(e) => e.stopPropagation()}>
                      {can("team:edit") && (
                        <Button size="sm" variant="ghost" onClick={() => setStatus.mutate(m)}>
                          {m.status === "active" ? "Deactivate" : "Activate"}
                        </Button>
                      )}
                      {isAdmin && can("team:delete") && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove ${m.username}`}
                          onClick={async () => {
                            if (await confirm({ title: `Remove ${displayName(m)}?`, description: "They lose access immediately. Conversations assigned to them become unassigned.", confirmText: "Remove", destructive: true })) {
                              remove.mutate(m.id);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      )}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
      <MemberDialog member={viewing} onClose={() => setViewing(null)} />
    </PageContainer>
  );
}
