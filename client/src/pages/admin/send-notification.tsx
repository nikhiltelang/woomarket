import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Send, Trash2, X } from "lucide-react";
import type { Paginated, PublicUser } from "@shared/api-types";
import type { Notification } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/api";
import { displayName, formatDate, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Spinner } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { useConfirm, useToast } from "@/components/ui/overlay";

type Target = "all" | "admins" | "team" | "superadmins" | "users";
type Sent = Notification & { recipients: number; reads: number };

function UserPicker({ selected, onChange }: { selected: PublicUser[]; onChange: (u: PublicUser[]) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isFetching } = useQuery<Paginated<PublicUser>>({ queryKey: ["/api/admin/users", { search: debounced, limit: 8, segment: "active" }], enabled: debounced.length > 1 });
  const ids = new Set(selected.map((u) => u.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {selected.map((u) => (
          <Badge key={u.id} tone="primary">
            @{u.username}
            <button type="button" onClick={() => onChange(selected.filter((x) => x.id !== u.id))} aria-label={`Remove ${u.username}`}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username or email to add…" aria-label="Find users" />
      {debounced.length > 1 && (
        <ul className="max-h-48 overflow-y-auto rounded-md border border-border">
          {isFetching && !data ? (
            <li className="p-3"><Spinner /></li>
          ) : data?.data.length ? (
            data.data.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  disabled={ids.has(u.id)}
                  onClick={() => {
                    onChange([...selected, u]);
                    setQ("");
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-subtle disabled:opacity-50"
                >
                  <span>{displayName(u)} <span className="text-fg-muted">@{u.username}</span></span>
                  <span className="text-xs text-fg-muted">{u.role}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="p-3 text-sm text-fg-muted">No active users match.</li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function SendNotificationPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [type, setType] = useState("announcement");
  const [target, setTarget] = useState<Target>("all");
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [viaInApp, setViaInApp] = useState(true);
  const [viaEmail, setViaEmail] = useState(false);
  const [page, setPage] = useState(1);
  const history = useQuery<Paginated<Sent>>({ queryKey: ["/api/notifications", { page, limit: 10 }], placeholderData: (p) => p });

  const send = useMutation({
    mutationFn: () => apiRequest<{ recipients: number; emailQueued: number; emailDisabled: boolean }>("POST", "/api/notifications", { title, message, type, targetType: target, targetIds: users.map((u) => u.id), viaInApp, viaEmail }),
    onSuccess: (r) => {
      toast({
        title: `Sent to ${formatNumber(r.recipients)} user${r.recipients === 1 ? "" : "s"}`,
        description: r.emailDisabled ? "Email delivery is switched off in System configuration, so only in-app was sent." : r.emailQueued ? `${formatNumber(r.emailQueued)} emails are being delivered.` : undefined,
        variant: r.emailDisabled ? "warning" : "success",
      });
      setTitle("");
      setMessage("");
      setUsers([]);
      void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
    onError: (err) => toast({ title: "Could not send", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/notifications/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });

  const valid = title.trim() && message.trim() && (viaInApp || viaEmail) && (target !== "users" || users.length > 0);
  const audience = { all: "All active users", admins: "Tenant admins", team: "Team members", superadmins: "Superadmins", users: "Specific users" };

  return (
    <PageContainer>
      <PageHeader title="Send notification" description="Message users in the app (bell icon, real time) and/or by email." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader title="Compose" />
          <form
            className="flex flex-col gap-4 p-5"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await confirm({ title: "Send this notification?", description: `${audience[target]}${target === "users" ? ` (${users.length})` : ""} · ${[viaInApp && "in-app", viaEmail && "email"].filter(Boolean).join(" + ")}`, confirmText: "Send" })) send.mutate();
            }}
          >
            <Field label="Title" htmlFor="n-title"><Input id="n-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
            <Field label="Message" htmlFor="n-msg" hint="Plain text. Blank lines start new paragraphs in emails.">
              <Textarea id="n-msg" rows={6} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Type" htmlFor="n-type">
                <Select id="n-type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="announcement">Announcement</option>
                  <option value="general">General</option>
                  <option value="maintenance">Maintenance</option>
                  <option value="promotion">Promotion</option>
                </Select>
              </Field>
              <Field label="Send to" htmlFor="n-target">
                <Select id="n-target" value={target} onChange={(e) => setTarget(e.target.value as Target)}>
                  {Object.entries(audience).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
            </div>
            {target === "users" && <UserPicker selected={users} onChange={setUsers} />}
            <fieldset className="flex flex-wrap gap-5">
              <legend className="mb-2 text-sm font-medium">Deliver via</legend>
              <Checkbox label="In-app notification" checked={viaInApp} onChange={setViaInApp} />
              <Checkbox label="Email" checked={viaEmail} onChange={setViaEmail} />
            </fieldset>
            <Button type="submit" className="self-start" disabled={!valid} loading={send.isPending}><Send className="h-4 w-4" /> Send notification</Button>
          </form>
        </Card>
        <Card>
          <CardHeader title="History" />
          {!history.data?.data.length ? (
            <EmptyState title="Nothing sent yet" />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Notification</Th>
                    <Th>Audience</Th>
                    <Th className="text-right">Read</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {history.data.data.map((n) => (
                    <Tr key={n.id}>
                      <Td>
                        <p className="font-medium">{n.title}</p>
                        <p className="line-clamp-2 max-w-72 text-xs text-fg-muted">{n.message}</p>
                        <p className="text-xs text-fg-muted">{formatDate(n.sentAt ?? n.createdAt)} · by {n.createdBy}</p>
                      </Td>
                      <Td><Badge>{n.targetType}</Badge></Td>
                      <Td className="text-right tabular-nums">{formatNumber(n.reads)} / {formatNumber(n.recipients)}</Td>
                      <Td className="text-right">
                        <Button size="icon" variant="ghost" aria-label="Delete" onClick={async () => {
                          if (await confirm({ title: "Delete this notification?", description: "It disappears from every user's bell.", confirmText: "Delete", destructive: true })) remove.mutate(n.id);
                        }}><Trash2 className="h-4 w-4 text-danger" /></Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={page} limit={10} total={history.data.total} onPage={setPage} />
            </>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
