import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { fieldLabel, MAX_CONTACT_FIELDS, normalizeFieldKey, RESERVED_FIELD_KEYS } from "@shared/contact-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";

export interface FieldRow {
  key: string;
  value: string;
}

/** Custom field names in use (for suggestions and merge-tag pickers). */
export function useContactFields(channelId?: string | null) {
  return useQuery<{ data: { key: string; contacts: number }[] }>({ queryKey: ["/api/contacts/fields", channelId ? { channelId } : {}], staleTime: 60_000 });
}

export const rowsFromMetadata = (m: Record<string, string> | null | undefined): FieldRow[] => Object.entries(m ?? {}).map(([key, value]) => ({ key, value }));
export const metadataFromRows = (rows: FieldRow[]) => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

/** Problems the server would reject, shown inline before saving. */
export function fieldRowError(rows: FieldRow[], i: number): string | null {
  const raw = rows[i].key.trim();
  if (!raw) return rows[i].value.trim() ? "Give this field a name" : null;
  const key = normalizeFieldKey(raw);
  if (!key) return "Use letters or numbers in the name";
  if (RESERVED_FIELD_KEYS.has(key)) return `"${raw}" is a built-in contact field`;
  if (rows.some((r, j) => j < i && normalizeFieldKey(r.key) === key)) return "Already added";
  return null;
}

/** Key/value editor for a contact's custom fields (age, address, …). */
export function CustomFieldsEditor({ rows, onChange, suggestions = [] }: { rows: FieldRow[]; onChange: (rows: FieldRow[]) => void; suggestions?: string[] }) {
  const listId = useId();
  const set = (i: number, patch: Partial<FieldRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const used = new Set(rows.map((r) => normalizeFieldKey(r.key)));
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium">Custom fields</legend>
      <p className="mb-2 text-xs text-fg-muted">
        Any extra details, like age or address. Use them in messages as merge tags, e.g. <code>{"{{age}}"}</code>.
      </p>
      <datalist id={listId}>
        {suggestions.filter((s) => !used.has(s)).map((s) => <option key={s} value={s}>{fieldLabel(s)}</option>)}
      </datalist>
      <div className="space-y-2">
        {rows.map((r, i) => {
          const err = fieldRowError(rows, i);
          const key = normalizeFieldKey(r.key);
          return (
            <div key={i}>
              <div className="flex gap-2">
                <Input list={listId} placeholder="Field, e.g. age" value={r.key} onChange={(e) => set(i, { key: e.target.value })} className="w-40 shrink-0 sm:w-48" aria-label={`Field ${i + 1} name`} invalid={Boolean(err)} />
                <Input placeholder="Value" value={r.value} maxLength={1000} onChange={(e) => set(i, { value: e.target.value })} className="min-w-0 flex-1" aria-label={`Field ${i + 1} value`} />
                <Button size="icon" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove field ${r.key || i + 1}`}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {err ? (
                <p className="mt-0.5 text-xs text-danger">{err}</p>
              ) : key && key !== r.key.trim() ? (
                <p className="mt-0.5 text-xs text-fg-muted">Saved as <code>{`{{${key}}}`}</code></p>
              ) : null}
            </div>
          );
        })}
      </div>
      {rows.length < MAX_CONTACT_FIELDS && (
        <Button size="sm" variant="outline" className="mt-2" onClick={() => onChange([...rows, { key: "", value: "" }])}>
          <Plus className="h-3.5 w-3.5" /> Add field
        </Button>
      )}
    </fieldset>
  );
}
