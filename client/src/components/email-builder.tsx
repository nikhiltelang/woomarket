import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Code2,
  Columns2,
  Copy,
  GripVertical,
  Heading,
  Image as ImageIcon,
  Minus,
  Monitor,
  MousePointerClick,
  MoveVertical,
  Plus,
  Share2,
  Smartphone,
  Trash2,
  Type,
  X,
  PanelBottom,
} from "lucide-react";
import {
  BLOCK_LABELS,
  blockSchema,
  cloneBlock,
  newBlock,
  renderBlock,
  renderDesign,
  starterDesign,
  FONT_STACKS,
  type Block,
  type BlockType,
  type DesignSettings,
  type EmailDesign,
} from "@shared/email-design";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Tabs, useConfirm } from "@/components/ui/overlay";
import { insertAtCursor, MergeTagButtons } from "@/components/marketing";
import { AiEmailDraftButton } from "@/components/ai";

const PALETTE: { type: BlockType; icon: ReactNode; hint: string }[] = [
  { type: "heading", icon: <Heading className="h-4 w-4" />, hint: "Title or section header" },
  { type: "text", icon: <Type className="h-4 w-4" />, hint: "Paragraphs with bold, italic, links" },
  { type: "button", icon: <MousePointerClick className="h-4 w-4" />, hint: "Call to action" },
  { type: "image", icon: <ImageIcon className="h-4 w-4" />, hint: "From a public URL" },
  { type: "columns", icon: <Columns2 className="h-4 w-4" />, hint: "Two side by side, stacked on phones" },
  { type: "divider", icon: <Minus className="h-4 w-4" />, hint: "Horizontal line" },
  { type: "spacer", icon: <MoveVertical className="h-4 w-4" />, hint: "Empty space" },
  { type: "social", icon: <Share2 className="h-4 w-4" />, hint: "Links to your profiles" },
  { type: "footer", icon: <PanelBottom className="h-4 w-4" />, hint: "Address and unsubscribe link" },
  { type: "html", icon: <Code2 className="h-4 w-4" />, hint: "Paste your own HTML" },
];

/** Sample values for merge tags in the canvas and preview. */
function sample(html: string) {
  return html
    .replace(/\{\{\s*first_name\s*\}\}/gi, "Priya")
    .replace(/\{\{\s*name\s*\}\}/gi, "Priya Sharma")
    .replace(/\{\{\s*email\s*\}\}/gi, "priya@example.com")
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, "#");
}

type Drag = { kind: "new"; type: BlockType } | { kind: "move"; index: number };

/**
 * Full-screen drag-and-drop editor. Blocks are dragged from the palette onto the canvas and
 * reordered by dragging; every action also has a button, for keyboards and touch screens.
 */
export function EmailBuilder({ value, onChange, onClose, mergeTags, title }: { value: EmailDesign; onChange: (d: EmailDesign) => void; onClose: () => void; mergeTags: string[]; title: string }) {
  const confirm = useConfirm();
  const [selected, setSelected] = useState<string | null>(value.blocks[0]?.id ?? null);
  const [view, setView] = useState<"edit" | "desktop" | "mobile">("edit");
  const [dropAt, setDropAt] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const s = value.settings;
  const blocks = value.blocks;
  const index = blocks.findIndex((b) => b.id === selected);
  const current = index >= 0 ? blocks[index] : null;

  // Escape closes the builder only, not the composer dialog underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const setBlocks = (next: Block[]) => onChange({ ...value, blocks: next });
  const setSettings = (patch: Partial<DesignSettings>) => onChange({ ...value, settings: { ...s, ...patch } });
  const update = (b: Block) => setBlocks(blocks.map((x) => (x.id === b.id ? b : x)));
  const insert = (type: BlockType, at = index >= 0 ? index + 1 : blocks.length) => {
    const b = newBlock(type);
    setBlocks([...blocks.slice(0, at), b, ...blocks.slice(at)]);
    setSelected(b.id);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to > blocks.length || from === to || from + 1 === to) return;
    const next = [...blocks];
    const [b] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, b);
    setBlocks(next);
  };
  const remove = (id: string) => {
    const i = blocks.findIndex((b) => b.id === id);
    const next = blocks.filter((b) => b.id !== id);
    setBlocks(next);
    setSelected(next[Math.min(i, next.length - 1)]?.id ?? null);
  };

  const onDragOverBlock = (e: DragEvent, i: number) => {
    if (!drag.current) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const d = drag.current;
    const at = dropAt ?? blocks.length;
    if (d?.kind === "new") insert(d.type, at);
    else if (d?.kind === "move") move(d.index, at);
    drag.current = null;
    setDropAt(null);
  };
  const endDrag = () => {
    drag.current = null;
    setDropAt(null);
  };

  const fullHtml = useMemo(() => (view === "edit" ? "" : sample(renderDesign(value, { title }))), [view, value, title]);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label="Email builder">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
        <h2 className="mr-auto truncate text-sm font-semibold">Design: {title || "Untitled email"}</h2>
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { value: "edit", label: "Edit" },
            { value: "desktop", label: <span className="flex items-center gap-1"><Monitor className="h-3.5 w-3.5" /> Desktop</span> },
            { value: "mobile", label: <span className="flex items-center gap-1"><Smartphone className="h-3.5 w-3.5" /> Mobile</span> },
          ]}
        />
        <Button size="sm" onClick={onClose}>Done</Button>
      </header>

      {view !== "edit" ? (
        <div className="flex flex-1 justify-center overflow-auto bg-subtle p-4">
          <iframe title="Email preview" sandbox="" srcDoc={fullHtml} className={cn("h-full rounded-md border border-border bg-white shadow-sm", view === "mobile" ? "w-[375px]" : "w-full max-w-[900px]")} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[13rem_minmax(0,1fr)_20rem]">
          {/* Palette */}
          <aside className="hidden overflow-y-auto border-r border-border bg-surface p-3 md:block" aria-label="Blocks">
            <p className="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">Drag a block</p>
            <ul className="space-y-1.5">
              {PALETTE.map((p) => (
                <li key={p.type}>
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      drag.current = { kind: "new", type: p.type };
                      e.dataTransfer.effectAllowed = "copy";
                      e.dataTransfer.setData("text/plain", p.type);
                    }}
                    onDragEnd={endDrag}
                    onClick={() => insert(p.type)}
                    title={`${p.hint}. Click to add below the selected block.`}
                    className="flex w-full cursor-grab items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-2 text-left text-sm hover:border-primary hover:text-primary active:cursor-grabbing"
                  >
                    {p.icon}
                    {BLOCK_LABELS[p.type]}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {/* Canvas */}
          <main className="min-h-0 overflow-y-auto p-4 sm:p-8" style={{ background: s.backgroundColor }} onDragOver={(e) => drag.current && e.preventDefault()} onDrop={onDrop} onClick={() => setSelected(null)}>
            <div className="mx-auto rounded-lg py-5 shadow-sm" style={{ width: "100%", maxWidth: s.width, background: s.contentBackground }}>
              {blocks.length === 0 && (
                <div className={cn("mx-8 rounded-md border-2 border-dashed p-10 text-center text-sm", dropAt !== null ? "border-primary text-primary" : "border-border text-fg-muted")} onDragOver={(e) => { if (drag.current) { e.preventDefault(); setDropAt(0); } }}>
                  Drag blocks here, or pick one from the list.
                </div>
              )}
              {blocks.map((b, i) => (
                <div
                  key={b.id}
                  className="relative"
                  onDragOver={(e) => onDragOverBlock(e, i)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(b.id);
                  }}
                >
                  {dropAt === i && <DropLine />}
                  <div
                    className={cn("group relative cursor-pointer outline-offset-[-2px]", selected === b.id ? "outline-2 outline-primary outline-solid" : "hover:outline-1 hover:outline-dashed hover:outline-primary/60")}
                    draggable
                    onDragStart={(e) => {
                      drag.current = { kind: "move", index: i };
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", b.id);
                    }}
                    onDragEnd={endDrag}
                  >
                    <BlockView block={b} settings={s} />
                    <span className={cn("absolute top-1 left-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-white", selected === b.id ? "flex items-center gap-1" : "hidden group-hover:flex group-hover:items-center group-hover:gap-1")}>
                      <GripVertical className="h-3 w-3" /> {BLOCK_LABELS[b.type]}
                    </span>
                    {selected === b.id && (
                      <div className="absolute top-1 right-1 flex rounded-md border border-border bg-surface shadow-sm" onClick={(e) => e.stopPropagation()}>
                        <ToolButton label="Move up" onClick={() => move(i, i - 1)} disabled={i === 0}><ArrowUp className="h-3.5 w-3.5" /></ToolButton>
                        <ToolButton label="Move down" onClick={() => move(i, i + 2)} disabled={i === blocks.length - 1}><ArrowDown className="h-3.5 w-3.5" /></ToolButton>
                        <ToolButton label="Duplicate" onClick={() => { const c = cloneBlock(b); setBlocks([...blocks.slice(0, i + 1), c, ...blocks.slice(i + 1)]); setSelected(c.id); }}><Copy className="h-3.5 w-3.5" /></ToolButton>
                        <ToolButton label="Delete" onClick={() => remove(b.id)}><Trash2 className="h-3.5 w-3.5 text-danger" /></ToolButton>
                      </div>
                    )}
                  </div>
                  {dropAt === blocks.length && i === blocks.length - 1 && <DropLine />}
                </div>
              ))}
            </div>
            {/* Phones can't drag: add blocks from here. */}
            <div className="mx-auto mt-4 flex max-w-[600px] flex-wrap justify-center gap-1.5 md:hidden">
              {PALETTE.map((p) => (
                <Button key={p.type} size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); insert(p.type); }}>
                  <Plus className="h-3 w-3" /> {BLOCK_LABELS[p.type]}
                </Button>
              ))}
            </div>
          </main>

          {/* Properties */}
          <aside className="overflow-y-auto border-t border-border bg-surface p-4 md:border-t-0 md:border-l" aria-label="Properties">
            {current ? (
              <>
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">{BLOCK_LABELS[current.type]}</h3>
                  <Button size="icon" variant="ghost" aria-label="Deselect" onClick={() => setSelected(null)}><X className="h-4 w-4" /></Button>
                </div>
                <BlockProperties block={current} onChange={update} mergeTags={mergeTags} />
              </>
            ) : (
              <>
                <h3 className="mb-4 text-sm font-semibold">Email settings</h3>
                <SettingsPanel
                  settings={s}
                  onChange={setSettings}
                  onStarter={async (kind) => {
                    if (blocks.length && !(await confirm({ title: "Replace the design?", description: "Your current blocks will be removed.", confirmText: "Replace", destructive: true }))) return;
                    const d = starterDesign(kind);
                    onChange(d);
                    setSelected(d.blocks[0]?.id ?? null);
                  }}
                />
              </>
            )}
          </aside>
        </div>
      )}
    </div>,
    document.body,
  );
}

const DropLine = () => <div className="pointer-events-none absolute inset-x-6 -top-px z-10 h-0.5 rounded bg-primary" aria-hidden />;

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="p-1.5 text-fg-muted hover:text-fg disabled:opacity-40">
      {children}
    </button>
  );
}

/** A block as it will look in the email. Custom HTML is isolated in a sandboxed frame. */
function BlockView({ block, settings }: { block: Block; settings: DesignSettings }) {
  if (block.type === "html") {
    return <iframe title="Custom HTML" sandbox="" srcDoc={block.html} className="pointer-events-none block h-28 w-full border-0 bg-white" tabIndex={-1} />;
  }
  const ok = blockSchema.safeParse(block).success;
  if (!ok) return <p className="px-8 py-3 text-sm text-danger">This block has an invalid value.</p>;
  // renderBlock escapes all text and only emits validated URLs and colours.
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ borderCollapse: "collapse" }} className="pointer-events-none">
      <tbody dangerouslySetInnerHTML={{ __html: sample(renderBlock(block, settings)) }} />
    </table>
  );
}

function AlignPicker({ value, onChange }: { value: "left" | "center" | "right"; onChange: (v: "left" | "center" | "right") => void }) {
  const opts = [
    { v: "left" as const, icon: <AlignLeft className="h-4 w-4" />, label: "Left" },
    { v: "center" as const, icon: <AlignCenter className="h-4 w-4" />, label: "Center" },
    { v: "right" as const, icon: <AlignRight className="h-4 w-4" />, label: "Right" },
  ];
  return (
    <Field label="Alignment">
      <div className="inline-flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Alignment">
        {opts.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={value === o.v} aria-label={o.label} onClick={() => onChange(o.v)} className={cn("rounded p-1.5", value === o.v ? "bg-primary-soft text-primary" : "text-fg-muted hover:text-fg")}>
            {o.icon}
          </button>
        ))}
      </div>
    </Field>
  );
}

function ColorField({ label, value, onChange, allowDefault }: { label: string; value: string | null | undefined; onChange: (v: string | null) => void; allowDefault?: boolean }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} picker`} value={value ?? "#111827"} onChange={(e) => onChange(e.target.value)} className="h-9 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5" />
        <Input
          aria-label={label}
          value={text}
          placeholder={allowDefault ? "Default" : ""}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value);
            else if (allowDefault && !e.target.value) onChange(null);
          }}
          className="font-mono text-xs"
          maxLength={7}
        />
      </div>
    </Field>
  );
}

const clamp = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min);

function NumberField({ label, value, min, max, onChange, unit }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; unit?: string }) {
  return (
    <Field label={`${label}: ${value}${unit ?? ""}`}>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(clamp(Number(e.target.value), min, max))} className="w-full accent-[var(--color-primary)]" aria-label={label} />
    </Field>
  );
}

function TextWithTags({ id, label, value, onChange, mergeTags, rows = 6, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; mergeTags: string[]; rows?: number; hint?: ReactNode }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Textarea id={id} ref={ref} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      <MergeTagButtons tags={mergeTags} onInsert={(t) => onChange(insertAtCursor(ref.current, value, t))} />
    </Field>
  );
}

const FORMAT_HINT = "**bold**, *italic*, [link text](https://…). A blank line starts a new paragraph.";

function BlockProperties({ block: b, onChange, mergeTags }: { block: Block; onChange: (b: Block) => void; mergeTags: string[] }) {
  // Narrowed per case below; the schema re-validates everything on save.
  const set = (k: string, v: unknown) => onChange({ ...b, [k]: v } as Block);
  const urlHint = (u: string) => (u && !/^(https?:\/\/.+|mailto:.+|tel:.+|\{\{.+\}\})$/i.test(u.trim()) ? <span className="text-danger">Use a full link starting with https://</span> : undefined);
  return (
    <div className="space-y-4">
      {(() => {
        switch (b.type) {
          case "heading":
            return (
              <>
                <Field label="Text" htmlFor="bp-h"><Input id="bp-h" value={b.text} onChange={(e) => set("text", e.target.value)} maxLength={500} /></Field>
                <Field label="Size" htmlFor="bp-hl">
                  <Select id="bp-hl" value={String(b.level)} onChange={(e) => set("level", Number(e.target.value) as 1 | 2 | 3)}>
                    <option value="1">Large</option><option value="2">Medium</option><option value="3">Small</option>
                  </Select>
                </Field>
                <AlignPicker value={b.align} onChange={(v) => set("align", v)} />
                <ColorField label="Colour" value={b.color} onChange={(v) => set("color", v)} allowDefault />
              </>
            );
          case "text":
            return (
              <>
                <TextWithTags id="bp-t" label="Text" value={b.text} onChange={(v) => set("text", v)} mergeTags={mergeTags} rows={8} hint={FORMAT_HINT} />
                <AlignPicker value={b.align} onChange={(v) => set("align", v)} />
                <NumberField label="Font size" value={b.fontSize} min={12} max={24} unit="px" onChange={(v) => set("fontSize", v)} />
                <ColorField label="Colour" value={b.color} onChange={(v) => set("color", v)} allowDefault />
              </>
            );
          case "button":
            return (
              <>
                <Field label="Label" htmlFor="bp-bl"><Input id="bp-bl" value={b.label} onChange={(e) => set("label", e.target.value)} maxLength={200} /></Field>
                <Field label="Link" htmlFor="bp-bu" hint={urlHint(b.url) ?? (b.url.trim() ? undefined : "Add the page this button opens.")}><Input id="bp-bu" value={b.url} onChange={(e) => set("url", e.target.value)} placeholder="https://" /></Field>
                <AlignPicker value={b.align} onChange={(v) => set("align", v)} />
                <ColorField label="Button colour" value={b.color} onChange={(v) => v && set("color", v)} />
                <ColorField label="Text colour" value={b.textColor} onChange={(v) => v && set("textColor", v)} />
                <NumberField label="Corner radius" value={b.radius} min={0} max={40} unit="px" onChange={(v) => set("radius", v)} />
                <Checkbox label="Full width" checked={b.fullWidth} onChange={(v) => set("fullWidth", v)} />
              </>
            );
          case "image":
            return (
              <>
                <Field label="Image URL" htmlFor="bp-is" hint={b.src && !/^https?:\/\//i.test(b.src) ? <span className="text-danger">Use a public https:// image link</span> : "A public https:// link (PNG, JPG or GIF)."}>
                  <Input id="bp-is" value={b.src} onChange={(e) => set("src", e.target.value)} placeholder="https://…/banner.png" />
                </Field>
                <Field label="Alt text" htmlFor="bp-ia" hint="Shown when images are blocked, and read by screen readers."><Input id="bp-ia" value={b.alt} onChange={(e) => set("alt", e.target.value)} maxLength={300} /></Field>
                <Field label="Link (optional)" htmlFor="bp-iu" hint={urlHint(b.url)}><Input id="bp-iu" value={b.url} onChange={(e) => set("url", e.target.value)} placeholder="https://" /></Field>
                <NumberField label="Width" value={b.width} min={10} max={100} unit="%" onChange={(v) => set("width", v)} />
                <AlignPicker value={b.align} onChange={(v) => set("align", v)} />
              </>
            );
          case "divider":
            return (
              <>
                <ColorField label="Colour" value={b.color} onChange={(v) => v && set("color", v)} />
                <NumberField label="Thickness" value={b.thickness} min={1} max={8} unit="px" onChange={(v) => set("thickness", v)} />
              </>
            );
          case "spacer":
            return <NumberField label="Height" value={b.height} min={4} max={160} unit="px" onChange={(v) => set("height", v)} />;
          case "columns":
            return (
              <>
                {b.columns.map((c, i) => (
                  <fieldset key={i} className="space-y-3 rounded-md border border-border p-3">
                    <legend className="px-1 text-xs font-medium">{i === 0 ? "Left" : "Right"} column</legend>
                    <Field label="Image URL (optional)" htmlFor={`bp-c${i}i`}><Input id={`bp-c${i}i`} value={c.image} onChange={(e) => set("columns", b.columns.map((x, j) => (j === i ? { ...x, image: e.target.value } : x)))} placeholder="https://" /></Field>
                    <TextWithTags id={`bp-c${i}t`} label="Text" value={c.text} rows={4} onChange={(v) => set("columns", b.columns.map((x, j) => (j === i ? { ...x, text: v } : x)))} mergeTags={mergeTags} />
                  </fieldset>
                ))}
                <p className="text-xs text-fg-muted">{FORMAT_HINT}</p>
              </>
            );
          case "social":
            return (
              <>
                {b.links.map((l, i) => (
                  <div key={i} className="flex items-end gap-2">
                    <Field label={i === 0 ? "Label" : undefined} className="w-28"><Input aria-label="Label" value={l.label} onChange={(e) => set("links", b.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} maxLength={40} /></Field>
                    <Field label={i === 0 ? "Link" : undefined} className="min-w-0 flex-1"><Input aria-label="Link" value={l.url} onChange={(e) => set("links", b.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} /></Field>
                    <Button size="icon" variant="ghost" aria-label="Remove link" onClick={() => set("links", b.links.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => set("links", [...b.links, { label: "", url: "" }])} disabled={b.links.length >= 8}><Plus className="h-3.5 w-3.5" /> Add link</Button>
                <AlignPicker value={b.align} onChange={(v) => set("align", v)} />
              </>
            );
          case "footer":
            return <TextWithTags id="bp-f" label="Footer text" value={b.text} onChange={(v) => set("text", v)} mergeTags={mergeTags} rows={4} hint="An Unsubscribe link is always added below. Include your postal address to comply with anti-spam laws." />;
          case "html":
            return (
              <Field label="HTML" htmlFor="bp-html" hint="Inserted as-is inside the email. Use inline styles; most email apps ignore <style> and scripts.">
                <Textarea id="bp-html" rows={14} className="font-mono text-xs" spellCheck={false} value={b.html} onChange={(e) => set("html", e.target.value)} />
              </Field>
            );
        }
      })()}
    </div>
  );
}

function SettingsPanel({ settings: s, onChange, onStarter }: { settings: DesignSettings; onChange: (p: Partial<DesignSettings>) => void; onStarter: (k: "blank" | "newsletter" | "promotion") => void }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-muted">Select a block on the canvas to edit it.</p>
      <ColorField label="Page background" value={s.backgroundColor} onChange={(v) => v && onChange({ backgroundColor: v })} />
      <ColorField label="Email background" value={s.contentBackground} onChange={(v) => v && onChange({ contentBackground: v })} />
      <ColorField label="Text colour" value={s.textColor} onChange={(v) => v && onChange({ textColor: v })} />
      <ColorField label="Link colour" value={s.linkColor} onChange={(v) => v && onChange({ linkColor: v })} />
      <Field label="Font" htmlFor="ds-font">
        <Select id="ds-font" value={s.font} onChange={(e) => onChange({ font: e.target.value as DesignSettings["font"] })}>
          {Object.entries(FONT_STACKS).map(([k, v]) => <option key={k} value={k}>{v.split(",")[0].replace(/'/g, "")}</option>)}
        </Select>
      </Field>
      <NumberField label="Width" value={s.width} min={480} max={800} unit="px" onChange={(v) => onChange({ width: v })} />
      <fieldset className="space-y-2 border-t border-border pt-4">
        <legend className="text-xs font-medium tracking-wide text-fg-muted uppercase">Start over from</legend>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onStarter("newsletter")}>Newsletter</Button>
          <Button size="sm" variant="outline" onClick={() => onStarter("promotion")}>Promotion</Button>
          <Button size="sm" variant="outline" onClick={() => onStarter("blank")}>Blank</Button>
        </div>
      </fieldset>
    </div>
  );
}

export interface EmailContent {
  contentHtml: string;
  design: EmailDesign | null;
}

/**
 * Email content in either mode: a drag-and-drop design (opens the builder) or raw HTML.
 * Switching to HTML keeps the rendered HTML; switching to visual starts a new design.
 */
export function EmailContentField({ value, onChange, mergeTags, title, idPrefix }: { value: EmailContent; onChange: (v: EmailContent) => void; mergeTags: string[]; title: string; idPrefix: string }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const setDesign = (design: EmailDesign) => onChange({ design, contentHtml: renderDesign(design, { title }) });
  const mode = value.design ? "visual" : "html";

  const switchMode = async (next: "visual" | "html") => {
    if (next === mode) return;
    if (next === "html") {
      if (await confirm({ title: "Edit as HTML?", description: "You'll keep the current email as HTML, but it can't be edited in the visual builder afterwards.", confirmText: "Switch to HTML" })) onChange({ design: null, contentHtml: value.contentHtml });
      return;
    }
    if (value.contentHtml.trim() && !(await confirm({ title: "Start a visual design?", description: "The current HTML is replaced by a new drag-and-drop design.", confirmText: "Start designing", destructive: true }))) return;
    setDesign(starterDesign("newsletter"));
    setOpen(true);
  };

  return (
    <Field
      label={
        <span className="flex flex-wrap items-center justify-between gap-2">
          Content
          <Tabs value={mode} onChange={(m) => void switchMode(m)} tabs={[{ value: "visual", label: "Visual builder" }, { value: "html", label: "HTML" }]} />
        </span>
      }
      htmlFor={mode === "html" ? `${idPrefix}-html` : undefined}
      hint="An unsubscribe link is added automatically if the email doesn't have one."
    >
      {value.design ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium">{value.design.blocks.length} block{value.design.blocks.length === 1 ? "" : "s"}</p>
            <p className="text-xs text-fg-muted">Drag-and-drop design · mobile-friendly HTML is generated for you</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <AiEmailDraftButton
              onDraft={(d) => {
                const keep = value.design?.blocks.find((b) => b.type === "footer");
                const blocks: Block[] = [
                  { ...newBlock("heading"), text: d.heading } as Block,
                  { ...newBlock("text"), text: d.paragraphs.join("\n\n") } as Block,
                  ...(d.buttonLabel ? [{ ...newBlock("button"), label: d.buttonLabel } as Block] : []),
                  newBlock("divider"),
                  keep ?? newBlock("footer"),
                ];
                setDesign({ ...(value.design ?? starterDesign("blank")), blocks });
                setOpen(true);
              }}
            />
            <Button type="button" onClick={() => setOpen(true)}>Open builder</Button>
          </div>
        </div>
      ) : (
        <>
          <MergeTagButtons tags={mergeTags} onInsert={(tag) => onChange({ design: null, contentHtml: insertAtCursor(htmlRef.current, value.contentHtml, tag) })} />
          <Textarea id={`${idPrefix}-html`} ref={htmlRef} rows={12} className="font-mono text-xs" spellCheck={false} value={value.contentHtml} onChange={(e) => onChange({ design: null, contentHtml: e.target.value })} />
        </>
      )}
      {open && value.design && <EmailBuilder value={value.design} onChange={setDesign} onClose={() => setOpen(false)} mergeTags={mergeTags} title={title} />}
    </Field>
  );
}
