import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Bot, Globe, History, Instagram, Mail, MessageCircle, MessageSquare, MessageSquareText, Pencil, PenLine, StickyNote, Trash2, Workflow, Facebook } from "lucide-react";
import { KIND_LABELS, TIMELINE_KINDS, type ContactSummary, type TimelineItem, type TimelineKind, type TimelinePage } from "@shared/timeline";
import { fieldLabel } from "@shared/contact-fields";
import type { Contact } from "@shared/schema";
import { useAuth } from "@/contexts/auth";
import { apiRequest, buildUrl, queryClient } from "@/lib/api";
import { cn, formatDate, formatDay, formatNumber, relativeTime } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/form";
import { Avatar, Badge, Card, CardHeader, EmptyState, PageLoader, Spinner, StatusBadge } from "@/components/ui/display";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";
import { ContactDialog, type GroupRow } from "./contacts";

const CHANNEL_ICON: Record<string, ReactNode> = {
  whatsapp: <MessageCircle className="h-4 w-4" />,
  web: <Globe className="h-4 w-4" />,
  messenger: <Facebook className="h-4 w-4" />,
  instagram: <Instagram className="h-4 w-4" />,
};
const KIND_ICON: Record<TimelineKind, ReactNode> = {
  message: <MessageCircle className="h-4 w-4" />,
  email: <Mail className="h-4 w-4" />,
  sms: <MessageSquareText className="h-4 w-4" />,
  automation: <Workflow className="h-4 w-4" />,
  note: <StickyNote className="h-4 w-4" />,
  activity: <PenLine className="h-4 w-4" />,
};
const CHANNEL_NAME: Record<string, string> = { whatsapp: "WhatsApp", web: "Website chat", messenger: "Messenger", instagram: "Instagram" };

/** Day headings: "Today", "Yesterday", or the date. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return formatDay(d);
}

export default function ContactProfilePage({ params }: { params: { id: string } }) {
  const id = params.id;
  const { can, user } = useAuth();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [kinds, setKinds] = useState<TimelineKind[]>([...TIMELINE_KINDS]);
  const [editing, setEditing] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const contact = useQuery<{ data: Contact }>({ queryKey: [`/api/contacts/${id}`] });
  const summary = useQuery<{ data: ContactSummary }>({ queryKey: [`/api/contacts/${id}/summary`] });
  const groups = useQuery<{ data: GroupRow[] }>({ queryKey: ["/api/groups"] });
  const timeline = useInfiniteQuery<{ data: TimelinePage }>({
    queryKey: [`/api/contacts/${id}/timeline`, kinds.join(",")],
    queryFn: ({ pageParam }) => apiRequest("GET", buildUrl(`/api/contacts/${id}/timeline`, { kinds: kinds.join(","), before: (pageParam as string | null) ?? undefined })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.data.nextBefore,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [`/api/contacts/${id}/timeline`] });
    void queryClient.invalidateQueries({ queryKey: [`/api/contacts/${id}/summary`] });
  };
  const startChat = useMutation({
    mutationFn: () => apiRequest<{ data: { id: string } }>("POST", "/api/conversations", { contactId: id }),
    onSuccess: (r) => navigate(`/inbox?c=${r.data.id}`),
    onError: (err) => toast({ title: "Could not open the conversation", description: (err as Error).message, variant: "error" }),
  });

  if (contact.isLoading) return <PageLoader />;
  const c = contact.data?.data;
  if (!c) return <EmptyState title="Contact not found" />;
  const s = summary.data?.data;
  const items = timeline.data?.pages.flatMap((p) => p.data.items) ?? [];
  const groupName = (g: string) => groups.data?.data.find((x) => x.id === g)?.name;
  const fields = Object.entries((c.metadata ?? {}) as Record<string, string>);

  return (
    <PageContainer wide>
      <Link href="/contacts" className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /> Contacts</Link>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* Profile */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <Avatar name={c.name} className="h-12 w-12 text-base" />
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-lg font-semibold">{c.name}</h1>
                <p className="text-sm text-fg-muted tabular-nums">{c.phone}</p>
                {c.email && <p className="truncate text-sm text-fg-muted">{c.email}</p>}
              </div>
              <StatusBadge status={c.status} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {can("inbox:send") && <Button size="sm" onClick={() => (s?.conversations.latestId ? navigate(`/inbox?c=${s.conversations.latestId}`) : startChat.mutate())} loading={startChat.isPending}><MessageSquare className="h-3.5 w-3.5" /> Open chat</Button>}
              {can("contacts:edit") && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>}
              {can("settings:edit") && user?.role === "admin" && <Button size="sm" variant="outline" onClick={() => setEnrolling(true)}><Workflow className="h-3.5 w-3.5" /> Add to flow</Button>}
            </div>
            {((c.tags ?? []).length > 0 || (c.groups ?? []).length > 0) && (
              <div className="mt-4 flex flex-wrap gap-1">
                {(c.groups ?? []).map((g) => groupName(g) && <Badge key={g} tone="primary">{groupName(g)}</Badge>)}
                {(c.tags ?? []).map((t) => <Badge key={t}>{t}</Badge>)}
              </div>
            )}
            <dl className="mt-4 space-y-1.5 border-t border-border pt-4 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-fg-muted">Added</dt><dd>{formatDay(c.createdAt)}{c.source ? ` · ${c.source.replace(/_/g, " ")}` : ""}</dd></div>
              {s?.messages.lastInboundAt && <div className="flex justify-between gap-3"><dt className="text-fg-muted">Last message from them</dt><dd>{relativeTime(s.messages.lastInboundAt)}</dd></div>}
              {fields.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="text-fg-muted">{fieldLabel(k)}</dt><dd className="truncate text-right">{v}</dd></div>
              ))}
            </dl>
          </Card>
          {s && (
            <Card className="grid grid-cols-2 gap-4 p-5 text-sm">
              <Stat label="Messages" value={`${formatNumber(s.messages.inbound)} in · ${formatNumber(s.messages.outbound)} out`} />
              <Stat label="Open chats" value={formatNumber(s.conversations.open)} />
              <Stat label="Emails" value={s.email.sent ? `${formatNumber(s.email.sent)} · ${Math.round((s.email.opened / s.email.sent) * 100)}% opened` : "None"} />
              <Stat label="SMS" value={s.sms.sent ? `${formatNumber(s.sms.sent)}${s.sms.clicked ? ` · ${s.sms.clicked} clicked` : ""}` : "None"} />
              <Stat label="Flows" value={s.flows.total ? `${s.flows.active} active of ${s.flows.total}` : "None"} />
              <Stat label="Notes" value={formatNumber(s.notes)} />
            </Card>
          )}
        </div>

        {/* Timeline */}
        <div className="flex min-w-0 flex-col gap-4">
          {(can("contacts:edit") || can("inbox:send")) && <NoteBox contactId={id} onAdded={refresh} />}
          <Card>
            <CardHeader
              title={<span className="flex items-center gap-2"><History className="h-4 w-4" /> Timeline</span>}
              actions={timeline.isFetching && !timeline.isFetchingNextPage ? <Spinner className="h-4 w-4" /> : undefined}
            />
            <div className="flex flex-wrap gap-1.5 border-b border-border px-5 py-3" role="group" aria-label="Show">
              <FilterChip active={kinds.length === TIMELINE_KINDS.length} onClick={() => setKinds([...TIMELINE_KINDS])}>All</FilterChip>
              {TIMELINE_KINDS.map((k) => (
                <FilterChip key={k} active={kinds.length !== TIMELINE_KINDS.length && kinds.includes(k)} onClick={() => setKinds(kinds.length === TIMELINE_KINDS.length ? [k] : kinds.includes(k) ? (kinds.length === 1 ? [...TIMELINE_KINDS] : kinds.filter((x) => x !== k)) : [...kinds, k])}>
                  {KIND_ICON[k]} {KIND_LABELS[k]}
                </FilterChip>
              ))}
            </div>
            {timeline.isLoading ? (
              <div className="p-8 text-center"><Spinner /></div>
            ) : !items.length ? (
              <EmptyState icon={<History className="h-10 w-10" />} title="Nothing here yet" description="Messages, campaigns, flows and notes for this contact appear here as they happen." />
            ) : (
              <ol className="px-5 py-4">
                {items.map((it, i) => (
                  <li key={it.id}>
                    {(i === 0 || dayLabel(items[i - 1].at) !== dayLabel(it.at)) && <p className="mt-2 mb-3 text-xs font-semibold tracking-wide text-fg-muted uppercase first:mt-0">{dayLabel(it.at)}</p>}
                    <Entry item={it} contactId={id} canDelete={it.kind === "note" && (it.authorId === user?.id || user?.role === "admin")} onDeleted={refresh} />
                  </li>
                ))}
              </ol>
            )}
            {timeline.hasNextPage && (
              <div className="border-t border-border p-3 text-center">
                <Button variant="outline" size="sm" onClick={() => void timeline.fetchNextPage()} loading={timeline.isFetchingNextPage}>Show older</Button>
              </div>
            )}
          </Card>
        </div>
      </div>
      <ContactDialog open={editing} onClose={() => { setEditing(false); void contact.refetch(); refresh(); }} contact={c} groups={groups.data?.data ?? []} />
      {enrolling && <EnrolDialog contact={c} onClose={() => setEnrolling(false)} onDone={refresh} />}
    </PageContainer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs", active ? "border-primary bg-primary/10 text-primary" : "border-border text-fg-muted hover:text-fg")}>
      {children}
    </button>
  );
}

function Entry({ item: it, contactId, canDelete, onDeleted }: { item: TimelineItem; contactId: string; canDelete: boolean; onDeleted: () => void }) {
  const confirm = useConfirm();
  const remove = useMutation({ mutationFn: () => apiRequest("DELETE", `/api/contacts/${contactId}/notes/${it.id.slice(5)}`), onSuccess: onDeleted });
  const inbound = it.direction === "inbound";
  const icon = it.kind === "message" ? (it.actor === "Chatbot" ? <Bot className="h-4 w-4" /> : CHANNEL_ICON[it.channel ?? "whatsapp"]) : KIND_ICON[it.kind];
  return (
    <div className="relative flex gap-3 pb-4 pl-1 before:absolute before:top-8 before:bottom-0 before:left-[19px] before:w-px before:bg-border last:before:hidden">
      <span className={cn("z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border", inbound ? "border-primary/40 bg-primary/10 text-primary" : it.kind === "note" ? "border-warning/40 bg-warning-soft text-warning" : "border-border bg-surface text-fg-muted")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{it.title}</span>
          {it.kind === "message" && it.channel && <span className="text-xs text-fg-muted">{CHANNEL_NAME[it.channel] ?? it.channel}</span>}
          {it.actor && <span className="text-xs text-fg-muted">· {it.actor}</span>}
          <time className="ml-auto text-xs text-fg-muted" dateTime={it.at} title={formatDate(it.at)}>{new Date(it.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        {it.body && (
          <p className={cn("mt-1 text-sm break-words whitespace-pre-wrap", it.kind === "message" ? cn("inline-block max-w-full rounded-lg px-3 py-2", inbound ? "bg-subtle" : "border border-border") : it.kind === "note" ? "rounded-md bg-warning-soft/60 px-3 py-2" : "text-fg-muted")}>{it.body}</p>
        )}
        {(it.status || (it.tags ?? []).length > 0 || it.link || canDelete) && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            {it.status && !["received", "sent", "completed"].includes(it.status) && !(it.tags ?? []).includes(it.status) && <Badge tone={["failed", "bounced"].includes(it.status) ? "danger" : "neutral"}>{it.status}</Badge>}
            {(it.tags ?? []).map((t) => <Badge key={t} tone={t === "imported" ? "neutral" : "success"}>{t}</Badge>)}
            {it.link && <Link href={it.link} className="text-primary hover:underline">{it.kind === "message" ? "Open chat" : it.kind === "automation" || it.actor?.startsWith("Flow") ? "Open flow" : "Open campaign"}</Link>}
            {canDelete && (
              <button type="button" className="ml-auto inline-flex items-center gap-1 text-fg-muted hover:text-danger" onClick={async () => { if (await confirm({ title: "Delete this note?", confirmText: "Delete", destructive: true })) remove.mutate(); }}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteBox({ contactId, onAdded }: { contactId: string; onAdded: () => void }) {
  const toast = useToast();
  const [body, setBody] = useState("");
  const add = useMutation({
    mutationFn: () => apiRequest("POST", `/api/contacts/${contactId}/notes`, { body }),
    onSuccess: () => {
      setBody("");
      onAdded();
    },
    onError: (err) => toast({ title: "Could not save the note", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Card className="p-4">
      <Textarea aria-label="Add a note" rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note for your team (only visible here)…" maxLength={5000} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && body.trim()) add.mutate(); }} />
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={() => add.mutate()} loading={add.isPending} disabled={!body.trim()}><StickyNote className="h-3.5 w-3.5" /> Add note</Button>
      </div>
    </Card>
  );
}

function EnrolDialog({ contact, onClose, onDone }: { contact: Contact; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const flows = useQuery<{ data: { id: string; name: string; status: string }[] }>({ queryKey: ["/api/automations"] });
  const active = (flows.data?.data ?? []).filter((f) => f.status === "active");
  const [flowId, setFlowId] = useState("");
  const enrol = useMutation({
    mutationFn: () => apiRequest<{ data: { enrolled: number } }>("POST", `/api/automations/${flowId}/enroll`, { contactIds: [contact.id] }),
    onSuccess: (r) => {
      toast(r.data.enrolled ? { title: `${contact.name} added to the flow`, variant: "success" } : { title: "Not added", description: "They're already in this flow, or have been through it and it doesn't allow repeats." });
      onDone();
      onClose();
    },
    onError: (err) => toast({ title: "Could not add to the flow", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog open onClose={onClose} size="sm" title={`Add ${contact.name} to a flow`} footer={<Button onClick={() => enrol.mutate()} loading={enrol.isPending} disabled={!flowId}>Add</Button>}>
      {flows.isLoading ? (
        <Spinner />
      ) : active.length ? (
        <Select aria-label="Flow" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
          <option value="">Choose a flow that's on…</option>
          {active.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
      ) : (
        <p className="text-sm text-fg-muted">No flows are on. <Link href="/automations" className="text-primary hover:underline">Create or turn one on</Link> first.</p>
      )}
    </Dialog>
  );
}
