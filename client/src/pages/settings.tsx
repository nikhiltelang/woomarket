import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, FlaskConical, MessageSquarePlus, Phone, Plus, Trash2 } from "lucide-react";
import type { PublicChannel } from "@shared/api-types";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { ChannelShell } from "@/components/channel-shell";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, PageLoader, StatusBadge } from "@/components/ui/display";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

function AddChannelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { setActiveChannelId } = useChannel();
  const [method, setMethod] = useState<"manual" | "simulator">("manual");
  const [v, setV] = useState({ name: "", phoneNumberId: "", whatsappBusinessAccountId: "", accessToken: "", phoneNumber: "" });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ data: PublicChannel; health: { status: string; details: Record<string, unknown> } }>(
        "POST",
        "/api/channels",
        method === "manual" ? { connectionMethod: "manual", ...v, phoneNumber: v.phoneNumber || undefined } : { connectionMethod: "simulator", name: v.name, phoneNumber: v.phoneNumber || undefined },
      ),
    onSuccess: (r) => {
      if (r.health.status === "error") {
        toast({ title: "Number saved, but Meta rejected the credentials", description: String(r.health.details.error ?? ""), variant: "warning" });
      } else {
        toast({ title: "WhatsApp number connected", variant: "success" });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
      setActiveChannelId(r.data.id);
      setV({ name: "", phoneNumberId: "", whatsappBusinessAccountId: "", accessToken: "", phoneNumber: "" });
      onClose();
    },
    onError: (err) => toast({ title: "Could not connect number", description: (err as Error).message, variant: "error" }),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect a WhatsApp number"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!v.name.trim()}>
            Connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Connection" htmlFor="ch-method">
          <Select id="ch-method" value={method} onChange={(e) => setMethod(e.target.value as "manual" | "simulator")}>
            <option value="manual">WhatsApp Cloud API (Meta credentials)</option>
            <option value="simulator">Simulator — test without Meta</option>
          </Select>
        </Field>
        {method === "simulator" && (
          <p className="rounded-md bg-info-soft px-3 py-2 text-sm text-info">
            The simulator accepts sends and plays back sent → delivered → read receipts. Numbers ending in 0000 fail, to test error handling. No real messages are sent.
          </p>
        )}
        <Field label="Display name" htmlFor="ch-name">
          <Input id="ch-name" value={v.name} onChange={set("name")} placeholder="e.g. Support line" />
        </Field>
        <Field label="Phone number" htmlFor="ch-phone" hint="Shown to your team; e.g. +14155550123">
          <Input id="ch-phone" value={v.phoneNumber} onChange={set("phoneNumber")} />
        </Field>
        {method === "manual" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone number ID" htmlFor="ch-pnid">
                <Input id="ch-pnid" value={v.phoneNumberId} onChange={set("phoneNumberId")} inputMode="numeric" />
              </Field>
              <Field label="WhatsApp Business Account ID" htmlFor="ch-waba">
                <Input id="ch-waba" value={v.whatsappBusinessAccountId} onChange={set("whatsappBusinessAccountId")} inputMode="numeric" />
              </Field>
            </div>
            <Field label="Permanent access token" htmlFor="ch-token" hint="From a Meta system user with whatsapp_business_messaging and whatsapp_business_management permissions. Stored encrypted when ENCRYPTION_KEY is set.">
              <Textarea id="ch-token" rows={3} value={v.accessToken} onChange={set("accessToken")} autoComplete="off" spellCheck={false} />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}

function SimulateDialog({ channel, onClose }: { channel: PublicChannel | null; onClose: () => void }) {
  const toast = useToast();
  const [from, setFrom] = useState("+14155550123");
  const [name, setName] = useState("Test Customer");
  const [text, setText] = useState("Hi! Is the summer sale still on?");
  const send = useMutation({
    mutationFn: () => apiRequest("POST", `/api/channels/${channel!.id}/simulate-inbound`, { from, name, text }),
    onSuccess: () => {
      toast({ title: "Message delivered to the inbox", variant: "success" });
      onClose();
    },
    onError: (err) => toast({ title: "Could not simulate", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog
      open={Boolean(channel)}
      onClose={onClose}
      title="Simulate an incoming message"
      description="Pretend a customer messaged this number. It arrives through the same webhook pipeline as real WhatsApp traffic."
      footer={
        <Button onClick={() => send.mutate()} loading={send.isPending}>
          Send to inbox
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer number" htmlFor="sim-from">
            <Input id="sim-from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Profile name" htmlFor="sim-name">
            <Input id="sim-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field label="Message" htmlFor="sim-text">
          <Textarea id="sim-text" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

export default function SettingsPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [simulating, setSimulating] = useState<PublicChannel | null>(null);
  const { data, isLoading } = useQuery<{ data: PublicChannel[] }>({ queryKey: ["/api/channels"] });
  const webhook = useQuery<{ url: string; verifyTokenConfigured: boolean }>({ queryKey: ["/api/webhook/global-url"] });

  const health = useMutation({
    mutationFn: (id: string) => apiRequest<{ health: { status: string } }>("POST", `/api/channels/${id}/health`),
    onSuccess: (r) => {
      toast({ title: `Health: ${r.health.status}`, variant: r.health.status === "healthy" ? "success" : "warning" });
      void queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
    },
  });
  const toggle = useMutation({
    mutationFn: (c: PublicChannel) => apiRequest("PUT", `/api/channels/${c.id}`, { isActive: !c.isActive }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/channels"] }),
    onError: (err) => toast({ title: "Update failed", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/channels/${id}`),
    onSuccess: () => {
      toast({ title: "Number disconnected", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
    },
    onError: (err) => toast({ title: "Delete failed", description: (err as Error).message, variant: "error" }),
  });

  if (isLoading) return <PageLoader />;
  const channels = data?.data ?? [];

  return (
    <ChannelShell
      channel="whatsapp"
      description="Connect and monitor the WhatsApp Business numbers your team sends from."
      actions={
        can("settings:edit") &&
        user?.role === "admin" && (
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Connect number
          </Button>
        )
      }
    >
      {channels.length === 0 ? (
        <Card>
          <EmptyState icon={<Phone className="h-10 w-10" />} title="No numbers connected" description="Connect a WhatsApp Cloud API number, or start with the simulator to try everything out." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {channels.map((c) => (
            <Card key={c.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 font-semibold">
                    <span className="truncate">{c.name}</span>
                    {c.connectionMethod === "simulator" && (
                      <Badge tone="info">
                        <FlaskConical className="h-3 w-3" /> simulator
                      </Badge>
                    )}
                  </h2>
                  <p className="text-sm text-fg-muted">{c.phoneNumber ?? "No display number"}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge status={c.healthStatus} />
                  {!c.isActive && <Badge>inactive</Badge>}
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <dt className="text-fg-muted">Quality rating</dt>
                  <dd className="font-medium">{String(c.healthDetails.qualityRating ?? "—")}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Messaging tier</dt>
                  <dd className="font-medium">{String(c.healthDetails.messagingLimitTier ?? "—")}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Phone number ID</dt>
                  <dd className="truncate font-mono">{c.phoneNumberId}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Last checked</dt>
                  <dd>{formatDate(c.lastHealthCheck)}</dd>
                </div>
                {c.connectionMethod !== "simulator" && (
                  <div>
                    <dt className="text-fg-muted">Access token</dt>
                    <dd className="font-mono">{c.tokenPreview}</dd>
                  </div>
                )}
                {typeof c.healthDetails.error === "string" && (
                  <div className="col-span-2 text-danger">{c.healthDetails.error}</div>
                )}
              </dl>
              <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
                <Button size="sm" variant="outline" onClick={() => health.mutate(c.id)} loading={health.isPending && health.variables === c.id}>
                  <Activity className="h-3.5 w-3.5" /> Check health
                </Button>
                {c.connectionMethod === "simulator" && (
                  <Button size="sm" variant="outline" onClick={() => setSimulating(c)}>
                    <MessageSquarePlus className="h-3.5 w-3.5" /> Simulate incoming
                  </Button>
                )}
                {can("settings:edit") && (
                  <Button size="sm" variant="outline" onClick={() => toggle.mutate(c)}>
                    {c.isActive ? "Deactivate" : "Activate"}
                  </Button>
                )}
                {can("settings:edit") && user?.role === "admin" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-danger"
                    onClick={async () => {
                      if (await confirm({ title: `Disconnect "${c.name}"?`, description: "All contacts, conversations, templates and campaigns of this number are deleted. This cannot be undone.", confirmText: "Disconnect", destructive: true })) {
                        remove.mutate(c.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Disconnect
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {webhook.data && (
        <Card className="mt-6">
          <CardHeader title="Meta webhook" description="Configure this callback URL in your Meta app and subscribe to messages and message_template_status_update." />
          <div className="space-y-2 p-5 text-sm">
            <p>
              Callback URL: <code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-xs break-all">{webhook.data.url}</code>
            </p>
            <p className="text-fg-muted">
              Verify token: {webhook.data.verifyTokenConfigured ? "configured on the server (WEBHOOK_VERIFY_TOKEN)" : "not configured — set WEBHOOK_VERIFY_TOKEN on the server"}
            </p>
          </div>
        </Card>
      )}

      <AddChannelDialog open={adding} onClose={() => setAdding(false)} />
      <SimulateDialog channel={simulating} onClose={() => setSimulating(null)} />
    </ChannelShell>
  );
}
