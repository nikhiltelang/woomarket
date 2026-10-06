import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Download, Plus, Search, Trash2 } from "lucide-react";
import { adminCreateUserSchema } from "@shared/validation";
import type { Paginated, PublicUser } from "@shared/api-types";
import type { Plan, Subscription } from "@shared/schema";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { displayName, downloadUrl, formatDate, relativeTime } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { Avatar, Badge, Card, EmptyState, ErrorState, PageHeader, Spinner, StatusBadge } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

type CreateForm = z.input<typeof adminCreateUserSchema>;

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
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
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
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={form.handleSubmit((v) => create.mutate(v))} loading={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Role" htmlFor="u-role" className="sm:col-span-2" hint="Tenant admins start on the Free plan.">
          <Select id="u-role" {...form.register("role")}>
            <option value="admin">Tenant admin</option>
            <option value="superadmin">Superadmin</option>
          </Select>
        </Field>
        <Field label="First name" htmlFor="u-first">
          <Input id="u-first" {...form.register("firstName")} />
        </Field>
        <Field label="Last name" htmlFor="u-last">
          <Input id="u-last" {...form.register("lastName")} />
        </Field>
        <Field label="Username" htmlFor="u-user" error={e.username?.message}>
          <Input id="u-user" {...form.register("username")} invalid={!!e.username} />
        </Field>
        <Field label="Email" htmlFor="u-email" error={e.email?.message}>
          <Input id="u-email" type="email" {...form.register("email")} invalid={!!e.email} />
        </Field>
        <Field label="Password" htmlFor="u-pass" error={e.password?.message} className="sm:col-span-2">
          <Input id="u-pass" type="password" autoComplete="new-password" {...form.register("password")} invalid={!!e.password} />
        </Field>
      </div>
    </Dialog>
  );
}

function UserDetail({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const toast = useToast();
  const { data } = useQuery<{ data: PublicUser; subscriptions: Subscription[] }>({ queryKey: [`/api/admin/users/${userId}`], enabled: Boolean(userId) });
  const plans = useQuery<{ data: Plan[] }>({ queryKey: ["/api/admin/plans"], enabled: Boolean(userId) });
  const [planId, setPlanId] = useState("");
  const [cycle, setCycle] = useState<"monthly" | "annual">("monthly");
  const assign = useMutation({
    mutationFn: () => apiRequest("POST", "/api/assignSubscription", { userId, planId, billingCycle: cycle }),
    onSuccess: () => {
      toast({ title: "Plan assigned", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [`/api/admin/users/${userId}`] });
      setPlanId("");
    },
    onError: (err) => toast({ title: "Could not assign plan", description: (err as Error).message, variant: "error" }),
  });
  const u = data?.data;
  const active = data?.subscriptions.find((s) => s.status === "active");
  return (
    <Dialog open={Boolean(userId)} onClose={onClose} size="lg" title={u ? displayName(u) : "User"} description={u ? `@${u.username} · ${u.email}` : undefined}>
      {!u ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-5 text-sm">
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs text-fg-muted">Role</dt>
              <dd className="capitalize">{u.role}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Status</dt>
              <dd>
                <StatusBadge status={u.status} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Created</dt>
              <dd>{formatDate(u.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Last login</dt>
              <dd>{formatDate(u.lastLogin)}</dd>
            </div>
          </dl>
          {u.role === "admin" && (
            <div className="border-t border-border pt-4">
              <p className="mb-2 font-medium">Subscription</p>
              <p className="mb-3 text-fg-muted">
                {active ? `${active.planData.name} (${active.billingCycle}) until ${formatDate(active.endDate)}` : "No active subscription — the tenant is blocked from plan-limited features."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Select value={planId} onChange={(e) => setPlanId(e.target.value)} className="w-44" aria-label="Plan">
                  <option value="">Choose plan…</option>
                  {plans.data?.data.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                <Select value={cycle} onChange={(e) => setCycle(e.target.value as "monthly" | "annual")} className="w-32" aria-label="Billing cycle">
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual</option>
                </Select>
                <Button onClick={() => assign.mutate()} loading={assign.isPending} disabled={!planId}>
                  Assign plan
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export default function AdminUsers() {
  const { user: me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [role, setRole] = useState("");
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, error, refetch } = useQuery<Paginated<PublicUser>>({
    queryKey: ["/api/admin/users", { page, limit: 25, search: debounced || undefined, role: role || undefined }],
    placeholderData: (p) => p,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => apiRequest("PUT", `/api/admin/users/${id}/admin-update`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] }),
    onError: (err) => toast({ title: "Update failed", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/admin/users/${id}`),
    onSuccess: () => {
      toast({ title: "User deleted", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    },
    onError: (err) => toast({ title: "Delete failed", description: (err as Error).message, variant: "error" }),
  });

  return (
    <PageContainer wide>
      <PageHeader
        title="Users"
        description="Every account on the platform."
        actions={
          <>
            <Button variant="outline" onClick={() => downloadUrl("/api/admin/users/export")}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Create user
            </Button>
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-border p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-fg-muted" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search username, email or name" className="pl-9" aria-label="Search users" />
          </div>
          <Select
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              setPage(1);
            }}
            className="w-40"
            aria-label="Filter by role"
          >
            <option value="">All roles</option>
            <option value="superadmin">Superadmin</option>
            <option value="admin">Tenant admin</option>
            <option value="team">Team member</option>
          </Select>
        </div>
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="p-10 text-center">
            <Spinner />
          </div>
        ) : !data?.data.length ? (
          <EmptyState title="No users found" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>User</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th className="hidden md:table-cell">Last login</Th>
                  <Th className="hidden lg:table-cell">Created</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((u) => (
                  <Tr key={u.id} onClick={() => setViewing(u.id)}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Avatar name={displayName(u)} className="h-8 w-8" />
                        <div>
                          <p className="font-medium">{displayName(u)}</p>
                          <p className="text-xs text-fg-muted">
                            @{u.username} · {u.email}
                          </p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={u.role === "superadmin" ? "primary" : "neutral"}>{u.role}</Badge>
                    </Td>
                    <Td>
                      <StatusBadge status={u.status} />
                    </Td>
                    <Td className="hidden text-fg-muted md:table-cell">{u.lastLogin ? relativeTime(u.lastLogin) : "Never"}</Td>
                    <Td className="hidden text-fg-muted lg:table-cell">{formatDate(u.createdAt)}</Td>
                    <Td className="text-right whitespace-nowrap">
                      {u.id !== me?.id && (
                        <span onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: u.id, body: { status: u.status === "active" ? "inactive" : "active" } })}>
                            {u.status === "active" ? "Deactivate" : "Activate"}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete ${u.username}`}
                            onClick={async () => {
                              if (await confirm({ title: `Delete ${u.username}?`, description: "The account and everything it owns are permanently deleted.", confirmText: "Delete", destructive: true })) {
                                remove.mutate(u.id);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-danger" />
                          </Button>
                        </span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} limit={25} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
      <UserDetail userId={viewing} onClose={() => setViewing(null)} />
    </PageContainer>
  );
}
