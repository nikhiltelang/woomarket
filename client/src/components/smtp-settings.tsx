import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FlaskConical, PlugZap, Send } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { Card, CardHeader } from "@/components/ui/display";
import { useToast } from "@/components/ui/overlay";

interface SmtpResponse {
  data: { host: string; port: number; secure: boolean; user: string; fromName: string; fromEmail: string; hasPassword: boolean; updatedAt: string } | null;
  effective: { source: "tenant" | "platform" | "env" | "simulator" | "none"; fromEmail?: string; fromName?: string; error?: string };
}

const SOURCE_TEXT: Record<string, string> = {
  tenant: "Sending through your SMTP server.",
  platform: "Sending through the platform's default SMTP server. Add your own below to use your domain.",
  env: "Sending through the server's SMTP configuration (environment variables).",
  simulator: "Simulated: emails are captured on the server and not delivered. Configure SMTP to send real email.",
  none: "No SMTP server configured — email campaigns can't be sent yet.",
};

/** SMTP settings for a tenant, or the platform default when `platform` is set (superadmin). */
export function SmtpSettings({ platform = false, canEdit }: { platform?: boolean; canEdit: boolean }) {
  const toast = useToast();
  const key = [platform ? "/api/admin/getSmtpConfig" : "/api/smtp/config"];
  const { data } = useQuery<SmtpResponse>({ queryKey: key });
  const [v, setV] = useState({ host: "", port: "587", secure: false, user: "", password: "", fromName: "", fromEmail: "" });
  const [sendTo, setSendTo] = useState("");

  useEffect(() => {
    const c = data?.data;
    if (c) setV({ host: c.host, port: String(c.port), secure: c.secure, user: c.user, password: "", fromName: c.fromName, fromEmail: c.fromEmail });
  }, [data?.data]);

  const body = () => ({ ...v, port: Number(v.port), password: v.password || undefined });
  const save = useMutation({
    mutationFn: () => apiRequest("POST", platform ? "/api/admin/smtpConfig" : "/api/smtp/config", body()),
    onSuccess: () => {
      toast({ title: "SMTP settings saved", variant: "success" });
      setV((s) => ({ ...s, password: "" }));
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  const test = useMutation({
    mutationFn: (mode: "connect" | "send") =>
      apiRequest<{ sent: boolean; simulated?: boolean }>("POST", "/api/smtp/test", mode === "connect" ? body() : { sendTo }),
    onSuccess: (r) =>
      toast({ title: r.sent ? (r.simulated ? "Test email captured by the simulator" : "Test email sent") : "Connection successful", variant: "success" }),
    onError: (err) => toast({ title: "Test failed", description: (err as Error).message, variant: "error" }),
  });

  const eff = data?.effective;
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  return (
    <Card>
      <CardHeader
        title={platform ? "Platform SMTP (default for all tenants)" : "SMTP server"}
        description={data?.data ? `Last updated ${formatDate(data.data.updatedAt)}` : "Used to send email campaigns and test emails."}
      />
      <div className="flex flex-col gap-4 p-5">
        {eff && (
          <p className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${eff.source === "none" ? "bg-danger-soft text-danger" : eff.source === "simulator" ? "bg-info-soft text-info" : "bg-success-soft text-success"}`}>
            {eff.source === "simulator" && <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>
              {SOURCE_TEXT[eff.source]}
              {eff.fromEmail && eff.source !== "simulator" && ` From: ${eff.fromName} <${eff.fromEmail}>`}
            </span>
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Host" htmlFor="smtp-host" className="sm:col-span-2">
            <Input id="smtp-host" value={v.host} onChange={set("host")} placeholder="smtp.example.com" disabled={!canEdit} />
          </Field>
          <Field label="Port" htmlFor="smtp-port">
            <Input id="smtp-port" type="number" value={v.port} onChange={set("port")} disabled={!canEdit} />
          </Field>
          <Field label="Username" htmlFor="smtp-user">
            <Input id="smtp-user" value={v.user} onChange={set("user")} autoComplete="off" disabled={!canEdit} />
          </Field>
          <Field label="Password" htmlFor="smtp-pass" hint={data?.data?.hasPassword ? "Leave blank to keep the saved password" : undefined} className="sm:col-span-2">
            <Input id="smtp-pass" type="password" value={v.password} onChange={set("password")} autoComplete="new-password" disabled={!canEdit} />
          </Field>
          <Field label="From name" htmlFor="smtp-fn">
            <Input id="smtp-fn" value={v.fromName} onChange={set("fromName")} disabled={!canEdit} />
          </Field>
          <Field label="From email" htmlFor="smtp-fe" className="sm:col-span-2" hint="Must be allowed by your SMTP provider (SPF/DKIM aligned for good deliverability).">
            <Input id="smtp-fe" type="email" value={v.fromEmail} onChange={set("fromEmail")} disabled={!canEdit} />
          </Field>
        </div>
        <Checkbox label="Use implicit TLS (usually port 465). Leave off for STARTTLS on 587." checked={v.secure} onChange={(secure) => setV((s) => ({ ...s, secure }))} disabled={!canEdit} />
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.host || !v.user || !v.fromEmail || !v.fromName}>
              Save settings
            </Button>
            <Button variant="outline" onClick={() => test.mutate("connect")} loading={test.isPending && test.variables === "connect"} disabled={!v.host || !v.user}>
              <PlugZap className="h-4 w-4" /> Test connection
            </Button>
          </div>
        )}
        {canEdit && eff?.source !== "none" && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Input type="email" className="max-w-xs" placeholder="you@example.com" value={sendTo} onChange={(e) => setSendTo(e.target.value)} aria-label="Send test email to" />
            <Button variant="outline" onClick={() => test.mutate("send")} loading={test.isPending && test.variables === "send"} disabled={!sendTo}>
              <Send className="h-4 w-4" /> Send test email
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
