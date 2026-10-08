import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { ArrowLeft, MessageCircleMore, Pencil, Plus, Trash2 } from "lucide-react";
import { whatsappLink, widgetSettingsSchema, type WidgetInput, type WidgetSettings } from "@shared/widget";
import type { ChatWidget } from "@shared/schema";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { apiRequest, queryClient } from "@/lib/api";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, PageHeader, PageLoader } from "@/components/ui/display";
import { useConfirm, useToast } from "@/components/ui/overlay";
import { Code } from "./api-keys";

const KEY = ["/api/widgets"];
const defaults = (): WidgetSettings => widgetSettingsSchema.parse({});

export default function WidgetPage() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const { data, isLoading } = useQuery<{ data: ChatWidget[] }>({ queryKey: KEY });
  const [editing, setEditing] = useState<ChatWidget | "new" | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/widgets/${id}`),
    onSuccess: () => {
      toast({ title: "Widget deleted", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  if (isLoading) return <PageLoader />;
  if (editing) return <Editor widget={editing === "new" ? null : editing} onDone={(w) => setEditing(w ?? null)} onBack={() => setEditing(null)} />;
  const list = data?.data ?? [];
  const manage = can("settings:edit");
  return (
    <PageContainer>
      <PageHeader
        title="Website chat widget"
        description="Add a chat button to your website. Visitors can message you live (it lands in your inbox) or jump to WhatsApp."
        actions={manage && <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> New widget</Button>}
      />
      {list.length === 0 ? (
        <Card>
          <EmptyState icon={<MessageCircleMore className="h-10 w-10" />} title="No widgets yet" description="Create a widget, then paste one line of code into your website." action={manage && <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> New widget</Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((w) => {
            const s = widgetSettingsSchema.safeParse(w.settings).data ?? defaults();
            return (
              <Card key={w.id} className="flex flex-col gap-3 p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white" style={{ background: s.color }}><MessageCircleMore className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{w.name}</p>
                    <p className="text-xs text-fg-muted">{[s.liveChat.enabled && "Live chat", s.whatsapp.enabled && "WhatsApp button"].filter(Boolean).join(" · ") || "Nothing turned on"}</p>
                  </div>
                  {!w.enabled && <Badge tone="warning">Off</Badge>}
                </div>
                <p className="text-xs text-fg-muted">{w.allowedOrigins.length ? `Allowed on ${w.allowedOrigins.join(", ")}` : "Allowed on any website"}</p>
                {manage && (
                  <div className="mt-auto flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => setEditing(w)}><Pencil className="h-3.5 w-3.5" /> Edit & install</Button>
                    <Button size="icon" variant="ghost" aria-label={`Delete ${w.name}`} onClick={async () => { if (await confirm({ title: `Delete “${w.name}”?`, description: "The chat button disappears from websites using it. Existing conversations stay in the inbox.", confirmText: "Delete", destructive: true })) remove.mutate(w.id); }}>
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}

function Editor({ widget, onDone, onBack }: { widget: ChatWidget | null; onDone: (w: ChatWidget) => void; onBack: () => void }) {
  const toast = useToast();
  const { channels, activeChannel } = useChannel();
  const [v, setV] = useState<WidgetInput>(() => ({
    name: widget?.name ?? "Website chat",
    channelId: widget?.channelId ?? activeChannel?.id ?? channels[0]?.id ?? "",
    enabled: widget?.enabled ?? true,
    settings: widgetSettingsSchema.safeParse(widget?.settings ?? {}).data ?? defaults(),
    allowedOrigins: widget?.allowedOrigins ?? [],
  }));
  const [origins, setOrigins] = useState((widget?.allowedOrigins ?? []).join("\n"));
  const [previewKey, setPreviewKey] = useState(0);
  const s = v.settings;
  const set = (patch: Partial<WidgetSettings>) => setV({ ...v, settings: { ...s, ...patch } });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...v, allowedOrigins: origins.split(/[\s,]+/).map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean) };
      return widget ? apiRequest<{ data: ChatWidget }>("PUT", `/api/widgets/${widget.id}`, body) : apiRequest<{ data: ChatWidget }>("POST", "/api/widgets", body);
    },
    onSuccess: (r) => {
      toast({ title: "Widget saved", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: KEY });
      setPreviewKey((k) => k + 1);
      onDone(r.data);
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  const channel = channels.find((c) => c.id === v.channelId);
  const phone = s.whatsapp.phone || channel?.phoneNumber || "";
  const link = phone ? whatsappLink(phone, s.whatsapp.prefill) : "";
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (!link) return setQr(null);
    void QRCode.toDataURL(link, { margin: 1, width: 160 }).then(setQr);
  }, [link]);
  const snippet = widget ? `<script src="${window.location.origin}/widget.js" data-widget="${widget.id}" async></script>` : "";
  const previewDoc = useMemo(
    () => (widget ? `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;font-family:system-ui;background:#eef2f7;min-height:100vh"><div style="padding:24px;color:#475569">Your website</div><script src="${window.location.origin}/widget.js" data-widget="${widget.id}" data-preview="true"></script></body></html>` : ""),
    [widget],
  );

  return (
    <PageContainer wide>
      <PageHeader
        title={widget ? `Edit “${widget.name}”` : "New widget"}
        actions={
          <>
            <Button variant="outline" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.name.trim() || !v.channelId}>{widget ? "Save" : "Create widget"}</Button>
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="flex flex-col gap-4 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="w-name" hint="Only you see this."><Input id="w-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={100} /></Field>
              <Field label="Inbox" htmlFor="w-channel" hint="Website chats land in this number's inbox.">
                <Select id="w-channel" value={v.channelId} onChange={(e) => setV({ ...v, channelId: e.target.value })}>
                  {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            </div>
            <Switch label="Widget is on" description="Turn off to hide it from every website without removing the code." checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} />
          </Card>

          <Card>
            <CardHeader title="Look and text" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="Colour" htmlFor="w-color">
                <div className="flex gap-2">
                  <input type="color" aria-label="Colour picker" value={s.color} onChange={(e) => set({ color: e.target.value })} className="h-9 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5" />
                  <Input id="w-color" value={s.color} onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && set({ color: e.target.value })} className="font-mono" maxLength={7} />
                </div>
              </Field>
              <Field label="Position" htmlFor="w-pos">
                <Select id="w-pos" value={s.position} onChange={(e) => set({ position: e.target.value as "left" | "right" })}>
                  <option value="right">Bottom right</option>
                  <option value="left">Bottom left</option>
                </Select>
              </Field>
              <Field label="Title" htmlFor="w-title"><Input id="w-title" value={s.title} onChange={(e) => set({ title: e.target.value })} maxLength={60} /></Field>
              <Field label="Subtitle" htmlFor="w-sub"><Input id="w-sub" value={s.subtitle} onChange={(e) => set({ subtitle: e.target.value })} maxLength={120} /></Field>
              <Field label="Greeting" htmlFor="w-greet" className="sm:col-span-2"><Textarea id="w-greet" rows={2} value={s.greeting} onChange={(e) => set({ greeting: e.target.value })} maxLength={500} /></Field>
              <Field label="Show after (seconds)" htmlFor="w-delay"><Input id="w-delay" type="number" min={0} max={120} value={s.delaySeconds} onChange={(e) => set({ delaySeconds: Math.min(120, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Live chat" description="Visitors type in the widget; you answer from the inbox." />
            <div className="flex flex-col gap-3 p-5">
              <Switch label="Live chat" checked={s.liveChat.enabled} onChange={(enabled) => set({ liveChat: { ...s.liveChat, enabled } })} />
              {s.liveChat.enabled && (
                <>
                  <p className="text-sm font-medium">Ask visitors for</p>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    <Checkbox label="Name" checked={s.liveChat.askName} onChange={(askName) => set({ liveChat: { ...s.liveChat, askName } })} />
                    <Checkbox label="Email" checked={s.liveChat.askEmail} onChange={(askEmail) => set({ liveChat: { ...s.liveChat, askEmail } })} />
                    <Checkbox label="Phone (links the chat to a contact)" checked={s.liveChat.askPhone} onChange={(askPhone) => set({ liveChat: { ...s.liveChat, askPhone } })} />
                  </div>
                  <Checkbox label="Required before the first message" checked={s.liveChat.requireDetails} onChange={(requireDetails) => set({ liveChat: { ...s.liveChat, requireDetails } })} />
                </>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Chat on WhatsApp" description="A button that opens WhatsApp with your message ready to send." />
            <div className="flex flex-col gap-4 p-5">
              <Switch label="WhatsApp button" checked={s.whatsapp.enabled} onChange={(enabled) => set({ whatsapp: { ...s.whatsapp, enabled } })} />
              {s.whatsapp.enabled && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="WhatsApp number" htmlFor="w-wa" hint={`Leave empty to use ${channel?.phoneNumber ?? "the inbox's number"}.`}>
                    <Input id="w-wa" value={s.whatsapp.phone} onChange={(e) => set({ whatsapp: { ...s.whatsapp, phone: e.target.value.trim() } })} placeholder="+919812345678" />
                  </Field>
                  <Field label="Button text" htmlFor="w-wal"><Input id="w-wal" value={s.whatsapp.label} onChange={(e) => set({ whatsapp: { ...s.whatsapp, label: e.target.value } })} maxLength={40} /></Field>
                  <Field label="Pre-filled message" htmlFor="w-wap" className="sm:col-span-2"><Input id="w-wap" value={s.whatsapp.prefill} onChange={(e) => set({ whatsapp: { ...s.whatsapp, prefill: e.target.value } })} maxLength={300} /></Field>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Where it can be used" />
            <div className="p-5">
              <Field label="Allowed websites" htmlFor="w-origins" hint="One per line, like https://shop.example.com or https://*.example.com. Leave empty to allow any site (anyone could then embed your widget).">
                <Textarea id="w-origins" rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} className="font-mono text-xs" placeholder="https://www.example.com" />
              </Field>
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader title="Install" description={widget ? "Paste before </body> on every page." : "Create the widget to get the code."} />
            <div className="flex flex-col gap-3 p-5">
              {widget ? <Code>{snippet}</Code> : <p className="text-sm text-fg-muted">Not created yet.</p>}
              {widget && <p className="text-xs text-fg-muted">Works with any site builder that lets you add custom HTML (WordPress, Shopify, Wix, Webflow…).</p>}
            </div>
          </Card>
          {widget && (
            <Card>
              <CardHeader title="Preview" description="Shows the saved version. Save to see changes." />
              <iframe key={previewKey} title="Widget preview" srcDoc={previewDoc} sandbox="allow-scripts allow-same-origin allow-popups" className="h-[620px] w-full rounded-b-lg border-0 bg-white" />
            </Card>
          )}
          {link && (
            <Card>
              <CardHeader title="WhatsApp link and QR code" description="For emails, social posts, packaging and posters." />
              <div className="flex flex-wrap items-center gap-4 p-5">
                {qr && <img src={qr} alt="QR code that opens a WhatsApp chat" width={140} height={140} className="rounded border border-border bg-white" />}
                <div className="min-w-0 flex-1">
                  <Code>{link}</Code>
                  {qr && <a href={qr} download="whatsapp-qr.png" className="mt-2 inline-block text-sm text-primary hover:underline">Download QR code</a>}
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </PageContainer>
  );
}
