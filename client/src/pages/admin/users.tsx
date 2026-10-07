import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { BadgeCheck, Ban, Download, Monitor, Plus, Search, ShieldOff, Trash2 } from "lucide-react";
import { adminCreateUserSchema } from "@shared/validation";
import type { Paginated, PublicUser } from "@shared/api-types";
import type { AccessLevel, Plan, Subscription } from "@shared/schema";
import { useAuth } from "@/contexts/auth";
import { usePlatform } from "@/contexts/platform";
import { apiRequest, queryClient } from "@/lib/api";
import { displayName, downloadUrl, formatDate, relativeTime } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Avatar, Badge, Card, EmptyState, ErrorState, PageHeader, Spinner, StatusBadge } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

type Row = PublicUser & { planName: string | null; levelName: string | null };
type CreateForm = z.input<typeof adminCreateUserSchema>;

const SEGMENTS: Record<string, { title: string; description: string; api: string }> = {
  active: { title: "Active users", description: "Accounts that can sign in.", api: "active" },
  banned: { title: "Banned users", description: "Suspended accounts. They can't sign in until unbanned.", api: "banned" },
  "email-unverified": { title: "Email unverified", description: "Accounts that haven't confirmed their email address.", api: "email-unverified" },
  "mobile-unverified": { title: "Mobile unverified", description: "Accounts with a phone number that hasn't been verified.", api: "mobile-unverified" },
  "with-subscription": { title: "With subscription", description: "Tenants with an active plan.", api: "with-subscription" },
  all: { title: "All users", description: "Every account on the platform.", api: "all" },
};

const invalidateUsers = () => {
  void queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/admin/users/counts"] });
};

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const form = useForm<CreateForm>({ resolver: zodResolver(adminCreateUserSchema), defaultValues: { role: "admin" } });
  useEffect(() => {
    if (open) form.reset({ role: "admin", username: "", email: "", password: "" });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = useMutation({
    mutationFn: (v: CreateForm) => apiRequest("POST", "/api/admin/users/create", v),
    onSuccess: () => {
      toast({ title: "User created", variant: "success" });
      invalidateUsers();
      onClose();
    },
    onError: (err) => toast({ title: "Could not create user", description: (err as Error).message, variant: "error" }),
  });
  const e = form.formState.errors;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create user"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={form.handleSubmit((v) => create.mutate(v))} loading={create.isPending}>Create</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Role" htmlFor="u-role" className="sm:col-span-2" hint="Tenant admins start on the Free plan and the lowest access level.">
          <Select id="u-role" {...form.register("role")}>
            <option value="admin">Tenant admin</option>
            <option value="superadmin">Superadmin</option>
          </Select>
        </Field>
        <Field label="First name" htmlFor="u-first"><Input id="u-first" {...form.register("firstName")} /></Field>
        <Field label="Last name" htmlFor="u-last"><Input id="u-last" {...form.register("lastName")} /></Field>
        <Field label="Username" htmlFor="u-user" error={e.username?.message}><Input id="u-user" {...form.register("username")} invalid={!!e.username} /></Field>
        <Field label="Email" htmlFor="u-email" error={e.email?.message}><Input id="u-email" type="email" {...form.register("email")} invalid={!!e.email} /></Field>
        <Field label="Password" htmlFor="u-pass" error={e.password?.message} className="sm:col-span-2">
          <Input id="u-pass" type="password" autoComplete="new-password" {...form.register("password")} invalid={!!e.password} />
        </Field>
      </div>
    </Dialog>
  );
}

function UserDetail({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const key = [`/api/admin/users/${userId}`];
  const { data } = useQuery<{ data: PublicUser; subscriptions: Subscription[] }>({ queryKey: key, enabled: Boolean(userId) });
  const plans = useQuery<{ data: Plan[] }>({ queryKey: ["/api/admin/plans"], enabled: Boolean(userId) });
  const levels = useQuery<{ data: AccessLevel[] }>({ queryKey: ["/api/superadmin/levels"], enabled: Boolean(userId) });
  const [planId, setPlanId] = useState("");
  const [cycle, setCycle] = useState<"monthly" | "annual">("monthly");
  const [banning, setBanning] = useState(false);
  const [reason, setReason] = useState("");

  const done = (title: string) => () => {
    toast({ title, variant: "success" });
    void queryClient.invalidateQueries({ queryKey: key });
    invalidateUsers();
  };
  const fail = (err: unknown) => toast({ title: "Action failed", description: (err as Error).message, variant: "error" });
  const assignPlan = useMutation({ mutationFn: () => apiRequest("POST", "/api/assignSubscription", { userId, planId, billingCycle: cycle }), onSuccess: done("Plan assigned"), onError: fail });
  const assignLevel = useMutation({ mutationFn: (level: number | null) => apiRequest("PUT", `/api/admin/users/${userId}/level`, { level }), onSuccess: done("Level updated"), onError: fail });
  const ban = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/admin/users/${userId}/ban`, { reason }),
    onSuccess: () => {
      setBanning(false);
      setReason("");
      done("User banned")();
    },
    onError: fail,
  });
  const unban = useMutation({ mutationFn: () => apiRequest("PUT", `/api/admin/users/${userId}/unban`), onSuccess: done("User unbanned"), onError: fail });
  const toggle = useMutation({ mutationFn: (what: "email" | "mobile") => apiRequest("PUT", `/api/admin/users/${userId}/toggle-${what}-verify`), onSuccess: done("Verification updated"), onError: fail });
  const setStatus = useMutation({ mutationFn: (status: string) => apiRequest("PUT", `/api/admin/users/${userId}/admin-update`, { status }), onSuccess: done("Status updated"), onError: fail });

  const u = data?.data;
  const active = data?.subscriptions.find((s) => s.status === "active");
  const isSelf = u?.id === me?.id;

  return (
    <Dialog open={Boolean(userId)} onClose={onClose} size="lg" title={u ? displayName(u) : "User"} description={u ? `@${u.username} · ${u.email}` : undefined}>
      {!u ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-6 text-sm">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div><dt className="text-xs text-fg-muted">Role</dt><dd className="capitalize">{u.role}</dd></div>
            <div><dt className="text-xs text-fg-muted">Status</dt><dd><StatusBadge status={u.status} /></dd></div>
            <div><dt className="text-xs text-fg-muted">Phone</dt><dd>{u.phone || "—"}</dd></div>
            <div><dt className="text-xs text-fg-muted">Joined</dt><dd>{formatDate(u.createdAt)}</dd></div>
            <div><dt className="text-xs text-fg-muted">Last sign-in</dt><dd>{formatDate(u.lastLogin)}</dd></div>
          </dl>

          <section className="border-t border-border pt-4">
            <h3 className="mb-3 font-medium">Verification</h3>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => toggle.mutate("email")} loading={toggle.isPending && toggle.variables === "email"}>
                <BadgeCheck className="h-3.5 w-3.5" /> Email: {u.isEmailVerified ? "verified — mark unverified" : "unverified — mark verified"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => toggle.mutate("mobile")} loading={toggle.isPending && toggle.variables === "mobile"}>
                <BadgeCheck className="h-3.5 w-3.5" /> Mobile: {u.isMobileVerified ? "verified — mark unverified" : "unverified — mark verified"}
              </Button>
            </div>
          </section>

          {u.role === "admin" && (
            <section className="border-t border-border pt-4">
              <h3 className="mb-1 font-medium">Access level</h3>
              <p className="mb-3 text-fg-muted">Limits apply to the whole tenant, on top of its plan.</p>
              <Select className="w-64" value={u.accessLevel ?? ""} onChange={(e) => assignLevel.mutate(e.target.value ? Number(e.target.value) : null)} aria-label="Access level">
                <option value="">No level (plan limits only)</option>
                {levels.data?.data.map((l) => (
                  <option key={l.id} value={l.levelNumber}>
                    Level {l.levelNumber} — {l.name}
                  </option>
                ))}
              </Select>
            </section>
          )}

          {u.role === "admin" && (
            <section className="border-t border-border pt-4">
              <h3 className="mb-1 font-medium">Subscription</h3>
              <p className="mb-3 text-fg-muted">{active ? `${active.planData.name} (${active.billingCycle}) until ${formatDate(active.endDate)}` : "No active subscription — plan-limited features are blocked."}</p>
              <div className="flex flex-wrap gap-2">
                <Select value={planId} onChange={(e) => setPlanId(e.target.value)} className="w-44" aria-label="Plan">
                  <option value="">Choose plan…</option>
                  {plans.data?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Select value={cycle} onChange={(e) => setCycle(e.target.value as "monthly" | "annual")} className="w-32" aria-label="Billing cycle">
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual</option>
                </Select>
                <Button onClick={() => assignPlan.mutate()} loading={assignPlan.isPending} disabled={!planId}>Assign plan</Button>
              </div>
            </section>
          )}

          {!isSelf && (
            <section className="border-t border-border pt-4">
              <h3 className="mb-3 font-medium">Account access</h3>
              {u.status === "banned" ? (
                <Button variant="outline" onClick={() => unban.mutate()} loading={unban.isPending}>
                  <ShieldOff className="h-4 w-4" /> Unban user
                </Button>
              ) : banning ? (
                <div className="flex flex-col gap-2">
                  <Field label="Reason (kept in the audit log)" htmlFor="ban-reason">
                    <Textarea id="ban-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                  <div className="flex gap-2">
                    <Button variant="danger" onClick={() => ban.mutate()} loading={ban.isPending} disabled={!reason.trim()}>Confirm ban</Button>
                    <Button variant="ghost" onClick={() => setBanning(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setStatus.mutate(u.status === "active" ? "inactive" : "active")} loading={setStatus.isPending}>
                    {u.status === "active" ? "Deactivate" : "Activate"}
                  </Button>
                  <Button
                    variant="outline"
                    className="border-danger text-danger"
                    onClick={async () => {
                      if (await confirm({ title: `Ban ${u.username}?`, description: "They're signed out everywhere immediately and can't sign in until you unban them.", confirmText: "Continue", destructive: true })) setBanning(true);
                    }}
                  >
                    <Ban className="h-4 w-4" /> Ban user
                  </Button>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}

export default function AdminUsers({ params }: { params: { segment?: string } }) {
  const { user: me } = useAuth();
  const { config } = usePlatform();
  const toast = useToast();
  const confirm = useConfirm();
  const segment = SEGMENTS[params.segment ?? "all"] ? (params.segment ?? "all") : "all";
  const meta = SEGMENTS[segment];
  const limit = config?.recordsPerPage ?? 20;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [segment, query, role]);

  const { data, isLoading, error, refetch } = useQuery<Paginated<Row>>({
    queryKey: ["/api/admin/users", { page, limit, search: query || undefined, role: role || undefined, segment: meta.api }],
    placeholderData: (p) => p,
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/admin/users/${id}`),
    onSuccess: () => {
      toast({ title: "User deleted", variant: "success" });
      invalidateUsers();
    },
    onError: (err) => toast({ title: "Delete failed", description: (err as Error).message, variant: "error" }),
  });

  return (
    <PageContainer wide>
      <PageHeader
        title={meta.title}
        description={meta.description}
        actions={
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(search.trim());
              }}
              className="flex"
              role="search"
            >
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Username / Email" className="w-56 rounded-r-none" aria-label="Search users" />
              <Button type="submit" className="rounded-l-none" aria-label="Search"><Search className="h-4 w-4" /></Button>
            </form>
            <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-36" aria-label="Filter by role">
              <option value="">All roles</option>
              <option value="superadmin">Superadmin</option>
              <option value="admin">Tenant admin</option>
              <option value="team">Team member</option>
            </Select>
            <Button variant="outline" onClick={() => downloadUrl("/api/admin/users/export")}><Download className="h-4 w-4" /> Export</Button>
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Create user</Button>
          </>
        }
      />
      <Card className="overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="p-10 text-center"><Spinner /></div>
        ) : !data?.data.length ? (
          <EmptyState title={query ? "No matching users" : "No users here"} description={query ? "Try another username or email." : undefined} />
        ) : (
          <>
            <Table>
              <thead>
                <tr className="[&>th]:bg-primary [&>th]:text-primary-fg">
                  <Th>User</Th>
                  <Th>Email · Mobile</Th>
                  <Th className="hidden lg:table-cell">Plan · Level</Th>
                  <Th className="hidden md:table-cell">Joined at</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Action</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((u) => (
                  <Tr key={u.id}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Avatar name={displayName(u)} className="h-10 w-10" />
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{displayName(u)}</p>
                          <p className="truncate text-sm text-primary">@{u.username}</p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <p className="flex items-center gap-1">
                        {u.email}
                        {u.isEmailVerified && <BadgeCheck className="h-3.5 w-3.5 text-success" aria-label="Email verified" />}
                      </p>
                      {u.phone && (
                        <p className="flex items-center gap-1 text-xs text-fg-muted tabular-nums">
                          {u.phone}
                          {u.isMobileVerified && <BadgeCheck className="h-3.5 w-3.5 text-success" aria-label="Mobile verified" />}
                        </p>
                      )}
                    </Td>
                    <Td className="hidden lg:table-cell">
                      {u.role === "superadmin" ? (
                        <Badge tone="primary">superadmin</Badge>
                      ) : (
                        <>
                          <p>{u.planName ?? <span className="text-fg-muted">No plan</span>}</p>
                          {u.levelName && <p className="text-xs text-fg-muted">Level {u.accessLevel} · {u.levelName}</p>}
                          {u.role === "team" && <p className="text-xs text-fg-muted">Team member</p>}
                        </>
                      )}
                    </Td>
                    <Td className="hidden md:table-cell">
                      <p className="tabular-nums">{formatDate(u.createdAt)}</p>
                      <p className="text-xs text-fg-muted">{relativeTime(u.createdAt)}</p>
                    </Td>
                    <Td><StatusBadge status={u.status} /></Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="outline" className="border-primary text-primary" onClick={() => setViewing(u.id)}>
                        <Monitor className="h-3.5 w-3.5" /> Details
                      </Button>
                      {u.id !== me?.id && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete ${u.username}`}
                          onClick={async () => {
                            if (await confirm({ title: `Delete ${u.username}?`, description: "The account and everything it owns are permanently deleted.", confirmText: "Delete", destructive: true })) remove.mutate(u.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} limit={limit} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
      <UserDetail userId={viewing} onClose={() => setViewing(null)} />
    </PageContainer>
  );
}
