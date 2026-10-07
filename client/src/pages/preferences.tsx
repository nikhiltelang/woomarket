import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Moon } from "lucide-react";
import { COMMON_TIMEZONES, SEND_CHANNELS, type SendingPreferences } from "@shared/sending";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { channelMeta } from "@/lib/channels";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Switch } from "@/components/ui/form";
import { Card, CardHeader, PageHeader, PageLoader } from "@/components/ui/display";
import { useToast } from "@/components/ui/overlay";

const KEY = "/api/settings/sending";

/** Every IANA zone this browser knows (falls back to a short list). */
function allZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return COMMON_TIMEZONES;
  }
}

export default function PreferencesPage() {
  const toast = useToast();
  const { user, can } = useAuth();
  const canEdit = user?.role === "admin" && can("settings:edit");
  const { data, isLoading } = useQuery<{ data: SendingPreferences }>({ queryKey: [KEY] });
  const [v, setV] = useState<SendingPreferences | null>(null);
  useEffect(() => {
    if (data) setV(structuredClone(data.data));
  }, [data]);
  const zones = useMemo(() => {
    const all = allZones();
    return [...new Set(["UTC", ...COMMON_TIMEZONES, ...all])];
  }, []);
  const save = useMutation({
    mutationFn: () => apiRequest("PUT", KEY, v),
    onSuccess: () => {
      toast({ title: "Sending preferences saved", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [KEY] });
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  if (isLoading || !v) return <PageLoader />;
  const q = v.quietHours;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <PageContainer>
      <PageHeader title="Sending preferences" description="When campaigns and automations may reach your contacts." actions={canEdit && <Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button>} />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Time zone" description="Used for contacts whose time zone isn't known (no “timezone” field and no recognisable phone country)." />
          <div className="p-5">
            <Field label="Default time zone" htmlFor="tz" hint={browserZone !== v.timezone ? <button className="text-primary hover:underline" onClick={() => setV({ ...v, timezone: browserZone })} disabled={!canEdit}>Use mine ({browserZone})</button> : undefined}>
              <Select id="tz" value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })} className="max-w-sm" disabled={!canEdit}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
              </Select>
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Quiet hours" description="Messages that would arrive during this window in a contact's own time zone wait until it ends. Replies in the inbox and chatbot answers aren't affected." />
          <div className="space-y-4 p-5">
            <Switch checked={q.enabled} onChange={(enabled) => setV({ ...v, quietHours: { ...q, enabled } })} label={q.enabled ? "Quiet hours are on" : "Quiet hours are off"} disabled={!canEdit} />
            {q.enabled && (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="From" htmlFor="qh-start"><Input id="qh-start" type="time" className="w-32" value={q.start} onChange={(e) => setV({ ...v, quietHours: { ...q, start: e.target.value } })} disabled={!canEdit} /></Field>
                  <Field label="Until" htmlFor="qh-end"><Input id="qh-end" type="time" className="w-32" value={q.end} onChange={(e) => setV({ ...v, quietHours: { ...q, end: e.target.value } })} disabled={!canEdit} /></Field>
                  <p className="flex items-center gap-1.5 pb-2 text-sm text-fg-muted"><Moon className="h-4 w-4" /> {q.start > q.end ? "overnight" : "same day"}</p>
                </div>
                <fieldset>
                  <legend className="mb-2 text-sm font-medium">Applies to</legend>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {SEND_CHANNELS.map((c) => (
                      <Checkbox
                        key={c}
                        label={channelMeta(c).label}
                        checked={q.channels.includes(c)}
                        onChange={(on) => setV({ ...v, quietHours: { ...q, channels: on ? [...new Set([...q.channels, c])] : q.channels.filter((x) => x !== c) } })}
                        disabled={!canEdit}
                      />
                    ))}
                  </div>
                </fieldset>
                <p className="text-xs text-fg-muted">Messages sent through the API skip quiet hours unless the request sets <code>respectQuietHours: true</code>, since they're often time-sensitive (codes, order updates).</p>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Best time" description="“Best time” delivery picks the hour each contact most often opened, clicked, read or replied. Contacts without history get this hour, in their time zone." />
          <div className="p-5">
            <Field label="Default hour" htmlFor="best-hour">
              <Select id="best-hour" value={String(v.defaultBestHour)} onChange={(e) => setV({ ...v, defaultBestHour: Number(e.target.value) })} className="w-32" disabled={!canEdit}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </Select>
            </Field>
          </div>
        </Card>
      </div>
    </PageContainer>
  );
}
