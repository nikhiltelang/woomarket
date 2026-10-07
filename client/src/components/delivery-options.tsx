import { useQuery } from "@tanstack/react-query";
import { Moon } from "lucide-react";
import { Link } from "wouter";
import type { Delivery, SendingPreferences } from "@shared/sending";
import { Field, Input, Select } from "@/components/ui/form";

export const DEFAULT_DELIVERY: Delivery = { mode: "immediate", localTime: "10:00" };

/** "When does each contact get it" in the WhatsApp, email and SMS composers. */
export function DeliveryOptions({ value, onChange, channel, idPrefix }: { value: Delivery; onChange: (d: Delivery) => void; channel: "whatsapp" | "email" | "sms"; idPrefix: string }) {
  const { data } = useQuery<{ data: SendingPreferences }>({ queryKey: ["/api/settings/sending"], staleTime: 60_000 });
  const q = data?.data.quietHours;
  const quietOn = q?.enabled && q.channels.includes(channel);
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">Delivery</legend>
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <Field label="Each contact gets it" htmlFor={`${idPrefix}-mode`}>
          <Select id={`${idPrefix}-mode`} value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as Delivery["mode"] })}>
            <option value="immediate">As soon as possible</option>
            <option value="local_time">At a set time in their time zone</option>
            <option value="best_time">At their best time (from past engagement)</option>
          </Select>
        </Field>
        {value.mode === "local_time" && (
          <Field label="Local time" htmlFor={`${idPrefix}-lt`}>
            <Input id={`${idPrefix}-lt`} type="time" value={value.localTime ?? "10:00"} onChange={(e) => onChange({ ...value, localTime: e.target.value })} />
          </Field>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        {value.mode === "local_time"
          ? "Sent the next time it's this time where each contact is (within 24 hours of sending). Time zones come from a contact's “timezone” field, or their phone's country."
          : value.mode === "best_time"
            ? "Sent within 24 hours, at the hour each contact most often opened, clicked, read or replied before. Contacts without history get your default hour."
            : "Sent right away."}
      </p>
      <p className="flex items-start gap-1.5 text-xs text-fg-muted">
        <Moon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {quietOn ? (
          <span>Quiet hours ({q!.start}–{q!.end} in each contact's time zone) hold messages until the morning.</span>
        ) : (
          <span>
            No quiet hours for this channel. <Link href="/preferences" className="text-primary hover:underline">Set quiet hours</Link>
          </span>
        )}
      </p>
    </fieldset>
  );
}
