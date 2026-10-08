import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Facebook, Instagram, Plug, Send, Trash2 } from "lucide-react";
import { SOCIAL_LABELS, type PublicSocialAccount } from "@shared/social";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Switch } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, PageHeader, PageLoader } from "@/components/ui/display";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";
import { CopyText } from "./api-keys";

const KEY = ["/api/social-accounts"];
const Icon = ({ platform, className }: { platform: string; className?: string }) => (platform === "instagram" ? <Instagram className={className} /> : <Facebook className={className} />);

export default function SocialPage() {
  const { can } = useAuth();
  const { channels } = useChannel();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery<{ data: PublicSocialAccount[] }>({ queryKey: KEY });
  const hook = useQuery<{ url: string; verifyTokenConfigured: boolean }>({ queryKey: ["/api/webhook/global-url"] });
  const [connectOpen, setConnectOpen] = useState(false);
  const [tokenFor, setTokenFor] = useState<PublicSocialAccount | null>(null);
  const [simFor, setSimFor] = useState<PublicSocialAccount | null>(null);
  const manage = can("settings:edit");
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; enabled?: boolean; humanAgentTag?: boolean; channelId?: string }) => apiRequest("PUT", `/api/social-accounts/${id}`, body),
    onSuccess: invalidate,
    onError: (err) => toast({ title: "Could not update", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({ mutationFn: (id: string) => apiRequest("DELETE", `/api/social-accounts/${id}`), onSuccess: invalidate });

  if (isLoading) return <PageLoader />;
  const accounts = data?.data ?? [];
  return (
    <PageContainer>
      <PageHeader
        title="Instagram & Messenger"
        description="Answer Instagram Direct and Facebook Messenger in the same inbox as WhatsApp."
        actions={manage && <Button onClick={() => setConnectOpen(true)}><Plug className="h-4 w-4" /> Connect a Page</Button>}
      />
      <div className="flex flex-col gap-6">
        {accounts.length === 0 ? (
          <Card>
            <EmptyState icon={<Instagram className="h-10 w-10" />} title="Nothing connected yet" description="Connect a Facebook Page to receive its Messenger chats, and the Instagram professional account linked to it." action={manage && <Button onClick={() => setConnectOpen(true)}><Plug className="h-4 w-4" /> Connect a Page</Button>} />
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {accounts.map((a) => (
                <li key={a.id} className="flex flex-col gap-3 p-5 lg:flex-row lg:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-subtle"><Icon platform={a.platform} className="h-5 w-5" /></span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {a.name} <Badge>{SOCIAL_LABELS[a.platform]}</Badge>
                        {a.simulated && <Badge tone="warning">Test connection</Badge>}
                        {a.status === "error" && <Badge tone="danger">Needs attention</Badge>}
                      </p>
                      <p className="text-xs text-fg-muted">Page {a.pageId} · connected {formatDate(a.connectedAt)}</p>
                      {a.lastError && <p className="mt-1 text-xs text-danger">{a.lastError}</p>}
                    </div>
                  </div>
                  {manage && (
                    <div className="flex flex-wrap items-center gap-3">
                      <Field label={<span className="sr-only">Inbox</span>} className="w-44">
                        <Select aria-label="Inbox" value={a.channelId} onChange={(e) => update.mutate({ id: a.id, channelId: e.target.value })}>
                          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </Select>
                      </Field>
                      <Switch label="Human Agent tag" checked={a.humanAgentTag} onChange={(humanAgentTag) => update.mutate({ id: a.id, humanAgentTag })} />
                      <Switch label="On" checked={a.enabled} onChange={(enabled) => update.mutate({ id: a.id, enabled })} />
                      {a.simulated && <Button size="sm" variant="outline" onClick={() => setSimFor(a)}><Send className="h-3.5 w-3.5" /> Test message</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setTokenFor(a)}>New token</Button>
                      <Button size="icon" variant="ghost" aria-label={`Disconnect ${a.name}`} onClick={async () => { if (await confirm({ title: `Disconnect ${a.name}?`, description: "New messages stop arriving. Existing conversations stay in the inbox.", confirmText: "Disconnect", destructive: true })) remove.mutate(a.id); }}>
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader title="Setup in your Meta app" description="The same Meta app you use for WhatsApp." />
          <ol className="list-decimal space-y-2 p-5 pl-10 text-sm">
            <li>In developers.facebook.com, add the <b>Messenger</b> and <b>Instagram</b> products to your app.</li>
            <li>
              Under Webhooks, subscribe the <b>Page</b> and <b>Instagram</b> objects to this callback URL (same verify token as WhatsApp), with the fields <code>messages</code>, <code>message_echoes</code>, <code>message_deliveries</code>, <code>message_reads</code> and <code>messaging_postbacks</code>:
              {hook.data && (
                <span className="mt-1 flex items-center gap-1 font-mono text-xs break-all">{hook.data.url}<CopyText text={hook.data.url} label="callback URL" /></span>
              )}
            </li>
            <li>Get a <b>Page access token</b> with <code>pages_messaging</code>, <code>pages_manage_metadata</code>, <code>pages_show_list</code>, <code>instagram_basic</code> and <code>instagram_manage_messages</code> (Graph API Explorer or a system user in Business Settings; system-user tokens don't expire).</li>
            <li>Click <b>Connect a Page</b>, paste the Page ID and token. We subscribe the Page to your app automatically.</li>
            <li>Turn on <b>Human Agent tag</b> only if Meta approved your app for it: it lets people reply up to 7 days after the customer's last message instead of 24 hours.</li>
          </ol>
          <p className="border-t border-border px-5 py-3 text-xs text-fg-muted">Conversations land in the inbox you pick for each account, next to WhatsApp chats. <Link href="/inbox" className="text-primary hover:underline">Open the inbox</Link></p>
        </Card>
      </div>

      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
      <TokenDialog account={tokenFor} onClose={() => setTokenFor(null)} />
      <SimulateDialog account={simFor} onClose={() => setSimFor(null)} />
    </PageContainer>
  );
}

function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { channels, activeChannel } = useChannel();
  const [v, setV] = useState({ channelId: activeChannel?.id ?? "", pageId: "", accessToken: "", messenger: true, instagram: true, humanAgentTag: false });
  const connect = useMutation({
    mutationFn: () => apiRequest<{ data: PublicSocialAccount[] }>("POST", "/api/social-accounts", { ...v, channelId: v.channelId || activeChannel?.id }),
    onSuccess: (r) => {
      toast({ title: "Connected", description: r.data.map((a) => `${SOCIAL_LABELS[a.platform]}: ${a.name}`).join(" · "), variant: "success" });
      void queryClient.invalidateQueries({ queryKey: KEY });
      setV({ ...v, pageId: "", accessToken: "" });
      onClose();
    },
    onError: (err) => toast({ title: "Could not connect", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect a Facebook Page"
      footer={<Button onClick={() => connect.mutate()} loading={connect.isPending} disabled={!v.pageId.trim() || v.accessToken.trim().length < 8 || (!v.messenger && !v.instagram)}>Connect</Button>}
    >
      <div className="flex flex-col gap-4">
        <Field label="Inbox" htmlFor="sc-ch" hint="Conversations from this Page land here.">
          <Select id="sc-ch" value={v.channelId || activeChannel?.id || ""} onChange={(e) => setV({ ...v, channelId: e.target.value })}>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Facebook Page ID" htmlFor="sc-page"><Input id="sc-page" inputMode="numeric" value={v.pageId} onChange={(e) => setV({ ...v, pageId: e.target.value.trim() })} placeholder="102938475610293" /></Field>
        <Field label="Page access token" htmlFor="sc-token" hint={<>Stored encrypted. For a test without Meta, <button type="button" className="text-primary hover:underline" onClick={() => setV({ ...v, accessToken: "simulator", pageId: v.pageId || String(Date.now()).slice(-12) })}>use a test connection</button>.</>}>
          <Input id="sc-token" type="password" autoComplete="off" value={v.accessToken} onChange={(e) => setV({ ...v, accessToken: e.target.value })} placeholder="EAAG…" />
        </Field>
        <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
          <legend className="mb-2 text-sm font-medium">Connect</legend>
          <Checkbox label="Messenger" checked={v.messenger} onChange={(messenger) => setV({ ...v, messenger })} />
          <Checkbox label="Instagram (linked to the Page)" checked={v.instagram} onChange={(instagram) => setV({ ...v, instagram })} />
        </fieldset>
        <Checkbox label="My app is approved for the Human Agent tag (7-day replies)" checked={v.humanAgentTag} onChange={(humanAgentTag) => setV({ ...v, humanAgentTag })} />
      </div>
    </Dialog>
  );
}

function TokenDialog({ account, onClose }: { account: PublicSocialAccount | null; onClose: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/social-accounts/${account!.id}`, { accessToken: token }),
    onSuccess: () => {
      toast({ title: "Token updated", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: KEY });
      setToken("");
      onClose();
    },
    onError: (err) => toast({ title: "Token not accepted", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog open={Boolean(account)} onClose={onClose} size="sm" title="Replace the Page access token" footer={<Button onClick={() => save.mutate()} loading={save.isPending} disabled={token.trim().length < 8}>Save</Button>}>
      <Field label="New Page access token" htmlFor="sc-new"><Input id="sc-new" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
    </Dialog>
  );
}

function SimulateDialog({ account, onClose }: { account: PublicSocialAccount | null; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("Hi! Is this still available?");
  const [sender, setSender] = useState<string | undefined>();
  const send = useMutation({
    mutationFn: () => apiRequest<{ data: { senderId: string } }>("POST", `/api/social-accounts/${account!.id}/simulate`, { text, senderId: sender }),
    onSuccess: (r) => {
      setSender(r.data.senderId);
      toast({ title: "Test message delivered", description: "It's in the inbox now.", variant: "success" });
    },
    onError: (err) => toast({ title: "Could not simulate", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog open={Boolean(account)} onClose={() => { setSender(undefined); onClose(); }} title={`Send a test ${account ? SOCIAL_LABELS[account.platform] : ""} message`} description="Pretends a customer wrote to this account. Sending again continues the same conversation." footer={<Button onClick={() => send.mutate()} loading={send.isPending} disabled={!text.trim()}><Send className="h-4 w-4" /> Send</Button>}>
      <Field label="Message" htmlFor="sim-text"><Input id="sim-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} /></Field>
    </Dialog>
  );
}
