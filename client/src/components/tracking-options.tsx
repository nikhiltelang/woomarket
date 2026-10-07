import { useQuery } from "@tanstack/react-query";
import { MousePointerClick } from "lucide-react";
import type { UtmSettings } from "@shared/schema";
import { slugify } from "@shared/tracking";
import { usePlatform } from "@/contexts/platform";
import { formatNumber } from "@/lib/utils";
import { Checkbox, Field, Input, Switch } from "@/components/ui/form";
import { Card, CardHeader, EmptyState } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";

export interface TrackingValue {
  trackClicks: boolean;
  utm: UtmSettings;
}
export const DEFAULT_UTM: UtmSettings = { enabled: false, source: "", medium: "", campaign: "", content: "" };

/** "Track clicks" and UTM settings in the email and SMS composers. */
export function TrackingOptions({ channel, value, onChange, campaignName }: { channel: "email" | "sms"; value: TrackingValue; onChange: (v: TrackingValue) => void; campaignName: string }) {
  const { config } = usePlatform();
  const utm = value.utm;
  const setUtm = (patch: Partial<UtmSettings>) => onChange({ ...value, utm: { ...utm, ...patch } });
  const defaults = { source: slugify(config?.siteTitle ?? "") || "newsletter", medium: channel, campaign: slugify(campaignName) || "campaign-name" };
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">Links</legend>
      <Checkbox
        checked={value.trackClicks}
        onChange={(trackClicks) => onChange({ ...value, trackClicks })}
        label={channel === "email" ? "Track link clicks" : "Shorten and track links"}
      />
      {channel === "sms" && value.trackClicks && <p className="-mt-1 text-xs text-fg-muted">Each link becomes a short tracked link (about 30 characters), which can change the number of SMS parts.</p>}
      <Switch checked={Boolean(utm.enabled)} onChange={(enabled) => setUtm({ enabled })} label="Add UTM parameters" description="So visits show up by campaign in Google Analytics and similar tools. Links that already have them are left alone." />
      {utm.enabled && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="utm_source" htmlFor={`${channel}-utm-s`}><Input id={`${channel}-utm-s`} value={utm.source ?? ""} placeholder={defaults.source} onChange={(e) => setUtm({ source: e.target.value })} /></Field>
          <Field label="utm_medium" htmlFor={`${channel}-utm-m`}><Input id={`${channel}-utm-m`} value={utm.medium ?? ""} placeholder={defaults.medium} onChange={(e) => setUtm({ medium: e.target.value })} /></Field>
          <Field label="utm_campaign" htmlFor={`${channel}-utm-c`}><Input id={`${channel}-utm-c`} value={utm.campaign ?? ""} placeholder={defaults.campaign} onChange={(e) => setUtm({ campaign: e.target.value })} /></Field>
        </div>
      )}
    </fieldset>
  );
}

interface LinkRow {
  id: number;
  url: string;
  originalUrl: string;
  clicks: number;
  uniqueClicks: number;
}

/** Clicks per link for a sent campaign. */
export function LinkStats({ type, campaignId, delivered }: { type: "email" | "sms"; campaignId: string; delivered: number }) {
  const { data } = useQuery<{ data: LinkRow[] }>({ queryKey: [`/api/${type}-marketing/campaigns/${campaignId}/links`], refetchInterval: 10_000 });
  const rows = data?.data ?? [];
  return (
    <Card>
      <CardHeader title="Link clicks" description="Unique clicks count each recipient once per link. Clicks by link scanners aren't counted." />
      {!rows.length ? (
        <EmptyState icon={<MousePointerClick className="h-8 w-8" />} title="No tracked links" description="Links are tracked when the campaign is sent with click tracking on." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Link</Th>
              <Th className="text-right">Unique clicks</Th>
              <Th className="text-right">Total</Th>
              <Th className="text-right">Click rate</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <Tr key={l.id}>
                <Td className="max-w-md">
                  <a href={l.url} target="_blank" rel="noreferrer" className="block truncate font-mono text-xs text-primary hover:underline" title={l.url}>{l.originalUrl}</a>
                  {l.url !== l.originalUrl && <span className="block truncate text-[11px] text-fg-muted" title={l.url}>with UTM</span>}
                </Td>
                <Td className="text-right tabular-nums">{formatNumber(l.uniqueClicks)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(l.clicks)}</Td>
                <Td className="text-right tabular-nums">{delivered ? `${Math.round((l.uniqueClicks / delivered) * 1000) / 10}%` : "—"}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
