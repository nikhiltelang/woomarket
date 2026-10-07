import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Languages, Pencil, Play, Plus, Star, Trash2, XCircle } from "lucide-react";
import type { CronJobLog, PlatformLanguage, PolicyPage } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate, relativeTime } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, EmptyState, PageLoader, StatusBadge } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, Tabs, useConfirm, useToast } from "@/components/ui/overlay";
import { refreshConfig, SectionShell } from "./common";

// ---------------------------------------------------------------------------
// Cron jobs
// ---------------------------------------------------------------------------

interface CronJob {
  key: string;
  name: string;
  description: string;
  intervalSeconds: number;
  running: boolean;
  nextRunAt: string | null;
  lastRun: CronJobLog | null;
  recent: CronJobLog[];
}

const every = (s: number) => (s % 86400 === 0 ? `every ${s / 86400 === 1 ? "day" : `${s / 86400} days`}` : s % 3600 === 0 ? `every ${s / 3600}h` : s % 60 === 0 ? `every ${s / 60 === 1 ? "minute" : `${s / 60} minutes`}` : `every ${s}s`);

export function CronSection() {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useQuery<{ data: CronJob[] }>({ queryKey: ["/api/system-config/cron-jobs"], refetchInterval: 15_000 });
  const run = useMutation({
    mutationFn: (key: string) => apiRequest<{ data: { status: string; message: string; durationMs: number } }>("POST", `/api/system-config/cron-jobs/${key}/run`),
    onSuccess: (r) => {
      toast({ title: r.data.status === "success" ? "Job finished" : r.data.status === "skipped" ? "Job already running" : "Job failed", description: `${r.data.message} (${r.data.durationMs} ms)`, variant: r.data.status === "failed" ? "error" : "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/system-config/cron-jobs"] });
    },
    onError: (err) => toast({ title: "Could not run job", description: (err as Error).message, variant: "error" }),
  });
  return (
    <SectionShell title="Cron job setting" description="Background jobs run inside the app (on instance 0 when clustered); no system crontab is needed.">
      {isLoading ? (
        <PageLoader />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Job</Th>
                <Th>Schedule</Th>
                <Th>Last run</Th>
                <Th className="hidden md:table-cell">Next run</Th>
                <Th className="text-right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {data?.data.map((j) => (
                <Tr key={j.key}>
                  <Td>
                    <button className="text-left font-medium hover:underline" onClick={() => setOpen(open === j.key ? null : j.key)}>{j.name}</button>
                    <p className="text-xs text-fg-muted">{j.description}</p>
                    {open === j.key && (
                      <ul className="mt-2 space-y-1 text-xs">
                        {j.recent.length ? j.recent.map((l) => (
                          <li key={l.id} className="flex items-center gap-2">
                            {l.status === "success" ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <XCircle className="h-3.5 w-3.5 text-danger" />}
                            <span className="text-fg-muted">{formatDate(l.executedAt)}</span>
                            <span className="truncate">{l.message}</span>
                            <span className="text-fg-muted">{l.durationMs} ms</span>
                          </li>
                        )) : <li className="text-fg-muted">No runs recorded yet.</li>}
                      </ul>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-fg-muted">{every(j.intervalSeconds)}</Td>
                  <Td>
                    {j.running ? <Badge tone="info">running</Badge> : j.lastRun ? (
                      <span className="flex flex-col">
                        <StatusBadge status={j.lastRun.status} />
                        <span className="mt-1 text-xs text-fg-muted">{relativeTime(j.lastRun.executedAt)}</span>
                      </span>
                    ) : <span className="text-fg-muted">Never</span>}
                  </Td>
                  <Td className="hidden text-fg-muted md:table-cell">{j.nextRunAt ? relativeTime(j.nextRunAt) : "—"}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="outline" onClick={() => run.mutate(j.key)} loading={run.isPending && run.variables === j.key} disabled={j.running}>
                      <Play className="h-3.5 w-3.5" /> Run now
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Policy pages
// ---------------------------------------------------------------------------

type PolicyForm = { title: string; slug: string; content: string; metaTitle: string; metaDescription: string; isPublished: boolean };
const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function PoliciesSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery<{ data: PolicyPage[] }>({ queryKey: ["/api/policy-pages/admin"] });
  const [editing, setEditing] = useState<PolicyPage | "new" | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [v, setV] = useState<PolicyForm>({ title: "", slug: "", content: "", metaTitle: "", metaDescription: "", isPublished: true });

  useEffect(() => {
    setTab("write");
    if (editing === "new") setV({ title: "", slug: "", content: "# Title\n\nWrite your policy here.", metaTitle: "", metaDescription: "", isPublished: true });
    else if (editing) setV({ title: editing.title, slug: editing.slug, content: editing.content, metaTitle: editing.metaTitle ?? "", metaDescription: editing.metaDescription ?? "", isPublished: Boolean(editing.isPublished) });
  }, [editing]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/policy-pages/admin"] });
    refreshConfig();
  };
  const save = useMutation({
    mutationFn: () => (editing && editing !== "new" ? apiRequest("PUT", `/api/policy-pages/${editing.id}`, v) : apiRequest("POST", "/api/policy-pages", v)),
    onSuccess: () => {
      toast({ title: "Page saved", variant: "success" });
      setEditing(null);
      refresh();
    },
    onError: (err) => toast({ title: "Could not save page", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({ mutationFn: (id: string) => apiRequest("DELETE", `/api/policy-pages/${id}`), onSuccess: refresh, onError: (err) => toast({ title: "Could not delete", description: (err as Error).message, variant: "error" }) });
  const togglePublish = useMutation({
    mutationFn: (p: PolicyPage) => apiRequest("PUT", `/api/policy-pages/${p.id}`, { title: p.title, slug: p.slug, content: p.content, metaTitle: p.metaTitle, metaDescription: p.metaDescription, isPublished: !p.isPublished }),
    onSuccess: refresh,
  });
  const isSystem = editing !== null && editing !== "new" && editing.isSystem;

  return (
    <SectionShell title="Policy pages" description="Published pages appear in the footer of public pages and at /policy/<address>." wide>
      <div className="mb-4">
        <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> New page</Button>
      </div>
      {isLoading ? <PageLoader /> : !data?.data.length ? (
        <Card><EmptyState title="No pages yet" /></Card>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Page</Th>
                <Th>Address</Th>
                <Th>Status</Th>
                <Th className="hidden md:table-cell">Updated</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((p) => (
                <Tr key={p.id}>
                  <Td><span className="font-medium">{p.title}</span> {p.isSystem && <Badge tone="info">built-in</Badge>}</Td>
                  <Td><a href={`/policy/${p.slug}`} target="_blank" rel="noopener" className="font-mono text-xs text-primary hover:underline">/policy/{p.slug}</a></Td>
                  <Td><button onClick={() => togglePublish.mutate(p)} aria-label={p.isPublished ? "Unpublish" : "Publish"}><StatusBadge status={p.isPublished ? "active" : "draft"} /></button></Td>
                  <Td className="hidden text-fg-muted md:table-cell">{formatDate(p.updatedAt)}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <Button size="icon" variant="ghost" aria-label={`Edit ${p.title}`} onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></Button>
                    {!p.isSystem && (
                      <Button size="icon" variant="ghost" aria-label={`Delete ${p.title}`} onClick={async () => {
                        if (await confirm({ title: `Delete "${p.title}"?`, confirmText: "Delete", destructive: true })) remove.mutate(p.id);
                      }}><Trash2 className="h-4 w-4 text-danger" /></Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="xl"
        title={editing === "new" ? "New page" : `Edit "${v.title}"`}
        footer={<Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.title.trim() || !v.slug || !v.content.trim()}>Save page</Button>}
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="pp-title">
              <Input id="pp-title" value={v.title} onChange={(e) => setV((x) => ({ ...x, title: e.target.value, slug: editing === "new" && (!x.slug || x.slug === slugify(x.title)) ? slugify(e.target.value) : x.slug }))} />
            </Field>
            <Field label="Address" htmlFor="pp-slug" hint={isSystem ? "Built-in pages keep their address." : "/policy/<address>"}>
              <Input id="pp-slug" value={v.slug} disabled={Boolean(isSystem)} onChange={(e) => setV({ ...v, slug: slugify(e.target.value) })} className="font-mono" />
            </Field>
            <Field label="Meta title (optional)" htmlFor="pp-mt"><Input id="pp-mt" value={v.metaTitle} onChange={(e) => setV({ ...v, metaTitle: e.target.value })} /></Field>
            <Field label="Meta description (optional)" htmlFor="pp-md"><Input id="pp-md" value={v.metaDescription} onChange={(e) => setV({ ...v, metaDescription: e.target.value })} /></Field>
          </div>
          <div className="flex items-center justify-between">
            <Tabs value={tab} onChange={setTab} tabs={[{ value: "write", label: "Write" }, { value: "preview", label: "Preview" }]} />
            <Checkbox label="Published" checked={v.isPublished} onChange={(isPublished) => setV({ ...v, isPublished })} />
          </div>
          {tab === "write" ? (
            <Field hint="Markdown: # Heading, ## Subheading, - list item, **bold**, _italic_, [link](https://…)">
              <Textarea rows={16} className="font-mono text-xs" value={v.content} onChange={(e) => setV({ ...v, content: e.target.value })} aria-label="Content" />
            </Field>
          ) : (
            <div className="min-h-64 rounded-md border border-border p-5"><Markdown source={v.content} /></div>
          )}
        </div>
      </Dialog>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Languages & translations
// ---------------------------------------------------------------------------

type LangForm = { code: string; name: string; nativeName: string; icon: string; direction: "ltr" | "rtl"; isEnabled: boolean; sortOrder: number };

function TranslationsDialog({ lang, baseKeys, onClose }: { lang: PlatformLanguage | null; baseKeys: Record<string, string>; onClose: () => void }) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  useEffect(() => setValues(lang?.translations ?? {}), [lang]);
  const keys = useMemo(
    () => Object.keys(baseKeys).filter((k) => (!filter || `${k} ${baseKeys[k]} ${values[k] ?? ""}`.toLowerCase().includes(filter.toLowerCase())) && (!onlyMissing || !values[k]?.trim())),
    [baseKeys, filter, onlyMissing, values],
  );
  const done = Object.keys(baseKeys).filter((k) => values[k]?.trim()).length;
  const save = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/languages/${lang!.id}/translations`, { translations: values }),
    onSuccess: () => {
      toast({ title: "Translations saved", description: "Users see them on their next page load.", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/languages"] });
      void queryClient.invalidateQueries({ queryKey: [`/api/languages/translations/${lang!.code}`] });
      onClose();
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog
      open={Boolean(lang)}
      onClose={onClose}
      size="xl"
      title={`Translate: ${lang?.name ?? ""}`}
      description={`${done} of ${Object.keys(baseKeys).length} strings translated. Empty fields fall back to English.`}
      footer={<Button onClick={() => save.mutate()} loading={save.isPending}>Save translations</Button>}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter keys or text…" className="max-w-xs" aria-label="Filter" />
        <Checkbox label="Only untranslated" checked={onlyMissing} onChange={setOnlyMissing} />
      </div>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border" dir="auto">
        {keys.map((k) => (
          <div key={k} className="grid gap-2 p-3 sm:grid-cols-2 sm:items-center">
            <div>
              <p className="font-mono text-[11px] text-fg-muted">{k}</p>
              <p className="text-sm">{baseKeys[k]}</p>
            </div>
            <Input dir={lang?.direction === "rtl" ? "rtl" : "ltr"} value={values[k] ?? ""} onChange={(e) => setValues((x) => ({ ...x, [k]: e.target.value }))} placeholder={baseKeys[k]} aria-label={`Translation for ${k}`} />
          </div>
        ))}
        {!keys.length && <p className="p-4 text-sm text-fg-muted">Nothing matches.</p>}
      </div>
    </Dialog>
  );
}

export function LanguageSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery<{ data: PlatformLanguage[]; baseKeys: Record<string, string> }>({ queryKey: ["/api/languages"] });
  const [editing, setEditing] = useState<PlatformLanguage | "new" | null>(null);
  const [translating, setTranslating] = useState<PlatformLanguage | null>(null);
  const [v, setV] = useState<LangForm>({ code: "", name: "", nativeName: "", icon: "", direction: "ltr", isEnabled: true, sortOrder: 0 });
  useEffect(() => {
    if (editing === "new") setV({ code: "", name: "", nativeName: "", icon: "", direction: "ltr", isEnabled: true, sortOrder: (data?.data.length ?? 0) * 10 });
    else if (editing) setV({ code: editing.code, name: editing.name, nativeName: editing.nativeName, icon: editing.icon ?? "", direction: editing.direction as "ltr" | "rtl", isEnabled: editing.isEnabled, sortOrder: editing.sortOrder ?? 0 });
  }, [editing, data?.data.length]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/languages"] });
    refreshConfig();
  };
  const fail = (err: unknown) => toast({ title: "Action failed", description: (err as Error).message, variant: "error" });
  const save = useMutation({
    mutationFn: () => (editing && editing !== "new" ? apiRequest("PUT", `/api/languages/${editing.id}`, v) : apiRequest("POST", "/api/languages", v)),
    onSuccess: () => {
      toast({ title: "Language saved", variant: "success" });
      setEditing(null);
      refresh();
    },
    onError: fail,
  });
  const makeDefault = useMutation({ mutationFn: (id: string) => apiRequest("POST", `/api/languages/${id}/default`), onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: (id: string) => apiRequest("DELETE", `/api/languages/${id}`), onSuccess: refresh, onError: fail });
  const total = Object.keys(data?.baseKeys ?? {}).length;

  return (
    <SectionShell title="Language" description="Translate the navigation, sign-in pages and common labels. Users pick a language from the switcher (when 'Language option' is on).">
      <div className="mb-4">
        <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Add language</Button>
      </div>
      {isLoading ? <PageLoader /> : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Language</Th>
                <Th>Code</Th>
                <Th className="hidden md:table-cell">Direction</Th>
                <Th>Translated</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {data?.data.map((l) => {
                const done = Object.keys(l.translations ?? {}).length;
                return (
                  <Tr key={l.id}>
                    <Td>
                      <span className="font-medium">{l.icon} {l.name}</span> <span className="text-fg-muted">{l.nativeName !== l.name && `(${l.nativeName})`}</span>
                      {l.isDefault && <Badge tone="primary" className="ml-2">default</Badge>}
                    </Td>
                    <Td className="font-mono text-xs">{l.code}</Td>
                    <Td className="hidden uppercase md:table-cell">{l.direction}</Td>
                    <Td className="tabular-nums">{l.code === "en" ? "base" : `${done}/${total}`}</Td>
                    <Td><StatusBadge status={l.isEnabled ? "active" : "inactive"} /></Td>
                    <Td className="text-right whitespace-nowrap">
                      {l.code !== "en" && <Button size="sm" variant="outline" onClick={() => setTranslating(l)}><Languages className="h-3.5 w-3.5" /> Translate</Button>}
                      {!l.isDefault && <Button size="icon" variant="ghost" aria-label="Make default" onClick={() => makeDefault.mutate(l.id)}><Star className="h-4 w-4" /></Button>}
                      <Button size="icon" variant="ghost" aria-label={`Edit ${l.name}`} onClick={() => setEditing(l)}><Pencil className="h-4 w-4" /></Button>
                      {!l.isDefault && (
                        <Button size="icon" variant="ghost" aria-label={`Delete ${l.name}`} onClick={async () => {
                          if (await confirm({ title: `Delete ${l.name}?`, description: "Its translations are removed.", confirmText: "Delete", destructive: true })) remove.mutate(l.id);
                        }}><Trash2 className="h-4 w-4 text-danger" /></Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add language" : "Edit language"}
        footer={<Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.code || !v.name || !v.nativeName}>Save</Button>}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="lg-code" hint="ISO code, e.g. es, hi, ar, pt-BR"><Input id="lg-code" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.trim() })} /></Field>
          <Field label="Flag / icon (optional)" htmlFor="lg-icon"><Input id="lg-icon" value={v.icon} maxLength={10} onChange={(e) => setV({ ...v, icon: e.target.value })} placeholder="🇪🇸" /></Field>
          <Field label="Name (English)" htmlFor="lg-name"><Input id="lg-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Spanish" /></Field>
          <Field label="Native name" htmlFor="lg-native"><Input id="lg-native" value={v.nativeName} onChange={(e) => setV({ ...v, nativeName: e.target.value })} placeholder="Español" /></Field>
          <Field label="Text direction" htmlFor="lg-dir">
            <Select id="lg-dir" value={v.direction} onChange={(e) => setV({ ...v, direction: e.target.value as "ltr" | "rtl" })}>
              <option value="ltr">Left to right</option>
              <option value="rtl">Right to left (Arabic, Hebrew…)</option>
            </Select>
          </Field>
          <Field label="Sort order" htmlFor="lg-sort"><Input id="lg-sort" type="number" value={v.sortOrder} onChange={(e) => setV({ ...v, sortOrder: Number(e.target.value) })} /></Field>
          <Checkbox label="Enabled" checked={v.isEnabled} onChange={(isEnabled) => setV({ ...v, isEnabled })} />
        </div>
      </Dialog>
      <TranslationsDialog lang={translating} baseKeys={data?.baseKeys ?? {}} onClose={() => setTranslating(null)} />
    </SectionShell>
  );
}
