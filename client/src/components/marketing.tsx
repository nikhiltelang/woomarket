import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { Group, Segment } from "@shared/schema";
import { useChannel } from "@/contexts/channel";
import { parseCsv } from "@/lib/csv";
import { formatNumber } from "@/lib/utils";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/display";

export type AudienceType = "all_contacts" | "group" | "segment" | "csv";

export interface AudienceValue<Row> {
  targetAudience: AudienceType;
  targetGroupId: string;
  targetSegmentId?: string;
  csvData: Row[];
}

type GroupRow = Group & { contactCount: number };

/**
 * Audience selector shared by the email and SMS composers. `parseRow` turns a CSV row into
 * a recipient (or null when the row lacks the required column).
 */
export function AudiencePicker<Row>({
  kind,
  value,
  onChange,
  parseRow,
  csvHint,
}: {
  kind: "email" | "sms";
  value: AudienceValue<Row>;
  onChange: (v: AudienceValue<Row>) => void;
  parseRow: (r: Record<string, string>) => Row | null;
  csvHint: string;
}) {
  const { activeChannel } = useChannel();
  const channelId = activeChannel!.id;
  const [csvInfo, setCsvInfo] = useState<{ name: string; skipped: number } | null>(null);
  const groups = useQuery<{ data: GroupRow[] }>({ queryKey: ["/api/groups", { channelId }] });
  const segments = useQuery<{ data: Segment[] }>({ queryKey: ["/api/segments"], enabled: value.targetAudience === "segment" });
  const countParams =
    value.targetAudience === "csv"
      ? null
      : { channelId, targetAudience: value.targetAudience, targetGroupId: value.targetGroupId || undefined, targetSegmentId: value.targetSegmentId || undefined };
  const count = useQuery<{ count: number }>({
    queryKey: [`/api/${kind}-marketing/audience`, countParams ?? {}],
    enabled: Boolean(countParams) && (value.targetAudience !== "group" || Boolean(value.targetGroupId)) && (value.targetAudience !== "segment" || Boolean(value.targetSegmentId)),
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const rows = parseCsv(await file.text());
    const parsed = rows.map(parseRow);
    const ok = parsed.filter((r): r is Row => r !== null);
    setCsvInfo({ name: file.name, skipped: parsed.length - ok.length });
    onChange({ ...value, csvData: ok });
  };

  const size = value.targetAudience === "csv" ? value.csvData.length : count.data?.count;

  return (
    <div className="flex flex-col gap-3">
      <Field label="Audience" htmlFor={`${kind}-aud`}>
        <Select id={`${kind}-aud`} value={value.targetAudience} onChange={(e) => onChange({ ...value, targetAudience: e.target.value as AudienceType })}>
          <option value="all_contacts">All active contacts on {activeChannel!.name}</option>
          <option value="group">A contact group</option>
          <option value="segment">A segment (saved filter)</option>
          <option value="csv">Upload a CSV list</option>
        </Select>
      </Field>
      {value.targetAudience === "group" && (
        <Select value={value.targetGroupId} onChange={(e) => onChange({ ...value, targetGroupId: e.target.value })} aria-label="Group">
          <option value="">Choose a group…</option>
          {groups.data?.data.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({formatNumber(g.contactCount)})
            </option>
          ))}
        </Select>
      )}
      {value.targetAudience === "segment" && (
        <Field hint={segments.data && !segments.data.data.length ? <>No segments yet. <Link href="/segments" className="text-primary hover:underline">Create one</Link></> : "Matched when the campaign starts, so new contacts who fit are included."}>
          <Select value={value.targetSegmentId ?? ""} onChange={(e) => onChange({ ...value, targetSegmentId: e.target.value })} aria-label="Segment">
            <option value="">Choose a segment…</option>
            {segments.data?.data.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {value.targetAudience === "csv" && (
        <Field hint={csvHint}>
          <Input type="file" accept=".csv,text/csv" className="pt-1.5" onChange={(e) => void onFile(e.target.files?.[0])} aria-label="CSV file" />
        </Field>
      )}
      <p className="text-xs text-fg-muted">
        {(value.targetAudience === "group" && !value.targetGroupId) || (value.targetAudience === "segment" && !value.targetSegmentId) ? null : size === undefined ? (
          "Counting recipients…"
        ) : (
          <>
            <Badge tone="primary">{formatNumber(size)} recipients</Badge>{" "}
            {value.targetAudience === "csv" && csvInfo && csvInfo.skipped > 0 && `${csvInfo.skipped} rows skipped (missing or invalid ${kind === "email" ? "email" : "phone"}).`}
            {value.targetAudience !== "csv" && (kind === "email" ? " Contacts without an email, inactive or unsubscribed are excluded." : " Inactive and unsubscribed contacts are excluded.")}
          </>
        )}
      </p>
    </div>
  );
}

/** Inserts text at the cursor of a textarea/input and returns the new value. */
export function insertAtCursor(el: HTMLTextAreaElement | HTMLInputElement | null, current: string, text: string): string {
  if (!el) return current + text;
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  const next = current.slice(0, start) + text + current.slice(end);
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(start + text.length, start + text.length);
  });
  return next;
}

export function MergeTagButtons({ tags, onInsert }: { tags: readonly string[]; onInsert: (tag: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <button key={t} type="button" onClick={() => onInsert(t)} className="rounded border border-border bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-fg-muted hover:text-fg">
          {t}
        </button>
      ))}
    </div>
  );
}
