import type { ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FlaskConical, Trophy } from "lucide-react";
import { AB_METRIC_LABEL, type AbMetric, type AbResults } from "@shared/ab-test";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, formatDate, formatNumber, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Select, Switch } from "@/components/ui/form";
import { Badge, Card, CardHeader } from "@/components/ui/display";
import { useConfirm, useToast } from "@/components/ui/overlay";

export interface AbCommon {
  enabled: boolean;
  testPercent: number;
  waitHours: number;
  metric: AbMetric;
}

export const DEFAULT_AB: AbCommon = { enabled: false, testPercent: 20, waitHours: 4, metric: "open" };

/** A/B settings shared by every channel; `children` holds the channel's variant B fields. */
export function AbTestFields<T extends AbCommon>({ value, onChange, metrics, audience, children }: { value: T; onChange: (v: T) => void; metrics: AbMetric[]; audience?: number; children: ReactNode }) {
  const test = audience ? Math.max(2, Math.round((audience * value.testPercent) / 100)) : null;
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">A/B test</legend>
      <Switch checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} label="Test two versions first" description="Send A and B to a sample, then the better one to everyone else." />
      {value.enabled && (
        <>
          {children}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Test group" htmlFor="ab-size" hint={test && value.testPercent < 100 ? `${formatNumber(Math.ceil(test / 2))} get A, ${formatNumber(Math.floor(test / 2))} get B` : undefined}>
              <Select id="ab-size" value={String(value.testPercent)} onChange={(e) => onChange({ ...value, testPercent: Number(e.target.value) })}>
                {[10, 20, 30, 40, 50].map((p) => <option key={p} value={p}>{p}% of the audience</option>)}
                <option value={100}>Everyone (50/50)</option>
              </Select>
            </Field>
            <Field label="Winner by" htmlFor="ab-metric">
              <Select id="ab-metric" value={value.metric} onChange={(e) => onChange({ ...value, metric: e.target.value as AbMetric })} disabled={metrics.length === 1}>
                {metrics.map((m) => <option key={m} value={m}>{AB_METRIC_LABEL[m]}</option>)}
              </Select>
            </Field>
            <Field label="Decide after" htmlFor="ab-wait">
              <Select id="ab-wait" value={String(value.waitHours)} onChange={(e) => onChange({ ...value, waitHours: Number(e.target.value) })}>
                {[1, 2, 4, 8, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h} hour{h === 1 ? "" : "s"}</option>)}
              </Select>
            </Field>
          </div>
          {value.testPercent < 100 && <p className="text-xs text-fg-muted">The rest of the audience waits for the winner. Audiences under 4 people aren't tested.</p>}
        </>
      )}
    </fieldset>
  );
}

interface Overview {
  enabled: boolean;
  phase?: "testing" | "decided" | "skipped";
  metric?: AbMetric;
  testPercent?: number;
  waitHours?: number;
  testEndsAt?: string;
  decidedAt?: string;
  decidedBy?: "auto" | "manual";
  winner?: "A" | "B" | null;
  held?: number;
  results?: AbResults;
  live?: AbResults | null;
  templateNameB?: string | null;
}

/** Results card for a campaign's A/B test, with "pick the winner now". */
export function AbTestResults({ basePath, campaignId, labels }: { basePath: string; campaignId: string; labels: { A: ReactNode; B: ReactNode | ((ab: { templateNameB?: string | null }) => ReactNode) } }) {
  const toast = useToast();
  const confirm = useConfirm();
  const key = [`${basePath}/${campaignId}/ab`];
  const { data } = useQuery<{ data: Overview | null }>({ queryKey: key, refetchInterval: 10_000 });
  const decide = useMutation({
    mutationFn: (winner?: "A" | "B") => apiRequest("POST", `${basePath}/${campaignId}/ab/decide`, winner ? { winner } : {}),
    onSuccess: () => {
      toast({ title: "Winner chosen", description: "Sending it to the rest of the audience.", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: [`${basePath}/${campaignId}`] });
    },
    onError: (err) => toast({ title: "Could not decide", description: (err as Error).message, variant: "error" }),
  });
  const ab = data?.data;
  if (!ab?.enabled) return null;
  const r = ab.phase === "decided" ? (ab.live ?? ab.results) : ab.live;
  const metric = ab.metric ?? "open";
  const leader = r ? (r.B.rate > r.A.rate ? "B" : r.A.rate > r.B.rate ? "A" : null) : null;

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><FlaskConical className="h-4 w-4" /> A/B test</span>}
        description={
          ab.phase === "testing"
            ? `Testing on ${ab.testPercent === 100 ? "everyone" : `${ab.testPercent}% of the audience`} · winner by ${AB_METRIC_LABEL[metric].toLowerCase()} ${ab.testEndsAt ? relativeTime(ab.testEndsAt) : ""}`
            : ab.phase === "decided"
              ? `Variant ${ab.winner} won${ab.decidedBy === "manual" ? " (chosen manually)" : ""} · ${formatDate(ab.decidedAt)}`
              : ab.phase === "skipped"
                ? "Not tested: the audience was too small, so everyone got variant A."
                : "Starts when the campaign is sent."
        }
        actions={
          ab.phase === "testing" && (
            <Button
              size="sm"
              variant="outline"
              loading={decide.isPending}
              onClick={async () => {
                if (await confirm({ title: "Pick the winner now?", description: `The variant with the better ${AB_METRIC_LABEL[metric].toLowerCase()} so far goes to the ${formatNumber(ab.held)} people still waiting.`, confirmText: "Pick winner" })) decide.mutate(undefined);
              }}
            >
              <Trophy className="h-3.5 w-3.5" /> Pick winner now
            </Button>
          )
        }
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {(["A", "B"] as const).map((v) => {
          const s = r?.[v];
          const won = ab.phase === "decided" && ab.winner === v;
          return (
            <div key={v} className={cn("rounded-lg border p-4", won ? "border-success bg-success-soft/40" : "border-border")}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">Variant {v}</span>
                {won ? <Badge tone="success"><Trophy className="h-3 w-3" /> Winner</Badge> : ab.phase === "testing" && leader === v ? <Badge tone="info">Leading</Badge> : null}
              </div>
              <div className="mt-1 line-clamp-2 text-xs break-words text-fg-muted">{typeof labels[v] === "function" ? (labels[v] as (a: Overview) => ReactNode)(ab) : (labels[v] as ReactNode)}</div>
              <p className="mt-3 text-2xl font-semibold tabular-nums">{s ? `${s.rate}%` : "—"}</p>
              <p className="text-xs text-fg-muted">
                {AB_METRIC_LABEL[metric]} · {formatNumber(s?.hits)} of {formatNumber(s?.sent)}
              </p>
              {ab.phase === "testing" && (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => decide.mutate(v)} disabled={decide.isPending}>
                  Send {v} to everyone else
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
