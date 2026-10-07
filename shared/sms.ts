/** SMS segment maths (GSM 03.38 vs UCS-2), shared by the composer UI and the server. */

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

const basic = new Set(GSM_BASIC);
const extended = new Set(GSM_EXTENDED);

export interface SegmentInfo {
  encoding: "GSM-7" | "UCS-2";
  /** Characters counted against the limit (GSM extension chars count twice). */
  units: number;
  segments: number;
  perSegment: number;
  remaining: number;
  /** Characters that forced UCS-2, if any. */
  nonGsmChars: string[];
}

export function calculateSegments(text: string): SegmentInfo {
  const chars = [...text];
  const nonGsm = chars.filter((c) => !basic.has(c) && !extended.has(c));
  if (nonGsm.length === 0) {
    const units = chars.reduce((n, c) => n + (extended.has(c) ? 2 : 1), 0);
    const single = units <= 160;
    const perSegment = single ? 160 : 153;
    const segments = units === 0 ? 0 : Math.ceil(units / perSegment);
    return { encoding: "GSM-7", units, segments, perSegment, remaining: segments * perSegment - units, nonGsmChars: [] };
  }
  // UCS-2 counts UTF-16 code units (emoji take two).
  const units = text.length;
  const single = units <= 70;
  const perSegment = single ? 70 : 67;
  const segments = Math.ceil(units / perSegment);
  return { encoding: "UCS-2", units, segments, perSegment, remaining: segments * perSegment - units, nonGsmChars: [...new Set(nonGsm)].slice(0, 10) };
}

/** Placeholders supported in SMS and email bodies (plus any custom contact field, e.g. {{age}}). */
export const MERGE_TAGS = ["{{name}}", "{{first_name}}", "{{phone}}", "{{email}}"] as const;

const BUILT_IN = new Set(["name", "first_name", "phone", "email", "unsubscribe_url"]);

export function renderMergeTags(
  text: string,
  values: { name?: string | null; phone?: string | null; email?: string | null; fields?: Record<string, string> | null },
  escape?: (s: string) => string,
): string {
  const e = escape ?? ((s: string) => s);
  const first = (values.name ?? "").trim().split(/\s+/)[0] ?? "";
  const out = text
    .replace(/\{\{\s*first_name\s*\}\}/gi, e(first))
    .replace(/\{\{\s*name\s*\}\}/gi, e(values.name ?? ""))
    .replace(/\{\{\s*phone\s*\}\}/gi, e(values.phone ?? ""))
    .replace(/\{\{\s*email\s*\}\}/gi, e(values.email ?? ""));
  // Custom fields. A field the contact doesn't have renders empty rather than as "{{age}}".
  // Without `fields` (previews, tests) unknown tags are left untouched.
  if (!values.fields) return out;
  const fields = values.fields;
  return out.replace(/\{\{\s*([a-z][a-z0-9_]{0,49})\s*\}\}/gi, (m, key: string) => {
    const k = key.toLowerCase();
    return BUILT_IN.has(k) ? m : e(fields[k] ?? "");
  });
}