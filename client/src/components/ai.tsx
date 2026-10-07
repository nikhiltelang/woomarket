import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import { AI_TONES, INTENT_LABELS, type AiStatus, type AiTone, type ConversationInsights, type DraftVariant, type EmailDraft } from "@shared/ai";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Spinner } from "@/components/ui/display";
import { Dialog, useToast } from "@/components/ui/overlay";

const STATUS_KEY = ["/api/ai/status"];

/** Whether to show AI buttons at all (hidden when the platform or the tenant's level has no AI). */
export function useAi() {
  const { user } = useAuth();
  const tenant = user?.role === "admin" || user?.role === "team";
  const { data } = useQuery<{ data: AiStatus }>({ queryKey: STATUS_KEY, enabled: tenant, staleTime: 60_000 });
  const s = data?.data;
  return { status: s, visible: Boolean(s && (s.available || s.reason === "limit")) };
}

const refreshStatus = () => void queryClient.invalidateQueries({ queryKey: STATUS_KEY });

function UsageNote({ s }: { s?: AiStatus }) {
  if (!s) return null;
  return (
    <p className="text-xs text-fg-muted">
      {s.simulated && <Badge tone="warning" className="mr-1.5">Simulator</Badge>}
      {s.limit === -1 ? `${s.used} AI requests this month` : `${Math.max(0, s.limit - s.used)} of ${s.limit} AI requests left this month`}
    </p>
  );
}

type DraftChannel = "sms" | "whatsapp" | "email_subject";
const TITLES: Record<DraftChannel, string> = { sms: "Write an SMS with AI", whatsapp: "Write a template with AI", email_subject: "Subject line ideas" };

/** "Write with AI" for campaign copy: brief → variants → pick one. */
export function AiDraftButton({ channel, current, onPick, size = "sm", label }: { channel: DraftChannel; current?: string; onPick: (v: DraftVariant) => void; size?: "sm" | "md"; label?: string }) {
  const { status, visible } = useAi();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState<AiTone>("friendly");
  const [language, setLanguage] = useState("");
  const [improve, setImprove] = useState(false);
  const gen = useMutation({
    mutationFn: () =>
      apiRequest<{ data: { variants: DraftVariant[]; simulated: boolean } }>("POST", "/api/ai/draft", {
        channel,
        brief: brief.trim() || (improve && current ? "Improve this message" : ""),
        tone,
        ...(language.trim() ? { language: language.trim() } : {}),
        ...(improve && current?.trim() ? { current } : {}),
      }),
    onSettled: refreshStatus,
    onError: (err) => toast({ title: "AI couldn't write that", description: (err as Error).message, variant: "error" }),
  });
  if (!visible) return null;
  const limited = status?.available === false;
  return (
    <>
      <Button type="button" size={size === "sm" ? "sm" : undefined} variant="outline" onClick={() => setOpen(true)} disabled={limited} title={limited ? "This month's AI requests are used up" : undefined}>
        <Sparkles className="h-3.5 w-3.5 text-primary" /> {label ?? "Write with AI"}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="lg" title={TITLES[channel]} description="Suggestions only: review before you send.">
        <div className="flex flex-col gap-4">
          <Field label="What's it about?" htmlFor={`ai-brief-${channel}`} hint="Offer, audience, deadline, anything the message must mention.">
            <Textarea id={`ai-brief-${channel}`} rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={1500} placeholder="Diwali sale: 30% off all kurtas until Sunday, free shipping over ₹999" autoFocus />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tone" htmlFor={`ai-tone-${channel}`}>
              <Select id={`ai-tone-${channel}`} value={tone} onChange={(e) => setTone(e.target.value as AiTone)}>
                {AI_TONES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
              </Select>
            </Field>
            <Field label="Language (optional)" htmlFor={`ai-lang-${channel}`}>
              <Input id={`ai-lang-${channel}`} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Same as the brief" maxLength={40} />
            </Field>
          </div>
          {current?.trim() && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={improve} onChange={(e) => setImprove(e.target.checked)} className="accent-[var(--color-primary)]" /> Improve my current text instead of starting fresh
            </label>
          )}
          <div className="flex items-center justify-between gap-3">
            <UsageNote s={status} />
            <Button onClick={() => gen.mutate()} loading={gen.isPending} disabled={brief.trim().length < 3 && !(improve && current?.trim())}>
              <Sparkles className="h-4 w-4" /> {gen.data ? "Try again" : "Generate"}
            </Button>
          </div>
          {gen.data && (
            <ul className="flex flex-col gap-2">
              {gen.data.data.variants.map((v, i) => (
                <li key={i} className="flex items-start gap-3 rounded-md border border-border p-3">
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="whitespace-pre-wrap">{v.text}</p>
                    {v.preview && <p className="mt-1 text-xs text-fg-muted">Preview: {v.preview}</p>}
                    {v.note && <p className="mt-1 text-xs text-fg-muted">{v.note}</p>}
                  </div>
                  <Button size="sm" onClick={() => { onPick(v); setOpen(false); }}>Use</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
    </>
  );
}

/** Email body draft, returned as headline + paragraphs + button for the builder. */
export function AiEmailDraftButton({ onDraft }: { onDraft: (d: EmailDraft) => void }) {
  const { status, visible } = useAi();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState<AiTone>("friendly");
  const gen = useMutation({
    mutationFn: () => apiRequest<{ data: { email: EmailDraft; simulated: boolean } }>("POST", "/api/ai/draft", { channel: "email_body", brief, tone }),
    onSuccess: (r) => {
      onDraft(r.data.email);
      setOpen(false);
      toast({ title: "Draft added to the builder", description: "Edit the blocks, add images and set the button link.", variant: "success" });
    },
    onSettled: refreshStatus,
    onError: (err) => toast({ title: "AI couldn't write that", description: (err as Error).message, variant: "error" }),
  });
  if (!visible) return null;
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} disabled={status?.available === false}>
        <Sparkles className="h-4 w-4 text-primary" /> Draft with AI
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Draft the email with AI"
        description="Replaces the current design with a headline, text and a button."
        footer={
          <Button onClick={() => gen.mutate()} loading={gen.isPending} disabled={brief.trim().length < 3}>
            <Sparkles className="h-4 w-4" /> Write draft
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="What's the email about?" htmlFor="ai-email-brief">
            <Textarea id="ai-email-brief" rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={1500} placeholder="Launching our monsoon collection on 1 July. Early access for subscribers, code RAIN10 for 10% off." autoFocus />
          </Field>
          <Field label="Tone" htmlFor="ai-email-tone">
            <Select id="ai-email-tone" value={tone} onChange={(e) => setTone(e.target.value as AiTone)}>
              {AI_TONES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </Select>
          </Field>
          <UsageNote s={status} />
        </div>
      </Dialog>
    </>
  );
}

/** Reply chips above the inbox composer. */
export function AiReplySuggestions({ conversationId, onPick }: { conversationId: string; onPick: (text: string) => void }) {
  const { visible, status } = useAi();
  const toast = useToast();
  const gen = useMutation({
    mutationFn: () => apiRequest<{ data: { replies: string[]; simulated: boolean } }>("POST", `/api/ai/conversations/${conversationId}/replies`, {}),
    onSettled: refreshStatus,
    onError: (err) => toast({ title: "No suggestions", description: (err as Error).message, variant: "error" }),
  });
  if (!visible) return null;
  const replies = gen.data?.data.replies ?? [];
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant="ghost" onClick={() => gen.mutate()} loading={gen.isPending} disabled={status?.available === false}>
        <Sparkles className="h-3.5 w-3.5 text-primary" /> {replies.length ? "More ideas" : "Suggest replies"}
      </Button>
      {replies.map((r, i) => (
        <button key={i} type="button" onClick={() => onPick(r)} className="max-w-full truncate rounded-full border border-border bg-subtle px-3 py-1 text-left text-xs hover:border-primary hover:text-primary sm:max-w-xs" title={r}>
          {r}
        </button>
      ))}
    </div>
  );
}

const SENTIMENT_TONE = { positive: "success", neutral: "neutral", negative: "danger", mixed: "warning" } as const;
const URGENCY_TONE = { low: "neutral", medium: "info", high: "danger" } as const;

export function IntentBadge({ insights, className }: { insights: Partial<ConversationInsights> | null | undefined; className?: string }) {
  if (!insights?.intent) return null;
  return <Badge tone={SENTIMENT_TONE[insights.sentiment ?? "neutral"]} className={cn("text-[10px]", className)}>{INTENT_LABELS[insights.intent]}</Badge>;
}

/** Summary, sentiment and intent in the inbox side panel. */
export function AiInsightsPanel({ conversationId, insights, analyzedAt }: { conversationId: string; insights: ConversationInsights | null; analyzedAt: string | null }) {
  const { visible, status } = useAi();
  const toast = useToast();
  const run = useMutation({
    mutationFn: () => apiRequest<{ data: { insights: ConversationInsights } }>("POST", `/api/ai/conversations/${conversationId}/insights`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [`/api/conversations/${conversationId}`] }),
    onSettled: refreshStatus,
    onError: (err) => toast({ title: "Couldn't analyse", description: (err as Error).message, variant: "error" }),
  });
  if (!visible) return null;
  const i = run.data?.data.insights ?? insights;
  return (
    <section className="mt-6 border-t border-border pt-4" aria-labelledby="ai-insights">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id="ai-insights" className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="h-4 w-4 text-primary" /> AI summary</h3>
        <Button size="sm" variant="ghost" onClick={() => run.mutate()} loading={run.isPending} disabled={status?.available === false} aria-label={i ? "Refresh summary" : "Summarise"}>
          {i ? <RefreshCw className="h-3.5 w-3.5" /> : "Summarise"}
        </Button>
      </div>
      {run.isPending && !i ? (
        <Spinner />
      ) : i ? (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-1">
            <Badge tone={SENTIMENT_TONE[i.sentiment]}>{i.sentiment}</Badge>
            <Badge tone="info">{INTENT_LABELS[i.intent]}</Badge>
            <Badge tone={URGENCY_TONE[i.urgency]}>{i.urgency} urgency</Badge>
          </div>
          <p>{i.summary}</p>
          {i.keyPoints.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-fg-muted">
              {i.keyPoints.map((k, n) => <li key={n}>{k}</li>)}
            </ul>
          )}
          {i.nextSteps.length > 0 && (
            <div>
              <p className="text-xs font-medium">Next steps</p>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-fg-muted">
                {i.nextSteps.map((k, n) => <li key={n}>{k}</li>)}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-fg-muted">
            {i.language ? `${i.language} · ` : ""}
            {i.messageCount} messages · {analyzedAt && !run.data ? `updated ${relativeTime(analyzedAt)}` : "just now"}
          </p>
        </div>
      ) : (
        <p className="text-xs text-fg-muted">Summarise the conversation and detect the customer's sentiment, intent and urgency.</p>
      )}
    </section>
  );
}
