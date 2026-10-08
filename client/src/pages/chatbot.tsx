import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Bot, Hand, Pencil, Plus, Send, Sparkles, Trash2, X } from "lucide-react";
import {
  BOT_CHANNEL_LABELS,
  BOT_CHANNELS,
  TRIGGER_LABELS,
  TRIGGER_TYPES,
  WEEKDAYS,
  type BotChannel,
  type BotResponse,
  type BotSettings,
  type RuleInput,
  type Trigger,
  type TriggerType,
  type Weekday,
} from "@shared/chatbot";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, PageHeader, PageLoader } from "@/components/ui/display";
import { Dialog, Tabs, useConfirm, useToast } from "@/components/ui/overlay";

const KEY = ["/api/chatbot"];

interface StoredRule extends Omit<RuleInput, "actions"> {
  id: string;
  priority: number;
  actions: Partial<RuleInput["actions"]> | null;
  timesTriggered: number;
  lastTriggeredAt: string | null;
}
interface Overview {
  settings: BotSettings;
  timezone: string;
  rules: StoredRule[];
}
interface Assignee {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
}
interface BotEvent {
  id: string;
  conversationId: string | null;
  ruleName: string | null;
  contactName: string | null;
  channel: BotChannel;
  outcome: "replied" | "handoff" | "skipped" | "failed";
  detail: string | null;
  incomingText: string | null;
  createdAt: string;
}

const RESPONSE_LABELS: Record<BotResponse["type"], string> = { text: "Text message", buttons: "Message with buttons (up to 3)", list: "Message with a list (up to 10)", ai: "AI answer from your knowledge" };
const DAY_LABELS: Record<Weekday, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
const OUTCOME_TONE = { replied: "success", handoff: "info", skipped: "neutral", failed: "danger" } as const;

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "option";
const memberName = (a: Assignee) => [a.firstName, a.lastName].filter(Boolean).join(" ") || a.username;

function describeTrigger(t: Trigger): string {
  if (t.type === "keyword") return `${t.match === "exact" ? "Is exactly" : t.match === "starts_with" ? "Starts with" : "Contains"} ${t.keywords.map((k) => `“${k}”`).join(", ")}`;
  if (t.type === "button") return `Taps the option “${t.buttonId}”`;
  return TRIGGER_LABELS[t.type];
}

export default function ChatbotPage() {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const manage = can("settings:edit");
  const { data, isLoading } = useQuery<{ data: Overview }>({ queryKey: KEY });
  const [tab, setTab] = useState<"rules" | "settings" | "activity">("rules");
  const [editing, setEditing] = useState<StoredRule | "new" | null>(null);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const fail = (title: string) => (err: unknown) => toast({ title, description: (err as Error).message, variant: "error" });

  const saveSettings = useMutation({
    mutationFn: (s: BotSettings) => apiRequest("PUT", "/api/chatbot/settings", s),
    onSuccess: invalidate,
    onError: fail("Could not save"),
  });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => apiRequest("PATCH", `/api/chatbot/rules/${id}`, { enabled }), onSuccess: invalidate, onError: fail("Could not update") });
  const remove = useMutation({ mutationFn: (id: string) => apiRequest("DELETE", `/api/chatbot/rules/${id}`), onSuccess: invalidate });
  const reorder = useMutation({ mutationFn: (ids: string[]) => apiRequest("PUT", "/api/chatbot/rules/order", { ids }), onSuccess: invalidate });
  const starters = useMutation({
    mutationFn: async () => {
      for (const r of STARTER_RULES) await apiRequest("POST", "/api/chatbot/rules", r);
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Starter rules added", description: "Edit the texts to match your business, then turn the bot on.", variant: "success" });
    },
    onError: fail("Could not add the starter rules"),
  });

  if (isLoading || !data) return <PageLoader />;
  const { settings, rules, timezone } = data.data;
  const move = (i: number, dir: -1 | 1) => {
    const ids = rules.map((r) => r.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    reorder.mutate(ids);
  };

  return (
    <PageContainer>
      <PageHeader
        title="Chatbot & auto-replies"
        description="Answer common questions instantly on WhatsApp, Messenger, Instagram and website chat, and hand over to your team when needed."
        actions={
          <div className="flex items-center gap-3">
            <Switch label={settings.enabled ? "Bot is on" : "Bot is off"} checked={settings.enabled} disabled={!manage || saveSettings.isPending} onChange={(enabled) => saveSettings.mutate({ ...settings, enabled })} />
            {manage && <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> New rule</Button>}
          </div>
        }
      />
      <div className="mb-4">
        <Tabs value={tab} onChange={setTab} tabs={[{ value: "rules", label: `Rules (${rules.length})` }, { value: "settings", label: "Business hours & pauses" }, { value: "activity", label: "Activity" }]} />
      </div>

      {tab === "rules" && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Card>
            {rules.length === 0 ? (
              <EmptyState
                icon={<Bot className="h-10 w-10" />}
                title="No rules yet"
                description="Rules decide what the bot says. Start with a welcome menu, an away message and a hand-off to your team."
                action={manage && (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => starters.mutate()} loading={starters.isPending}><Sparkles className="h-4 w-4" /> Add starter rules</Button>
                    <Button variant="outline" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Blank rule</Button>
                  </div>
                )}
              />
            ) : (
              <>
                <p className="border-b border-border px-5 py-3 text-xs text-fg-muted">
                  One rule answers each message. Button taps are checked first, then keywords, then the welcome (first message), the away message (outside business hours) and finally the fallback. Within each kind, the higher rule wins.
                </p>
                <ul className="divide-y divide-border">
                  {rules.map((r, i) => (
                    <li key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          {r.name}
                          {!r.enabled && <Badge>Off</Badge>}
                          {r.response.type === "ai" && <Badge tone="info">AI</Badge>}
                          {r.actions?.handoff && <Badge tone="warning">Hands off</Badge>}
                        </p>
                        <p className="mt-0.5 text-sm text-fg-muted">{describeTrigger(r.trigger)}</p>
                        <p className="mt-1 line-clamp-2 text-sm">{r.response.type === "ai" ? "Answers from your knowledge with AI" : r.response.text}</p>
                        {(r.response.type === "buttons" || r.response.type === "list") && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {(r.response.type === "buttons" ? r.response.buttons : r.response.rows).map((b) => <span key={b.id} className="rounded-full border border-border px-2 py-0.5 text-xs">{b.title}</span>)}
                          </div>
                        )}
                        <p className="mt-1.5 text-xs text-fg-muted">
                          {r.channels.map((c) => BOT_CHANNEL_LABELS[c]).join(", ")} · used {r.timesTriggered} time{r.timesTriggered === 1 ? "" : "s"}
                          {r.lastTriggeredAt ? `, last ${formatDate(r.lastTriggeredAt)}` : ""}
                        </p>
                      </div>
                      {manage && (
                        <div className="flex items-center gap-1">
                          <Switch label={<span className="sr-only">Rule on</span>} checked={r.enabled} onChange={(enabled) => toggle.mutate({ id: r.id, enabled })} />
                          <Button size="icon" variant="ghost" aria-label="Move up" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" aria-label="Move down" disabled={i === rules.length - 1 || reorder.isPending} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" aria-label={`Delete ${r.name}`} onClick={async () => { if (await confirm({ title: `Delete “${r.name}”?`, confirmText: "Delete", destructive: true })) remove.mutate(r.id); }}>
                            <Trash2 className="h-4 w-4 text-danger" />
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
          <TestConsole rules={rules} botEnabled={settings.enabled} />
        </div>
      )}

      {tab === "settings" && <SettingsForm settings={settings} timezone={timezone} disabled={!manage} />}
      {tab === "activity" && <Activity />}

      {editing && <RuleDialog rule={editing === "new" ? null : editing} rules={rules} onClose={() => setEditing(null)} />}
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Rule editor
// ---------------------------------------------------------------------------

const ALL_CHANNELS = [...BOT_CHANNELS];

function blankResponse(type: BotResponse["type"], text = ""): BotResponse {
  if (type === "buttons") return { type, text, buttons: [{ id: "", title: "" }] };
  if (type === "list") return { type, text, button: "See options", rows: [{ id: "", title: "" }] };
  if (type === "ai") return { type, knowledge: "", unsureText: "Let me get a teammate to help you with that." };
  return { type, text };
}

function blankTrigger(type: TriggerType): Trigger {
  if (type === "keyword") return { type, keywords: [], match: "contains" };
  if (type === "button") return { type, buttonId: "" };
  return { type } as Trigger;
}

function RuleDialog({ rule, rules, onClose }: { rule: StoredRule | null; rules: StoredRule[]; onClose: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const assignees = useQuery<{ data: Assignee[] }>({ queryKey: ["/api/team/assignees"], enabled: can("inbox:view") || can("team:view") });
  const [v, setV] = useState<RuleInput>(() =>
    rule
      ? { name: rule.name, enabled: rule.enabled, channels: rule.channels, trigger: rule.trigger, response: rule.response, cooldownMinutes: rule.cooldownMinutes, actions: { addTags: rule.actions?.addTags ?? [], assignTo: rule.actions?.assignTo ?? null, handoff: rule.actions?.handoff ?? false } }
      : { name: "", enabled: true, channels: ALL_CHANNELS, trigger: blankTrigger("keyword"), response: blankResponse("text"), cooldownMinutes: 0, actions: { addTags: [], assignTo: null, handoff: false } },
  );
  const [keywords, setKeywords] = useState(v.trigger.type === "keyword" ? v.trigger.keywords.join(", ") : "");
  const [tags, setTags] = useState(v.actions.addTags.join(", "));
  // Options offered by other rules, for "customer taps a button".
  const knownOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rules) {
      if (r.response.type === "buttons") r.response.buttons.forEach((b) => seen.set(b.id, `${b.title} (${r.name})`));
      if (r.response.type === "list") r.response.rows.forEach((b) => seen.set(b.id, `${b.title} (${r.name})`));
    }
    return [...seen.entries()];
  }, [rules]);

  const build = (): RuleInput => {
    const trigger = v.trigger.type === "keyword" ? { ...v.trigger, keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean) } : v.trigger;
    let response = v.response;
    // Options without an id get one from their title.
    if (response.type === "buttons") response = { ...response, buttons: response.buttons.map((b) => ({ ...b, id: b.id || slug(b.title) })) };
    if (response.type === "list") response = { ...response, rows: response.rows.map((b) => ({ ...b, id: b.id || slug(b.title), description: b.description || undefined })) };
    return { ...v, trigger, response, actions: { ...v.actions, addTags: tags.split(",").map((t) => t.trim()).filter(Boolean), assignTo: v.actions.assignTo || null } };
  };
  const save = useMutation({
    mutationFn: () => apiRequest(rule ? "PUT" : "POST", rule ? `/api/chatbot/rules/${rule.id}` : "/api/chatbot/rules", build()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      toast({ title: rule ? "Rule saved" : "Rule added", variant: "success" });
      onClose();
    },
    onError: (err) => toast({ title: "Could not save the rule", description: (err as Error).message, variant: "error" }),
  });

  const r = v.response;
  const setResponse = (patch: Partial<BotResponse>) => setV({ ...v, response: { ...r, ...patch } as BotResponse });
  const options = r.type === "buttons" ? r.buttons : r.type === "list" ? r.rows : [];
  const setOptions = (next: { id: string; title: string; description?: string }[]) => setResponse(r.type === "buttons" ? { buttons: next } : { rows: next });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={rule ? `Edit “${rule.name}”` : "New rule"}
      footer={<Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.name.trim() || !v.channels.length}>{rule ? "Save rule" : "Add rule"}</Button>}
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="rule-name" required><Input id="rule-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Opening hours" maxLength={100} /></Field>
          <Field label="Answer again after" htmlFor="rule-cool">
            <Select id="rule-cool" value={v.cooldownMinutes} onChange={(e) => setV({ ...v, cooldownMinutes: Number(e.target.value) })}>
              {[[0, "Every time"], [10, "10 minutes"], [60, "1 hour"], [240, "4 hours"], [1440, "1 day"], [10080, "1 week"]].map(([m, l]) => <option key={m} value={m}>{l}</option>)}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Answers on</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {BOT_CHANNELS.map((c) => <Checkbox key={c} label={BOT_CHANNEL_LABELS[c]} checked={v.channels.includes(c)} onChange={(on) => setV({ ...v, channels: on ? [...v.channels, c] : v.channels.filter((x) => x !== c) })} />)}
          </div>
        </fieldset>

        <section className="flex flex-col gap-3 rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold">When</h3>
          <Select aria-label="Trigger" value={v.trigger.type} onChange={(e) => setV({ ...v, trigger: blankTrigger(e.target.value as TriggerType) })}>
            {TRIGGER_TYPES.map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
          </Select>
          {v.trigger.type === "keyword" && (
            <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
              <Select aria-label="Match" value={v.trigger.match} onChange={(e) => setV({ ...v, trigger: { ...(v.trigger as Extract<Trigger, { type: "keyword" }>), match: e.target.value as "contains" } })}>
                <option value="contains">Contains</option>
                <option value="exact">Is exactly</option>
                <option value="starts_with">Starts with</option>
              </Select>
              <Field hint="Separate keywords with commas. Not case-sensitive; “contains” matches whole words."><Input aria-label="Keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="hours, open, timings" /></Field>
            </div>
          )}
          {v.trigger.type === "button" && (
            <Field hint="The option's id, from a buttons or list reply in another rule.">
              <Input aria-label="Option id" list="known-options" value={v.trigger.buttonId} onChange={(e) => setV({ ...v, trigger: { type: "button", buttonId: e.target.value.trim() } })} placeholder="pricing" />
              <datalist id="known-options">{knownOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</datalist>
            </Field>
          )}
          {v.trigger.type === "first_message" && <p className="text-xs text-fg-muted">A brand-new chat, or a customer writing again after 24 hours of silence.</p>}
          {v.trigger.type === "outside_hours" && <p className="text-xs text-fg-muted">Uses the business hours under “Business hours & pauses”.</p>}
          {v.trigger.type === "fallback" && <p className="text-xs text-fg-muted">Answers when no other rule matched. Tip: pair it with a hand-off so a teammate follows up.</p>}
        </section>

        <section className="flex flex-col gap-3 rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold">Reply with</h3>
          <Select aria-label="Reply type" value={r.type} onChange={(e) => setV({ ...v, response: blankResponse(e.target.value as BotResponse["type"], "text" in r ? r.text : "") })}>
            {(Object.keys(RESPONSE_LABELS) as BotResponse["type"][]).map((t) => <option key={t} value={t}>{RESPONSE_LABELS[t]}</option>)}
          </Select>
          {r.type !== "ai" && (
            <Field label="Message" htmlFor="rule-text" hint={r.type === "text" ? undefined : "Website chat shows the options as a numbered list; Messenger and Instagram as quick replies."}>
              <Textarea id="rule-text" rows={3} value={r.text} onChange={(e) => setResponse({ text: e.target.value })} maxLength={r.type === "text" ? 4096 : 1024} />
            </Field>
          )}
          {r.type === "list" && <Field label="List button label" htmlFor="rule-lb"><Input id="rule-lb" value={r.button} onChange={(e) => setResponse({ button: e.target.value })} maxLength={20} /></Field>}
          {(r.type === "buttons" || r.type === "list") && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{r.type === "buttons" ? "Buttons" : "List items"}</p>
              {options.map((o, i) => (
                <div key={i} className="grid grid-cols-[1fr_140px_auto] gap-2">
                  <Input aria-label={`Option ${i + 1} title`} value={o.title} maxLength={r.type === "buttons" ? 20 : 24} placeholder="Title" onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                  <Input aria-label={`Option ${i + 1} id`} value={o.id} placeholder={slug(o.title) || "id"} className="font-mono text-xs" onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, id: e.target.value.trim() } : x)))} />
                  <Button size="icon" variant="ghost" aria-label="Remove option" disabled={options.length === 1} onClick={() => setOptions(options.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
                </div>
              ))}
              {options.length < (r.type === "buttons" ? 3 : 10) && <Button size="sm" variant="outline" className="self-start" onClick={() => setOptions([...options, { id: "", title: "" }])}><Plus className="h-3.5 w-3.5" /> Add</Button>}
              <p className="text-xs text-fg-muted">Each option has an id; add a “Customer taps a button” rule with that id to answer it.</p>
            </div>
          )}
          {r.type === "ai" && (
            <>
              <Field label="What the AI may answer from" htmlFor="rule-kb" hint="Opening hours, prices, delivery areas, policies… The AI answers only from this text and hands off when it can't.">
                <Textarea id="rule-kb" rows={7} value={r.knowledge} onChange={(e) => setResponse({ knowledge: e.target.value })} maxLength={8000} placeholder={"We're open Monday to Saturday, 10am to 8pm.\nDelivery is free over ₹999 and takes 2-4 days.\nReturns are accepted within 14 days."} />
              </Field>
              <Field label="When the AI can't answer" htmlFor="rule-unsure" hint="Sent before handing the chat to your team."><Input id="rule-unsure" value={r.unsureText} onChange={(e) => setResponse({ unsureText: e.target.value })} maxLength={1024} /></Field>
            </>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold">Also</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Add tags" htmlFor="rule-tags" hint="Comma-separated"><Input id="rule-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="lead, pricing" /></Field>
            <Field label="Assign to" htmlFor="rule-assign">
              <Select id="rule-assign" value={v.actions.assignTo ?? ""} onChange={(e) => setV({ ...v, actions: { ...v.actions, assignTo: e.target.value || null } })}>
                <option value="">Nobody</option>
                {(assignees.data?.data ?? []).map((a) => <option key={a.id} value={a.id}>{memberName(a)}</option>)}
              </Select>
            </Field>
          </div>
          <Checkbox label="Hand off to the team (the bot stops answering this chat)" checked={v.actions.handoff} onChange={(handoff) => setV({ ...v, actions: { ...v.actions, handoff } })} />
        </section>
        <Switch label="Rule is on" checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Test console
// ---------------------------------------------------------------------------

interface TestResult {
  botEnabled: boolean;
  outsideHours: boolean;
  timezone: string;
  matched: null | {
    ruleId: string;
    name: string;
    reason: TriggerType;
    reply: { text: string; options: { id: string; title: string }[] };
    handoff: boolean;
    addTags: string[];
    ai: { simulated: boolean; answered: boolean; error?: string } | null;
  };
}

function TestConsole({ rules, botEnabled }: { rules: StoredRule[]; botEnabled: boolean }) {
  const toast = useToast();
  const [channel, setChannel] = useState<BotChannel>("whatsapp");
  const [text, setText] = useState("");
  const [firstMessage, setFirstMessage] = useState(false);
  const [log, setLog] = useState<{ from: "customer" | "bot" | "note"; text: string; options?: { id: string; title: string }[] }[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log.length]);
  const run = useMutation({
    mutationFn: (input: { text: string; buttonId?: string; label: string }) => apiRequest<{ data: TestResult }>("POST", "/api/chatbot/test", { channel, text: input.text, buttonId: input.buttonId, firstMessage }),
    onMutate: (input) => setLog((l) => [...l, { from: "customer", text: input.label }]),
    onSuccess: (r) => {
      const m = r.data.matched;
      setFirstMessage(false);
      if (!m) return setLog((l) => [...l, { from: "note", text: "No rule matched: the bot stays quiet." }]);
      const notes = [`Rule “${m.name}” (${m.reason.replace("_", " ")})`, m.ai?.simulated ? "simulated AI" : null, m.ai?.error ? `AI error: ${m.ai.error}` : null, m.handoff ? "hands off to the team" : null, m.addTags.length ? `tags: ${m.addTags.join(", ")}` : null].filter(Boolean);
      setLog((l) => [...l, { from: "bot", text: m.reply.text, options: m.reply.options }, { from: "note", text: notes.join(" · ") }]);
    },
    onError: (err) => toast({ title: "Test failed", description: (err as Error).message, variant: "error" }),
  });
  const send = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!text.trim() && !firstMessage) return;
    run.mutate({ text: text.trim(), label: text.trim() || "(opens the chat)" });
    setText("");
  };

  return (
    <Card className="flex flex-col self-start">
      <CardHeader title="Try it" description="Nothing is sent: see which rule answers and what it says." />
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <Select aria-label="Channel" className="w-36" value={channel} onChange={(e) => setChannel(e.target.value as BotChannel)}>
          {BOT_CHANNELS.map((c) => <option key={c} value={c}>{BOT_CHANNEL_LABELS[c]}</option>)}
        </Select>
        <Checkbox label="New chat" checked={firstMessage} onChange={setFirstMessage} />
        {log.length > 0 && <Button size="sm" variant="ghost" onClick={() => setLog([])}>Clear</Button>}
      </div>
      <div ref={box} className="flex min-h-56 max-h-[420px] flex-col gap-2 overflow-y-auto bg-subtle/50 p-4" aria-live="polite">
        {log.length === 0 && <p className="m-auto text-center text-xs text-fg-muted">{rules.length ? "Type a message a customer might send." : "Add a rule first."}{!botEnabled && <><br />The bot is off: tests still work.</>}</p>}
        {log.map((m, i) =>
          m.from === "note" ? (
            <p key={i} className="text-center text-[11px] text-fg-muted">{m.text}</p>
          ) : (
            <div key={i} className={m.from === "customer" ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-fg" : "max-w-[85%] rounded-lg border border-border bg-surface px-3 py-2 text-sm"}>
              <p className="whitespace-pre-wrap">{m.text}</p>
              {m.options && m.options.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {m.options.map((o) => (
                    <button key={o.id} type="button" className="rounded border border-border px-2 py-1 text-xs text-primary hover:bg-subtle" onClick={() => run.mutate({ text: o.title, buttonId: o.id, label: o.title })}>
                      {o.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
      </div>
      <form onSubmit={send} className="flex gap-2 border-t border-border p-3">
        <Input aria-label="Test message" value={text} onChange={(e) => setText(e.target.value)} placeholder="What time do you open?" maxLength={1000} />
        <Button type="submit" size="icon" aria-label="Send test message" loading={run.isPending} disabled={!text.trim() && !firstMessage}><Send className="h-4 w-4" /></Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsForm({ settings, timezone, disabled }: { settings: BotSettings; timezone: string; disabled: boolean }) {
  const toast = useToast();
  const [v, setV] = useState(settings);
  const save = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/chatbot/settings", v),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      toast({ title: "Saved", variant: "success" });
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  const setDay = (d: Weekday, ranges: { start: string; end: string }[]) => setV({ ...v, hours: { ...v.hours, [d]: ranges } });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Business hours" description={`Outside these hours, the “outside business hours” rule answers. Time zone: ${timezone}.`} />
        <div className="flex flex-col gap-3 p-5">
          {(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as Weekday[]).map((d) => {
            const ranges = v.hours[d] ?? [];
            const open = ranges.length > 0;
            return (
              <div key={d} className="flex flex-wrap items-center gap-3">
                <span className="w-24 text-sm">{DAY_LABELS[d]}</span>
                <Switch label={<span className="sr-only">{DAY_LABELS[d]} open</span>} checked={open} disabled={disabled} onChange={(on) => setDay(d, on ? [{ start: "09:00", end: "18:00" }] : [])} />
                {open ? (
                  ranges.map((r, i) => (
                    <span key={i} className="flex items-center gap-1 text-sm">
                      <Input type="time" aria-label={`${DAY_LABELS[d]} opens`} className="w-36" value={r.start} disabled={disabled} onChange={(e) => setDay(d, ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                      to
                      <Input type="time" aria-label={`${DAY_LABELS[d]} closes`} className="w-36" value={r.end} disabled={disabled} onChange={(e) => setDay(d, ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-fg-muted">Closed</span>
                )}
              </div>
            );
          })}
          <Field label="Time zone" htmlFor="bot-tz" hint="Leave empty to use the time zone from your sending settings." className="mt-2 max-w-xs">
            <Input id="bot-tz" value={v.timezone} disabled={disabled} onChange={(e) => setV({ ...v, timezone: e.target.value })} placeholder={timezone} list="tz-list" />
            <datalist id="tz-list">{(Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone").map((z) => <option key={z} value={z} />)}</datalist>
          </Field>
        </div>
      </Card>
      <Card className="self-start">
        <CardHeader title="When people take over" />
        <div className="flex flex-col gap-4 p-5">
          <Field label="After a teammate replies, keep the bot quiet for" htmlFor="bot-pause" hint="So the bot doesn't interrupt a conversation a person is having.">
            <Select id="bot-pause" value={v.pauseAfterAgentMinutes} disabled={disabled} onChange={(e) => setV({ ...v, pauseAfterAgentMinutes: Number(e.target.value) })}>
              {[[0, "Don't pause"], [30, "30 minutes"], [60, "1 hour"], [240, "4 hours"], [720, "12 hours"], [1440, "24 hours"]].map(([m, l]) => <option key={m} value={m}>{l}</option>)}
            </Select>
          </Field>
          <Field label="After a hand-off, the bot stays quiet for" htmlFor="bot-handoff" hint="Teammates can resume the bot earlier from the inbox.">
            <Select id="bot-handoff" value={v.handoffHours} disabled={disabled} onChange={(e) => setV({ ...v, handoffHours: Number(e.target.value) })}>
              {[[4, "4 hours"], [12, "12 hours"], [24, "24 hours"], [72, "3 days"], [168, "1 week"]].map(([m, l]) => <option key={m} value={m}>{l}</option>)}
            </Select>
          </Field>
          <p className="flex gap-2 rounded-md bg-subtle p-3 text-xs text-fg-muted"><Hand className="h-4 w-4 shrink-0" /> The bot also stops if it answers {6} times within 2 minutes, which usually means another bot is on the other side.</p>
          {!disabled && <Button className="self-start" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function Activity() {
  const { data, isLoading } = useQuery<{ data: BotEvent[] }>({ queryKey: ["/api/chatbot/events"], refetchInterval: 15_000 });
  if (isLoading) return <PageLoader />;
  const rows = data?.data ?? [];
  return (
    <Card>
      {rows.length === 0 ? (
        <EmptyState icon={<Bot className="h-10 w-10" />} title="No activity yet" description="When the bot is on, each message it answers (or skips) shows up here." />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((e) => (
            <li key={e.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
              <span className="w-36 shrink-0 text-xs text-fg-muted">{formatDate(e.createdAt)}</span>
              <Badge tone={OUTCOME_TONE[e.outcome]} className="w-20 justify-center">{e.outcome}</Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  <span className="font-medium">{e.contactName ?? "Customer"}</span> <span className="text-fg-muted">on {BOT_CHANNEL_LABELS[e.channel] ?? e.channel}:</span> “{e.incomingText}”
                </p>
                <p className="truncate text-xs text-fg-muted">{e.detail}</p>
              </div>
              {e.conversationId && <a href={`/inbox?c=${e.conversationId}`} className="text-xs text-primary hover:underline">Open chat</a>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Starter rules
// ---------------------------------------------------------------------------

const STARTER_RULES: RuleInput[] = [
  {
    name: "Welcome menu",
    enabled: true,
    channels: ALL_CHANNELS,
    trigger: { type: "first_message" },
    response: { type: "buttons", text: "Hi! 👋 Thanks for reaching out. How can we help?", buttons: [{ id: "hours", title: "Opening hours" }, { id: "pricing", title: "Prices" }, { id: "agent", title: "Talk to a person" }] },
    actions: { addTags: [], assignTo: null, handoff: false },
    cooldownMinutes: 0,
  },
  {
    name: "Opening hours",
    enabled: true,
    channels: ALL_CHANNELS,
    trigger: { type: "button", buttonId: "hours" },
    response: { type: "text", text: "We're open Monday to Friday, 9am to 6pm." },
    actions: { addTags: [], assignTo: null, handoff: false },
    cooldownMinutes: 0,
  },
  {
    name: "Opening hours (typed)",
    enabled: true,
    channels: ALL_CHANNELS,
    trigger: { type: "keyword", keywords: ["hours", "timings", "open", "close"], match: "contains" },
    response: { type: "text", text: "We're open Monday to Friday, 9am to 6pm." },
    actions: { addTags: [], assignTo: null, handoff: false },
    cooldownMinutes: 0,
  },
  {
    name: "Prices",
    enabled: true,
    channels: ALL_CHANNELS,
    trigger: { type: "button", buttonId: "pricing" },
    response: { type: "text", text: "You'll find our prices at https://example.com/pricing. Want a teammate to help you choose?" },
    actions: { addTags: ["pricing"], assignTo: null, handoff: false },
    cooldownMinutes: 0,
  },
  {
    name: "Talk to a person",
    enabled: true,
    channels: ALL_CHANNELS,
    trigger: { type: "button", buttonId: "agent" },
    response: { type: "text", text: "Sure! A teammate will reply here shortly." },
    actions: { addTags: [], assignTo: null, handoff: true },
    cooldownMinutes: 0,
  },
  {
    name: "Away message",
    enabled: true,
    channels: ALL_CHANNELS,
    trigger: { type: "outside_hours" },
    response: { type: "text", text: "Thanks for your message! We're closed right now and will reply when we're back (Mon–Fri, 9am–6pm)." },
    actions: { addTags: [], assignTo: null, handoff: false },
    cooldownMinutes: 240,
  },
];
