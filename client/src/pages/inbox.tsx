import { useEffect, useMemo, useRef, useState } from "react";
import { isSocialType, SOCIAL_LABELS, type PublicSocialAccount } from "@shared/social";
import { AiInsightsPanel, AiReplySuggestions, IntentBadge } from "@/components/ai";
import type { ConversationInsights } from "@shared/ai";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  CheckCheck,
  Clock,
  FileText,
  MessageSquare,
  Pin,
  PinOff,
  Search,
  Send,
  Globe,
  Image as ImageIcon,
} from "lucide-react";
import type { Contact, Conversation, Message, Template } from "@shared/schema";
import type { Paginated } from "@shared/api-types";
import { useChannel } from "@/contexts/channel";
import { useAuth } from "@/contexts/auth";
import { useSocket, useSocketEvent } from "@/contexts/socket";
import { ApiError, apiRequest, queryClient } from "@/lib/api";
import { cn, formatDate, formatTime, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Avatar, Badge, EmptyState, Spinner, StatusBadge } from "@/components/ui/display";
import { Dialog, Tabs, useToast } from "@/components/ui/overlay";

type ConversationRow = Conversation & { assigneeName: string | null; pinned: boolean; windowOpen: boolean };
type Filter = "all" | "me" | "unassigned" | "unread";

interface Assignee {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
}

const listKey = (channelId: string) => ["/api/conversations", { channelId }] as const;
const messagesKey = (id: string) => [`/api/conversations/${id}/messages`];

function ConversationList({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { activeChannel } = useChannel();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = {
    channelId: activeChannel!.id,
    limit: 100,
    search: debounced || undefined,
    assigned: filter === "me" || filter === "unassigned" ? filter : undefined,
    unread: filter === "unread" ? true : undefined,
  };
  const { data, isLoading } = useQuery<Paginated<ConversationRow>>({ queryKey: ["/api/conversations", params] });

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-fg-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or number" className="pl-9" aria-label="Search conversations" />
        </div>
        <Tabs<Filter>
          value={filter}
          onChange={setFilter}
          tabs={[
            { value: "all", label: "All" },
            { value: "me", label: "Mine" },
            { value: "unassigned", label: "Unassigned" },
            { value: "unread", label: "Unread" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-6 text-center">
            <Spinner />
          </div>
        ) : !data?.data.length ? (
          <EmptyState icon={<MessageSquare className="h-8 w-8" />} title="No conversations" description="Incoming WhatsApp messages appear here in real time." />
        ) : (
          <ul>
            {data.data.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={cn(
                    "flex w-full gap-3 border-b border-border px-3 py-3 text-left transition-colors hover:bg-subtle",
                    selected === c.id && "bg-primary-soft/60",
                  )}
                >
                  <Avatar name={c.contactName ?? c.contactPhone ?? "?"} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1 truncate text-sm font-medium">
                        {c.pinned && <Pin className="h-3 w-3 shrink-0 text-fg-muted" aria-label="Pinned" />}
                        <span className="truncate">{c.contactName ?? c.contactPhone}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-fg-muted">{relativeTime(c.lastMessageAt)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-fg-muted">{c.lastMessageText ?? "No messages yet"}</span>
                      {!!c.unreadCount && (
                        <span className="rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-fg tabular-nums">{c.unreadCount}</span>
                      )}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {c.status !== "open" && <StatusBadge status={c.status} />}
                      {c.type === "web" && <Badge tone="info"><Globe className="h-3 w-3" /> Website</Badge>}
                      {isSocialType(c.type) && <Badge tone="info">{SOCIAL_LABELS[c.type]}</Badge>}
                      {c.assigneeName && <Badge>@{c.assigneeName}</Badge>}
                      <IntentBadge insights={c.aiInsights as Partial<ConversationInsights> | null} />
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ message }: { message: Message }) {
  if (message.direction === "inbound") return null;
  switch (message.status) {
    case "failed":
      return <AlertCircle className="h-3.5 w-3.5 text-danger" aria-label="Failed" />;
    case "read":
      return <CheckCheck className="h-3.5 w-3.5 text-info" aria-label="Read" />;
    case "delivered":
      return <CheckCheck className="h-3.5 w-3.5" aria-label="Delivered" />;
    case "sent":
      return <Check className="h-3.5 w-3.5" aria-label="Sent" />;
    default:
      return <Clock className="h-3.5 w-3.5" aria-label="Pending" />;
  }
}

function MessageBubble({ m }: { m: Message }) {
  const outbound = m.direction !== "inbound";
  const meta = (m.metadata ?? {}) as { sentByName?: string; campaignName?: string; bot?: boolean; options?: { id: string; title: string }[] };
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[78%] rounded-lg px-3 py-2 text-sm shadow-sm", outbound ? "bg-bubble-out" : "bg-bubble-in border border-border")}>
        {(meta.campaignName || m.type === "template") && (
          <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-fg-muted">
            <FileText className="h-3 w-3" /> {meta.campaignName ? `Campaign · ${meta.campaignName}` : "Template"}
          </p>
        )}
        {m.type === "image" && m.mediaUrl && /^https?:\/\//.test(m.mediaUrl) ? (
          <a href={m.mediaUrl} target="_blank" rel="noreferrer noopener">
            <img src={m.mediaUrl} alt="Image" loading="lazy" className="max-h-64 max-w-full rounded-md" />
          </a>
        ) : (
          <p className="break-words whitespace-pre-wrap">{m.content}</p>
        )}
        {meta.options && meta.options.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {meta.options.map((o) => <span key={o.id} className="rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-primary">{o.title}</span>)}
          </div>
        )}
        <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-fg-muted">
          {outbound && meta.bot && <span className="flex items-center gap-0.5"><Bot className="h-3 w-3" aria-hidden /> Bot ·</span>}
          {outbound && meta.sentByName && <span>{meta.sentByName} ·</span>}
          <time dateTime={String(m.timestamp ?? m.createdAt)} title={formatDate(m.timestamp ?? m.createdAt)}>
            {formatTime(m.timestamp ?? m.createdAt)}
          </time>
          <StatusIcon message={m} />
        </p>
        {m.status === "failed" && m.errorMessage && <p className="mt-1 text-xs text-danger">{m.errorMessage}</p>}
      </div>
    </div>
  );
}

function TemplateDialog({ open, onClose, conversationId }: { open: boolean; onClose: () => void; conversationId: string }) {
  const { activeChannel } = useChannel();
  const toast = useToast();
  const { data } = useQuery<{ data: Template[] }>({
    queryKey: ["/api/templates", { channelId: activeChannel!.id, status: "approved" }],
    enabled: open,
  });
  const [templateId, setTemplateId] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const template = data?.data.find((t) => t.id === templateId);
  const vars = template?.bodyVariables ?? 0;
  const preview = template?.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`);

  const send = useMutation({
    mutationFn: () => apiRequest("POST", `/api/conversations/${conversationId}/messages`, { type: "template", templateId, params: params.slice(0, vars) }),
    onSuccess: () => {
      toast({ title: "Template sent", variant: "success" });
      onClose();
      setTemplateId("");
      setParams([]);
    },
    onError: (err) => toast({ title: "Could not send template", description: (err as Error).message, variant: "error" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: messagesKey(conversationId) }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Send a template"
      description="Approved templates can be sent at any time, including outside the 24-hour window."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => send.mutate()} loading={send.isPending} disabled={!template || params.slice(0, vars).some((p) => !p.trim()) || params.length < vars}>
            Send template
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Template" htmlFor="tpl">
          <Select
            id="tpl"
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              setParams([]);
            }}
          >
            <option value="">Choose an approved template…</option>
            {data?.data.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.language})
              </option>
            ))}
          </Select>
        </Field>
        {Array.from({ length: vars }, (_, i) => (
          <Field key={i} label={`Variable {{${i + 1}}}`} htmlFor={`var-${i}`}>
            <Input
              id={`var-${i}`}
              value={params[i] ?? ""}
              onChange={(e) => setParams((p) => Object.assign([...p], { [i]: e.target.value }))}
            />
          </Field>
        ))}
        {preview && (
          <div className="rounded-lg bg-bubble-out p-3 text-sm whitespace-pre-wrap">
            {template?.header && <p className="mb-1 font-semibold">{template.header}</p>}
            {preview}
            {template?.footer && <p className="mt-2 text-xs text-fg-muted">{template.footer}</p>}
          </div>
        )}
        {data && data.data.length === 0 && <p className="text-sm text-fg-muted">No approved templates yet. Create one on the Templates page.</p>}
      </div>
    </Dialog>
  );
}

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const { activeChannel } = useChannel();
  const { user, can } = useAuth();
  const { socket } = useSocket();
  const toast = useToast();
  const [text, setText] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [typing, setTyping] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();

  const conv = useQuery<{ data: ConversationRow & { replyPolicy?: string }; contact: Contact | null; social?: PublicSocialAccount | null; bot?: { enabled: boolean } }>({ queryKey: [`/api/conversations/${id}`] });
  const msgs = useQuery<{ data: Message[] }>({ queryKey: [...messagesKey(id), { limit: 100 }] });
  const assignees = useQuery<{ data: Assignee[] }>({ queryKey: ["/api/team/assignees"], enabled: can("inbox:assign") });

  useEffect(() => {
    if (!socket) return;
    socket.emit("join_conversation", { conversationId: id });
    socket.emit("conversation_opened", { conversationId: id });
    return () => {
      socket.emit("leave_conversation", { conversationId: id });
    };
  }, [socket, id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [msgs.data?.data.length]);

  useSocketEvent<{ conversationId: string; username: string }>("user_typing", (p) => {
    if (p.conversationId !== id) return;
    setTyping(p.username);
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(null), 4000);
  });
  useSocketEvent<{ conversationId: string }>("user_stopped_typing", (p) => p.conversationId === id && setTyping(null));

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [`/api/conversations/${id}`] });
    void queryClient.invalidateQueries({ queryKey: listKey(activeChannel!.id).slice(0, 1) });
  };

  const send = useMutation({
    mutationFn: (body: string) => apiRequest("POST", `/api/conversations/${id}/messages`, { type: "text", text: body }),
    onSuccess: () => setText(""),
    onError: (err) => {
      if (err instanceof ApiError && err.code === "WINDOW_CLOSED") setTemplateOpen(true);
      toast({ title: "Message not sent", description: (err as Error).message, variant: "error" });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: messagesKey(id) });
      invalidate();
    },
  });

  // Messenger / Instagram: upload the picture, then send it (typed text follows as a caption).
  const imageInput = useRef<HTMLInputElement>(null);
  const sendImage = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("image", file);
      const up = await apiRequest<{ data: { url: string } }>("POST", `/api/conversations/${id}/attachments`, fd);
      return apiRequest("POST", `/api/conversations/${id}/messages`, { type: "image", url: up.data.url, ...(text.trim() ? { caption: text.trim() } : {}) });
    },
    onSuccess: () => setText(""),
    onError: (err) => toast({ title: "Image not sent", description: (err as Error).message, variant: "error" }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: messagesKey(id) });
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiRequest("PUT", `/api/conversations/${id}`, body),
    onSuccess: invalidate,
    onError: (err) => toast({ title: "Update failed", description: (err as Error).message, variant: "error" }),
  });
  const setStatus = useMutation({
    mutationFn: (status: string) => apiRequest("PATCH", `/api/conversations/${id}/status`, { status }),
    onSuccess: invalidate,
  });
  const pauseBot = useMutation({
    mutationFn: (hours: number) => apiRequest("POST", `/api/chatbot/conversations/${id}/pause`, { hours }),
    onSuccess: invalidate,
    onError: (err) => toast({ title: "Could not change the bot", description: (err as Error).message, variant: "error" }),
  });
  const togglePin = useMutation({
    mutationFn: (pinned: boolean) => apiRequest(pinned ? "DELETE" : "POST", `/api/conversations/${id}/pin`),
    onSuccess: invalidate,
  });

  if (conv.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!conv.data) return <EmptyState title="Conversation not found" />;
  const c = conv.data.data;
  const contact = conv.data.contact;

  const submit = () => {
    const body = text.trim();
    if (body && !send.isPending) send.mutate(body);
  };

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
          <button className="text-fg-muted md:hidden" onClick={onBack} aria-label="Back to conversations">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <Avatar name={c.contactName ?? c.contactPhone ?? "?"} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{c.contactName ?? c.contactPhone}</p>
            <p className="truncate text-xs text-fg-muted">
              {c.contactPhone}
              {typing && <span className="ml-2 text-primary">{typing} is typing…</span>}
            </p>
          </div>
          {conv.data.bot?.enabled && can("inbox:send") && (() => {
            const paused = Boolean(c.botPausedUntil && new Date(c.botPausedUntil).getTime() > Date.now());
            return (
              <Button
                variant={paused ? "outline" : "ghost"}
                size="sm"
                loading={pauseBot.isPending}
                onClick={() => pauseBot.mutate(paused ? 0 : 24)}
                title={paused ? `The bot is paused here until ${formatDate(c.botPausedUntil)}. Click to let it answer again.` : "The bot answers this chat. Click to pause it for 24 hours."}
              >
                <Bot className="h-4 w-4" /> {paused ? "Bot paused · resume" : "Pause bot"}
              </Button>
            );
          })()}
          <Button variant="ghost" size="icon" onClick={() => togglePin.mutate(c.pinned)} aria-label={c.pinned ? "Unpin" : "Pin"}>
            {c.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </Button>
          <Select className="w-32" value={c.status ?? "open"} onChange={(e) => setStatus.mutate(e.target.value)} aria-label="Conversation status" disabled={!can("inbox:send")}>
            {["open", "pending", "resolved", "closed"].map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-subtle/40 px-4 py-4">
          {msgs.isLoading ? (
            <div className="text-center">
              <Spinner />
            </div>
          ) : (
            msgs.data?.data.map((m) => <MessageBubble key={m.id} m={m} />)
          )}
          <div ref={bottom} />
        </div>

        {can("inbox:send") && (
          <div className="border-t border-border bg-surface p-3">
            {!c.windowOpen && isSocialType(c.type) ? (
              <div className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                <Clock className="h-4 w-4 shrink-0" /> {SOCIAL_LABELS[c.type]} only allows replies within 24 hours of the customer's last message{conv.data.social?.humanAgentTag ? " (7 days with the Human Agent tag)" : ""}. You can reply when they write again.
              </div>
            ) : !c.windowOpen ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4" /> The 24-hour reply window is closed. Send an approved template to restart the conversation.
                </span>
                <Button size="sm" onClick={() => setTemplateOpen(true)}>
                  Send template
                </Button>
              </div>
            ) : (
              <>
              {c.replyPolicy === "human_agent" && <p className="mb-2 text-xs text-fg-muted">Past 24 hours: replies are sent with Meta's Human Agent tag and must come from a person.</p>}
              <AiReplySuggestions key={id} conversationId={id} onPick={(t) => setText(t)} />
              <div className="flex items-end gap-2">
                {isSocialType(c.type) && (
                  <>
                    <input
                      ref={imageInput}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (!f) return;
                        if (f.size > 2 * 1024 * 1024) return toast({ title: "Image too large", description: "Use an image up to 2 MB.", variant: "error" });
                        sendImage.mutate(f);
                      }}
                    />
                    <Button variant="ghost" size="icon" onClick={() => imageInput.current?.click()} loading={sendImage.isPending} aria-label="Send an image">
                      <ImageIcon className="h-4 w-4" />
                    </Button>
                  </>
                )}
                {c.type !== "web" && !isSocialType(c.type) && (
                  <Button variant="ghost" size="icon" onClick={() => setTemplateOpen(true)} aria-label="Send a template">
                    <FileText className="h-4 w-4" />
                  </Button>
                )}
                <Textarea
                  value={text}
                  rows={1}
                  className="max-h-40 min-h-9 resize-none"
                  placeholder="Type a message — Enter to send, Shift+Enter for a new line"
                  aria-label="Message"
                  onChange={(e) => {
                    setText(e.target.value);
                    socket?.emit("user_typing", { conversationId: id });
                  }}
                  onBlur={() => socket?.emit("user_stopped_typing", { conversationId: id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
                <Button onClick={submit} loading={send.isPending} disabled={!text.trim()} aria-label="Send">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              </>
            )}
          </div>
        )}
      </div>

      <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border bg-surface p-4 xl:block">
        <div className="flex flex-col items-center gap-2 text-center">
          <Avatar name={c.contactName ?? "?"} className="h-14 w-14 text-base" />
          <p className="font-semibold">{c.contactName}</p>
          <p className="text-sm text-fg-muted">{c.contactPhone}</p>
        </div>
        {isSocialType(c.type) && conv.data.social && (
          <div className="mt-4 rounded-md bg-subtle p-3 text-xs">
            <p className="font-medium">{SOCIAL_LABELS[c.type]} · {conv.data.social.name}</p>
            <p className="mt-1 text-fg-muted">Text and image replies. {conv.data.social.simulated ? "Test connection (simulator)." : ""}</p>
          </div>
        )}
        {c.type === "web" && c.webVisitor && (
          <div className="mt-4 rounded-md bg-subtle p-3 text-xs">
            <p className="mb-1 flex items-center gap-1.5 font-medium"><Globe className="h-3.5 w-3.5" /> Website chat</p>
            {c.webVisitor.email && <p className="break-all">{c.webVisitor.email}</p>}
            {c.webVisitor.phone && <p>{c.webVisitor.phone}</p>}
            {c.webVisitor.page && <p className="mt-1 break-all text-fg-muted" title={c.webVisitor.page}>From {c.webVisitor.page.replace(/^https?:\/\//, "").slice(0, 80)}</p>}
            <p className="mt-1 text-fg-muted">Replies appear in the visitor's chat window while it's open on their site.</p>
          </div>
        )}
        <dl className="mt-6 space-y-3 text-sm">
          {contact?.email && (
            <div>
              <dt className="text-xs text-fg-muted">Email</dt>
              <dd className="break-all">{contact.email}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-fg-muted">First contact</dt>
            <dd>{formatDate(c.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Last customer message</dt>
            <dd>{c.lastIncomingMessageAt ? relativeTime(c.lastIncomingMessageAt) : "—"}</dd>
          </div>
          {!!contact?.tags?.length && (
            <div>
              <dt className="mb-1 text-xs text-fg-muted">Tags</dt>
              <dd className="flex flex-wrap gap-1">
                {contact.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </dd>
            </div>
          )}
        </dl>
        <AiInsightsPanel key={c.id} conversationId={c.id} insights={(c.aiInsights as ConversationInsights | null) ?? null} analyzedAt={c.aiAnalyzedAt ? String(c.aiAnalyzedAt) : null} />
        {can("inbox:assign") && (
          <Field label="Assigned to" htmlFor="assignee" className="mt-6">
            <Select id="assignee" value={c.assignedTo ?? ""} onChange={(e) => update.mutate({ assignedTo: e.target.value || null })}>
              <option value="">Unassigned</option>
              {assignees.data?.data.map((a) => (
                <option key={a.id} value={a.id}>
                  {[a.firstName, a.lastName].filter(Boolean).join(" ") || a.username}
                  {a.id === user!.id ? " (you)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </aside>

      <TemplateDialog open={templateOpen} onClose={() => setTemplateOpen(false)} conversationId={id} />
    </div>
  );
}

export default function InboxPage() {
  const { activeChannel } = useChannel();
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("c"));
  const { socket } = useSocket();
  const channelId = activeChannel!.id;

  useEffect(() => setSelected((s) => s), [channelId]);

  const refreshList = useMemo(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return () => {
      clearTimeout(t);
      t = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["/api/conversations"], exact: false }), 250);
    };
  }, []);

  useSocketEvent<{ conversationId: string; message: Message }>("new_message", ({ conversationId, message }) => {
    queryClient.setQueriesData<{ data: Message[] }>({ queryKey: messagesKey(conversationId) }, (old) =>
      old && !old.data.some((m) => m.id === message.id) ? { ...old, data: [...old.data, message] } : old,
    );
    if (conversationId === selected && message.direction === "inbound") socket?.emit("conversation_opened", { conversationId });
    refreshList();
  });
  useSocketEvent<{ conversationId: string; messageId: string; status: string; error?: string }>("message_status_update", (p) => {
    queryClient.setQueriesData<{ data: Message[] }>({ queryKey: messagesKey(p.conversationId) }, (old) =>
      old ? { ...old, data: old.data.map((m) => (m.id === p.messageId ? { ...m, status: p.status, errorMessage: p.error ?? m.errorMessage } : m)) } : old,
    );
  });
  useSocketEvent("conversation_updated", refreshList);
  useSocketEvent("conversation_created", refreshList);
  useSocketEvent("messages_read", refreshList);

  const select = (id: string) => {
    setSelected(id);
    history.replaceState(null, "", `?c=${id}`);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className={cn("w-full shrink-0 border-r border-border bg-surface md:w-80", selected && "hidden md:block")}>
        <ConversationList selected={selected} onSelect={select} />
      </div>
      <div className={cn("min-w-0 flex-1", !selected && "hidden md:block")}>
        {selected ? (
          <Thread key={selected} id={selected} onBack={() => setSelected(null)} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon={<MessageSquare className="h-10 w-10" />} title="Select a conversation" description="Pick a conversation on the left to read and reply." />
          </div>
        )}
      </div>
    </div>
  );
}
