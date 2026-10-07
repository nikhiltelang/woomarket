import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ExternalLink, Eye, EyeOff, ImagePlus, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import {
  DEFAULT_LANDING,
  LANDING_ICONS,
  newSection,
  SECTION_TYPES,
  type LandingPage,
  type LandingSection,
  type LandingSectionType,
} from "@shared/landing";
import { apiRequest, queryClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Badge, Card, CardHeader, PageHeader, PageLoader } from "@/components/ui/display";
import { Tabs, useConfirm, useToast } from "@/components/ui/overlay";
import { ICONS, LandingView, type LandingPlan } from "@/components/landing";

const KEY = "/api/superadmin/landing-page";

/** JSON with sorted keys: saved copies come back with keys in a different order, which isn't a change. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : val,
  );
type Link2 = { label: string; href: string };

// ---------------------------------------------------------------------------
// Small editing helpers
// ---------------------------------------------------------------------------

function T({ label, value, onChange, rows, placeholder, hint, max }: { label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; hint?: string; max?: number }) {
  const id = useMemo(() => `f-${Math.random().toString(36).slice(2, 9)}`, []);
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      {rows ? (
        <Textarea id={id} rows={rows} value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

function LinkEditor({ label, value, onChange }: { label: string; value: Link2; onChange: (v: Link2) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <T label={`${label} text`} value={value.label} max={60} onChange={(v) => onChange({ ...value, label: v })} />
      <T label={`${label} link`} value={value.href} max={500} placeholder="/signup, #pricing or https://…" onChange={(v) => onChange({ ...value, href: v })} />
    </div>
  );
}

/** Repeating items (features, steps, FAQ…) with add, remove and reorder. */
function ItemList<I>({ items, onChange, make, render, label, max }: { items: I[]; onChange: (v: I[]) => void; make: () => I; render: (item: I, set: (patch: Partial<I>) => void) => ReactNode; label: string; max: number }) {
  const move = (i: number, d: number) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="rounded-md border border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">{label} {i + 1}</span>
            <span className="flex">
              <Button size="icon" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${label} ${i + 1} up`}><ArrowUp className="h-3.5 w-3.5" /></Button>
              <Button size="icon" variant="ghost" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${label} ${i + 1} down`}><ArrowDown className="h-3.5 w-3.5" /></Button>
              <Button size="icon" variant="ghost" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${label} ${i + 1}`}><X className="h-3.5 w-3.5" /></Button>
            </span>
          </div>
          <div className="space-y-3">{render(item, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))))}</div>
        </div>
      ))}
      {items.length < max && (
        <Button size="sm" variant="outline" onClick={() => onChange([...items, make()])}>
          <Plus className="h-3.5 w-3.5" /> Add {label.toLowerCase()}
        </Button>
      )}
    </div>
  );
}

function ImageField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("image", file);
      return apiRequest<{ data: { url: string } }>("POST", `${KEY}/image`, fd);
    },
    onSuccess: (r) => onChange(r.data.url),
    onError: (err) => toast({ title: "Upload failed", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Field label="Image" hint="Optional. Without one, a sample of WhatsApp, email and SMS messages is shown. PNG, JPG, GIF or WebP up to 2 MB.">
      <div className="flex flex-wrap items-center gap-2">
        {value && <img src={value} alt="" className="h-14 w-24 rounded border border-border object-cover" />}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
        <Button size="sm" variant="outline" onClick={() => input.current?.click()} loading={upload.isPending}><ImagePlus className="h-3.5 w-3.5" /> {value ? "Replace" : "Upload"}</Button>
        {value && <Button size="sm" variant="ghost" onClick={() => onChange("")}>Remove</Button>}
      </div>
    </Field>
  );
}

function AnchorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <T label="Anchor (optional)" value={value} max={40} placeholder="e.g. pricing" hint={value ? `Link to it with #${value}` : "Lets menu links jump to this section."} onChange={(v) => onChange(v.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />;
}

// ---------------------------------------------------------------------------
// Per-section forms
// ---------------------------------------------------------------------------

function SectionForm({ s, set }: { s: LandingSection; set: (patch: Partial<LandingSection>) => void }) {
  const p = set as (patch: Record<string, unknown>) => void;
  switch (s.type) {
    case "hero":
      return (
        <>
          <T label="Small label above the headline" value={s.eyebrow} max={80} onChange={(v) => p({ eyebrow: v })} />
          <T label="Headline" value={s.title} max={160} rows={2} onChange={(v) => p({ title: v })} />
          <T label="Sub-headline" value={s.subtitle} max={400} rows={3} onChange={(v) => p({ subtitle: v })} />
          <LinkEditor label="Main button" value={s.primary} onChange={(v) => p({ primary: v })} />
          <LinkEditor label="Second button" value={s.secondary} onChange={(v) => p({ secondary: v })} />
          <ImageField value={s.image} onChange={(v) => p({ image: v })} />
        </>
      );
    case "stats":
      return (
        <ItemList label="Stat" max={6} items={s.items} onChange={(items) => p({ items })} make={() => ({ value: "", label: "" })} render={(i, u) => (
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <T label="Value" value={i.value} max={20} onChange={(v) => u({ value: v })} />
            <T label="Label" value={i.label} max={60} onChange={(v) => u({ label: v })} />
          </div>
        )} />
      );
    case "features":
      return (
        <>
          <T label="Title" value={s.title} max={120} onChange={(v) => p({ title: v })} />
          <T label="Subtitle" value={s.subtitle} max={300} onChange={(v) => p({ subtitle: v })} />
          <ItemList label="Feature" max={12} items={s.items} onChange={(items) => p({ items })} make={() => ({ icon: "sparkles" as const, title: "", text: "" })} render={(i, u) => {
            const Icon = ICONS[i.icon];
            return (
              <>
                <div className="grid gap-3 sm:grid-cols-[11rem_1fr]">
                  <Field label="Icon">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                      <Select value={i.icon} onChange={(e) => u({ icon: e.target.value as typeof i.icon })} aria-label="Icon">
                        {LANDING_ICONS.map((n) => <option key={n} value={n}>{n.replace(/-/g, " ")}</option>)}
                      </Select>
                    </div>
                  </Field>
                  <T label="Title" value={i.title} max={80} onChange={(v) => u({ title: v })} />
                </div>
                <T label="Description" value={i.text} max={300} rows={2} onChange={(v) => u({ text: v })} />
              </>
            );
          }} />
        </>
      );
    case "channels":
      return (
        <>
          <T label="Title" value={s.title} max={120} onChange={(v) => p({ title: v })} />
          <T label="Subtitle" value={s.subtitle} max={300} onChange={(v) => p({ subtitle: v })} />
          <T label="WhatsApp description" value={s.whatsapp} max={300} rows={2} onChange={(v) => p({ whatsapp: v })} />
          <T label="Email description" value={s.email} max={300} rows={2} onChange={(v) => p({ email: v })} />
          <T label="SMS description" value={s.sms} max={300} rows={2} onChange={(v) => p({ sms: v })} />
        </>
      );
    case "steps":
      return (
        <>
          <T label="Title" value={s.title} max={120} onChange={(v) => p({ title: v })} />
          <T label="Subtitle" value={s.subtitle} max={300} onChange={(v) => p({ subtitle: v })} />
          <ItemList label="Step" max={6} items={s.items} onChange={(items) => p({ items })} make={() => ({ title: "", text: "" })} render={(i, u) => (
            <>
              <T label="Title" value={i.title} max={80} onChange={(v) => u({ title: v })} />
              <T label="Description" value={i.text} max={300} rows={2} onChange={(v) => u({ text: v })} />
            </>
          )} />
        </>
      );
    case "pricing":
      return (
        <>
          <T label="Title" value={s.title} max={120} onChange={(v) => p({ title: v })} />
          <T label="Subtitle" value={s.subtitle} max={300} onChange={(v) => p({ subtitle: v })} />
          <T label="Button text" value={s.cta} max={40} onChange={(v) => p({ cta: v })} hint="Plans, prices and features come from Plans; edit them there." />
        </>
      );
    case "testimonials":
      return (
        <>
          <T label="Title" value={s.title} max={120} onChange={(v) => p({ title: v })} />
          <ItemList label="Quote" max={9} items={s.items} onChange={(items) => p({ items })} make={() => ({ quote: "", name: "", role: "" })} render={(i, u) => (
            <>
              <T label="Quote" value={i.quote} max={500} rows={3} onChange={(v) => u({ quote: v })} />
              <div className="grid gap-3 sm:grid-cols-2">
                <T label="Name" value={i.name} max={80} onChange={(v) => u({ name: v })} />
                <T label="Role / company" value={i.role} max={100} onChange={(v) => u({ role: v })} />
              </div>
            </>
          )} />
        </>
      );
    case "faq":
      return (
        <>
          <T label="Title" value={s.title} max={120} onChange={(v) => p({ title: v })} />
          <ItemList label="Question" max={20} items={s.items} onChange={(items) => p({ items })} make={() => ({ q: "", a: "" })} render={(i, u) => (
            <>
              <T label="Question" value={i.q} max={200} onChange={(v) => u({ q: v })} />
              <T label="Answer" value={i.a} max={1500} rows={3} onChange={(v) => u({ a: v })} />
            </>
          )} />
        </>
      );
    case "cta":
      return (
        <>
          <T label="Title" value={s.title} max={160} onChange={(v) => p({ title: v })} />
          <T label="Subtitle" value={s.subtitle} max={300} onChange={(v) => p({ subtitle: v })} />
          <LinkEditor label="Button" value={s.primary} onChange={(v) => p({ primary: v })} />
        </>
      );
    case "custom":
      return (
        <>
          <T label="Title" value={s.title} max={120} onChange={(v) => p({ title: v })} />
          <T label="Content" value={s.body} max={20_000} rows={8} hint="Markdown: **bold**, _italic_, [links](https://…), lists and ## headings." onChange={(v) => p({ body: v })} />
        </>
      );
  }
}

const sectionTitle = (s: LandingSection) => ("title" in s && s.title) || (s.type === "stats" ? s.items.map((i) => i.value).filter(Boolean).join(" · ") : "") || SECTION_TYPES[s.type].label;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function LandingEditorPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery<{ data: LandingPage; configured: boolean; plans: LandingPlan[] }>({ queryKey: [KEY] });
  const [draft, setDraft] = useState<LandingPage | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [adding, setAdding] = useState<LandingSectionType>("features");

  useEffect(() => {
    if (data && !draft) setDraft(structuredClone(data.data));
  }, [data, draft]);

  const saved = data?.data;
  const dirty = Boolean(draft && saved && canonical(draft) !== canonical(saved));
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: (page: LandingPage) => apiRequest<{ data: LandingPage }>("PUT", KEY, page),
    onSuccess: (r) => {
      queryClient.setQueryData([KEY], (old: typeof data) => (old ? { ...old, data: r.data, configured: true } : old));
      void queryClient.invalidateQueries({ queryKey: ["/api/landing-page"] });
      setDraft(structuredClone(r.data));
      toast({ title: r.data.enabled ? "Landing page published" : "Landing page saved", description: r.data.enabled ? "Visitors see the new version now." : "It stays hidden until you turn it on.", variant: "success" });
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });

  if (isLoading || !draft || !data) return <PageLoader />;
  const set = (patch: Partial<LandingPage>) => setDraft({ ...draft, ...patch });
  const setSection = (i: number, patch: Partial<LandingSection>) => set({ sections: draft.sections.map((s, j) => (j === i ? ({ ...s, ...patch } as LandingSection) : s)) });
  const move = (i: number, d: number) => {
    const next = [...draft.sections];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set({ sections: next });
  };
  const add = () => {
    const id = `${adding}-${Date.now().toString(36)}`;
    set({ sections: [...draft.sections, newSection(adding, id)] });
    setOpen(id);
  };

  return (
    <PageContainer wide>
      <PageHeader
        title="Landing page"
        description="The public page visitors see at your site's address before they sign in."
        actions={
          <>
            {saved?.enabled && (
              <a href="/home" target="_blank" rel="noreferrer">
                <Button variant="outline"><ExternalLink className="h-4 w-4" /> View live page</Button>
              </a>
            )}
            <Button
              variant="outline"
              onClick={async () => {
                if (await confirm({ title: "Start over with the starter content?", description: "Your sections are replaced with the default page. Nothing is saved until you press Save.", confirmText: "Reset" })) {
                  setDraft({ ...structuredClone(DEFAULT_LANDING), enabled: draft.enabled });
                }
              }}
            >
              <RotateCcw className="h-4 w-4" /> Reset
            </Button>
            <Button onClick={() => save.mutate(draft)} loading={save.isPending} disabled={!dirty}>
              <Save className="h-4 w-4" /> {draft.enabled ? "Save & publish" : "Save"}
            </Button>
          </>
        }
      />

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Switch
            checked={draft.enabled}
            onChange={(enabled) => set({ enabled })}
            label={draft.enabled ? "Landing page is on" : "Landing page is off"}
            description={draft.enabled ? "Visitors who aren't signed in see this page at /." : "Visitors go straight to the sign-in page."}
          />
          <div className="flex items-center gap-2 text-sm">
            {saved?.enabled ? <Badge tone="success">Live</Badge> : <Badge>Not published</Badge>}
            {dirty && <Badge tone="warning">Unsaved changes</Badge>}
            {!data.configured && <Badge tone="info">Starter content</Badge>}
          </div>
        </div>
      </Card>

      <div className="mb-4 lg:hidden">
        <Tabs value={view} onChange={setView} tabs={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className={cn("space-y-4", view === "preview" && "hidden lg:block")}>
          <Card>
            <CardHeader title="Sections" description="Show, hide, reorder and edit. Hidden sections stay saved." />
            <ul className="divide-y divide-border">
              {draft.sections.map((s, i) => {
                const isOpen = open === s.id;
                return (
                  <li key={s.id}>
                    <div className="flex items-center gap-1 px-3 py-2">
                      <button className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-subtle" onClick={() => setOpen(isOpen ? null : s.id)} aria-expanded={isOpen}>
                        <ChevronDown className={cn("h-4 w-4 shrink-0 text-fg-muted transition-transform", isOpen && "rotate-180")} />
                        <span className="min-w-0">
                          <span className={cn("block truncate text-sm font-medium", !s.enabled && "text-fg-muted line-through")}>{sectionTitle(s)}</span>
                          <span className="block text-xs text-fg-muted">{SECTION_TYPES[s.type].label}</span>
                        </span>
                      </button>
                      <Button size="icon" variant="ghost" onClick={() => setSection(i, { enabled: !s.enabled })} aria-label={s.enabled ? `Hide ${sectionTitle(s)}` : `Show ${sectionTitle(s)}`} title={s.enabled ? "Hide" : "Show"}>
                        {s.enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-fg-muted" />}
                      </Button>
                      <Button size="icon" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" disabled={i === draft.sections.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="h-4 w-4" /></Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${sectionTitle(s)}`}
                        onClick={async () => {
                          if (await confirm({ title: `Delete "${sectionTitle(s)}"?`, description: "Hide it instead if you might want it back.", confirmText: "Delete", destructive: true })) {
                            set({ sections: draft.sections.filter((_, j) => j !== i) });
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    </div>
                    {isOpen && (
                      <div className="space-y-3 border-t border-border bg-subtle/40 px-4 py-4">
                        <SectionForm s={s} set={(patch) => setSection(i, patch)} />
                        {s.type !== "stats" && <AnchorField value={s.anchor} onChange={(anchor) => setSection(i, { anchor })} />}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-end gap-2 border-t border-border p-3">
              <Field label="Add a section" htmlFor="add-type" className="min-w-0 flex-1">
                <Select id="add-type" value={adding} onChange={(e) => setAdding(e.target.value as LandingSectionType)}>
                  {Object.entries(SECTION_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label} — {v.description}</option>)}
                </Select>
              </Field>
              <Button variant="outline" onClick={add} disabled={draft.sections.length >= 30}><Plus className="h-4 w-4" /> Add</Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="Top menu" />
            <div className="space-y-3 p-4">
              <Switch checked={draft.nav.showLogin} onChange={(showLogin) => set({ nav: { ...draft.nav, showLogin } })} label="Show “Sign in”" />
              <Switch checked={draft.nav.showSignup} onChange={(showSignup) => set({ nav: { ...draft.nav, showSignup } })} label="Show sign-up button" description="Hidden automatically while registration is closed." />
              {draft.nav.showSignup && <T label="Sign-up button text" value={draft.nav.signupLabel} max={40} placeholder="Get started" onChange={(signupLabel) => set({ nav: { ...draft.nav, signupLabel } })} />}
              <ItemList label="Menu link" max={6} items={draft.nav.links} onChange={(links) => set({ nav: { ...draft.nav, links } })} make={() => ({ label: "", href: "" })} render={(l, u) => (
                <div className="grid gap-3 sm:grid-cols-2">
                  <T label="Text" value={l.label} max={60} onChange={(v) => u({ label: v })} />
                  <T label="Link" value={l.href} max={500} placeholder="#pricing" onChange={(v) => u({ href: v })} />
                </div>
              )} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Footer" description="Policy pages are linked automatically." />
            <div className="space-y-3 p-4">
              <T label="Footer text" value={draft.footer.text} max={300} placeholder={`© ${new Date().getFullYear()} Your company`} onChange={(text) => set({ footer: { ...draft.footer, text } })} />
              <ItemList label="Footer link" max={8} items={draft.footer.links} onChange={(links) => set({ footer: { ...draft.footer, links } })} make={() => ({ label: "", href: "" })} render={(l, u) => (
                <div className="grid gap-3 sm:grid-cols-2">
                  <T label="Text" value={l.label} max={60} onChange={(v) => u({ label: v })} />
                  <T label="Link" value={l.href} max={500} placeholder="https://…" onChange={(v) => u({ href: v })} />
                </div>
              )} />
            </div>
          </Card>
        </div>

        <div className={cn(view === "edit" && "hidden lg:block")}>
          <div className="lg:sticky lg:top-4">
            <p className="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">Preview{dirty ? " · unsaved" : ""}</p>
            <div className="max-h-[calc(100vh-8rem)] overflow-y-auto rounded-xl border border-border shadow-sm" aria-label="Landing page preview">
              <LandingView page={{ ...draft, enabled: true }} plans={data.plans} preview />
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
