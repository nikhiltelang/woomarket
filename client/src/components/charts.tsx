import { useState } from "react";
import { cn, formatNumber } from "@/lib/utils";

export interface Series {
  key: string;
  label: string;
  /** Tailwind background class from the validated chart palette. */
  color: string;
}

const niceMax = (v: number) => {
  if (v <= 4) return Math.max(1, Math.ceil(v));
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
};

/**
 * Vertical bar chart (one or more series per category). One y-axis, a legend for
 * 2+ series, a per-category hover tooltip and a screen-reader table.
 */
export function BarChart<T extends Record<string, number | string>>({
  data,
  series,
  labelKey,
  formatLabel,
  formatTooltipLabel,
  caption,
  height = 176,
}: {
  data: T[];
  series: Series[];
  labelKey: keyof T;
  formatLabel?: (v: string) => string;
  formatTooltipLabel?: (v: string) => string;
  caption: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))));
  const ticks = [max, max / 2, 0];
  // Room for ~7 labels; the rest stay unlabelled (the tooltip has every date).
  const every = Math.max(1, Math.ceil(data.length / 7));
  const fmt = formatLabel ?? ((v: string) => v);

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-fg-muted" aria-hidden>
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className={cn("h-2.5 w-2.5 rounded-sm", s.color)} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2" aria-hidden>
        <div className="flex flex-col justify-between pb-5 text-right text-[11px] text-fg-muted tabular-nums" style={{ height }}>
          {ticks.map((t, i) => (
            <span key={i}>{formatNumber(Math.round(t))}</span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 bottom-5 flex flex-col justify-between">
            {ticks.map((_, i) => (
              <div key={i} className="border-t border-border/70" />
            ))}
          </div>
          <div className="relative flex items-stretch" style={{ height }}>
            {data.map((d, i) => (
              <div key={i} className="relative flex min-w-0 flex-1 flex-col" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <div className={cn("flex flex-1 items-end justify-center gap-[2px] rounded-t-sm px-[1px]", hover === i && "bg-subtle/70")}>
                  {series.map((s) => {
                    const v = Number(d[s.key]) || 0;
                    return <div key={s.key} className={cn("w-full max-w-4 rounded-t-[4px]", s.color)} style={{ height: `${(v / max) * 100}%`, minHeight: v ? 2 : 0 }} />;
                  })}
                </div>
                <span className="relative h-5 pt-1 text-[10px] text-fg-muted">
                  {i % every === 0 && <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{fmt(String(d[labelKey]))}</span>}
                </span>
                {hover === i && (
                  <div className={cn("absolute bottom-full z-10 mb-1 w-40 rounded-md border border-border bg-surface p-2 text-xs shadow-lg", i > data.length / 2 ? "right-0" : "left-0")}>
                    <p className="mb-1 font-medium">{(formatTooltipLabel ?? fmt)(String(d[labelKey]))}</p>
                    {series.map((s) => (
                      <p key={s.key} className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-fg-muted">
                          <span className={cn("h-2 w-2 rounded-sm", s.color)} />
                          {s.label}
                        </span>
                        <span className="font-medium tabular-nums">{formatNumber(Number(d[s.key]) || 0)}</span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th>{String(labelKey)}</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}>
              <td>{String(d[labelKey])}</td>
              {series.map((s) => (
                <td key={s.key}>{Number(d[s.key]) || 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ranked horizontal bars with direct value labels (part-of-whole for a handful of categories). */
export function RankedBars({ items, total, emptyText }: { items: { name: string; count: number }[]; total: number; emptyText: string }) {
  if (!items.length) return <p className="py-8 text-center text-sm text-fg-muted">{emptyText}</p>;
  const max = Math.max(...items.map((i) => i.count));
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.name}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span>{i.name}</span>
            <span className="text-fg-muted tabular-nums">
              {formatNumber(i.count)} <span className="text-xs">({total ? Math.round((i.count / total) * 100) : 0}%)</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-subtle">
            <div className="h-full rounded-full bg-series-1" style={{ width: `${(i.count / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
