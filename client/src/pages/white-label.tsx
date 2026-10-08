import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, Globe, Palette, Trash2, Users } from "lucide-react";
import type { Brand } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { PUBLIC_CONFIG_KEY } from "@/contexts/platform";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, PageHeader, PageLoader, StatusBadge } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useConfirm, useToast } from "@/components/ui/overlay";
import { CopyText } from "./api-keys";

interface DomainRow {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  disabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  records: { type: string; name: string; value: string }[];
}
interface State {
  allowed: boolean;
  brand: Brand | null;
  domains: DomainRow[];
  clients: number;
  platformHost?: string;
}
const KEY = ["/api/white-label"];

export default function WhiteLabelPage() {
  const { data, isLoading } = useQuery<{ data: State }>({ queryKey: KEY });
  if (isLoading) return <PageLoader />;
  const s = data?.data;
  if (!s?.allowed) {
    return (
      <PageContainer>
        <PageHeader title="White-label" />
        <Card>
          <EmptyState icon={<Palette className="h-10 w-10" />} title="White-label isn't included in your plan" description="Resell the platform under your own name, logo and domain. Ask the platform administrator to enable white-label for your account." />
        </Card>
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      <PageHeader title="White-label" description="Your own name, look and domain. Businesses that sign up on your domain become your clients." />
      <div className="flex flex-col gap-6">
        <BrandForm brand={s.brand} />
        {s.brand && <Domains domains={s.domains} platformHost={s.platformHost ?? ""} />}
        {s.brand && <Clients count={s.clients} />}
      </div>
    </PageContainer>
  );
}

function BrandForm({ brand }: { brand: Brand | null }) {
  const toast = useToast();
  const [v, setV] = useState({
    name: brand?.name ?? "",
    baseColor: brand?.baseColor ?? "#2563eb",
    supportEmail: brand?.supportEmail ?? "",
    supportUrl: brand?.supportUrl ?? "",
    loginTitle: brand?.loginTitle ?? "",
    loginSubtitle: brand?.loginSubtitle ?? "",
    hidePoweredBy: brand?.hidePoweredBy ?? false,
    allowSignup: brand?.allowSignup ?? true,
  });
  const [files, setFiles] = useState<{ logo?: File; favicon?: File }>({});
  const [remove, setRemove] = useState<{ logo?: boolean; favicon?: boolean }>({});
  const [previews, setPreviews] = useState<{ logo?: string; favicon?: string }>({});
  useEffect(() => {
    const urls = { logo: files.logo ? URL.createObjectURL(files.logo) : undefined, favicon: files.favicon ? URL.createObjectURL(files.favicon) : undefined };
    setPreviews(urls);
    return () => Object.values(urls).forEach((u) => u && URL.revokeObjectURL(u));
  }, [files]);
  const logo = previews.logo ?? (remove.logo ? null : brand?.logo);
  const save = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      for (const [k, val] of Object.entries(v)) fd.append(k, String(val));
      if (files.logo) fd.append("logo", files.logo);
      if (files.favicon) fd.append("favicon", files.favicon);
      if (remove.logo) fd.append("removeLogo", "true");
      if (remove.favicon) fd.append("removeFavicon", "true");
      return apiRequest("PUT", "/api/white-label", fd);
    },
    onSuccess: () => {
      toast({ title: "Brand saved", variant: "success" });
      setFiles({});
      setRemove({});
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: PUBLIC_CONFIG_KEY });
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  const imageInput = (k: "logo" | "favicon", label: string, hint: string) => (
    <Field label={label} htmlFor={`wl-${k}`} hint={hint}>
      <div className="flex items-center gap-3">
        {(previews[k] ?? (remove[k] ? null : brand?.[k])) && <img src={(previews[k] ?? brand?.[k])!} alt="" className="h-10 w-10 rounded border border-border bg-white object-contain p-0.5" />}
        <Input id={`wl-${k}`} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon" className="pt-1.5" onChange={(e) => { const f = e.target.files?.[0]; setFiles((x) => ({ ...x, [k]: f })); setRemove((x) => ({ ...x, [k]: false })); }} />
        {brand?.[k] && !files[k] && !remove[k] && <Button size="sm" variant="ghost" onClick={() => setRemove((x) => ({ ...x, [k]: true }))}>Remove</Button>}
      </div>
    </Field>
  );

  return (
    <Card>
      <CardHeader title="Brand" description="Shown on your domains' sign-in pages and inside the app for you and your clients." />
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand name" htmlFor="wl-name"><Input id="wl-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={100} placeholder="Acme Messaging" /></Field>
            <Field label="Brand colour" htmlFor="wl-color">
              <div className="flex gap-2">
                <input type="color" aria-label="Brand colour picker" value={v.baseColor} onChange={(e) => setV({ ...v, baseColor: e.target.value })} className="h-9 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5" />
                <Input id="wl-color" value={v.baseColor} onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && setV({ ...v, baseColor: e.target.value })} className="font-mono" maxLength={7} />
              </div>
            </Field>
            {imageInput("logo", "Logo", "PNG, JPG or WebP, square works best, up to 2 MB.")}
            {imageInput("favicon", "Favicon", "PNG or ICO, 32×32 or 64×64.")}
            <Field label="Support email" htmlFor="wl-mail"><Input id="wl-mail" type="email" value={v.supportEmail} onChange={(e) => setV({ ...v, supportEmail: e.target.value })} placeholder="support@youragency.com" /></Field>
            <Field label="Help centre link (optional)" htmlFor="wl-url"><Input id="wl-url" value={v.supportUrl} onChange={(e) => setV({ ...v, supportUrl: e.target.value })} placeholder="https://help.youragency.com" /></Field>
            <Field label="Sign-in headline" htmlFor="wl-title"><Input id="wl-title" value={v.loginTitle} onChange={(e) => setV({ ...v, loginTitle: e.target.value })} maxLength={120} placeholder="WhatsApp marketing for your business" /></Field>
            <Field label="Sign-in sub-headline" htmlFor="wl-sub"><Input id="wl-sub" value={v.loginSubtitle} onChange={(e) => setV({ ...v, loginSubtitle: e.target.value })} maxLength={300} /></Field>
          </div>
          <Switch label="Allow sign-ups on my domains" description="New businesses can create accounts on your domains; they appear under Clients." checked={v.allowSignup} onChange={(allowSignup) => setV({ ...v, allowSignup })} />
          <Switch label="Hide “Powered by”" description="Removes the platform's name from your sign-in pages." checked={v.hidePoweredBy} onChange={(hidePoweredBy) => setV({ ...v, hidePoweredBy })} />
          <div>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.name.trim()}>{brand ? "Save brand" : "Create brand"}</Button>
          </div>
        </div>
        {/* Sign-in preview */}
        <div aria-hidden className="overflow-hidden rounded-lg border border-border">
          <div className="p-4 text-white" style={{ background: v.baseColor }}>
            <div className="flex items-center gap-2">
              {logo ? <img src={logo} alt="" className="h-7 w-7 rounded bg-white/90 object-contain p-0.5" /> : <span className="h-7 w-7 rounded bg-white/30" />}
              <span className="font-semibold">{v.name || "Your brand"}</span>
            </div>
            <p className="mt-6 text-lg leading-tight font-semibold">{v.loginTitle || "Sign in"}</p>
            {v.loginSubtitle && <p className="mt-1 text-xs opacity-90">{v.loginSubtitle}</p>}
          </div>
          <div className="space-y-2 bg-surface p-4">
            <div className="h-8 rounded border border-border" />
            <div className="h-8 rounded border border-border" />
            <div className="h-8 rounded text-center text-xs leading-8 text-white" style={{ background: v.baseColor }}>Sign in</div>
            {!v.hidePoweredBy && <p className="pt-1 text-center text-[10px] text-fg-muted">Powered by the platform</p>}
          </div>
        </div>
      </div>
    </Card>
  );
}

function Domains({ domains, platformHost }: { domains: DomainRow[]; platformHost: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [domain, setDomain] = useState("");
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const add = useMutation({
    mutationFn: () => apiRequest("POST", "/api/white-label/domains", { domain }),
    onSuccess: () => {
      setDomain("");
      refresh();
    },
    onError: (err) => toast({ title: "Could not add domain", description: (err as Error).message, variant: "error" }),
  });
  const verify = useMutation({
    mutationFn: (id: string) => apiRequest<{ data: { ok: boolean; error: string | null } }>("POST", `/api/white-label/domains/${id}/verify`),
    onSuccess: (r) => {
      toast({ title: r.data.ok ? "Domain verified" : "Not verified yet", description: r.data.error ?? "Your domain now shows your brand.", variant: r.data.ok ? "success" : "warning" });
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => apiRequest("DELETE", `/api/white-label/domains/${id}`), onSuccess: refresh });
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Globe className="h-4 w-4" /> Custom domains</span>} description="Use a subdomain such as app.youragency.com." />
      <div className="flex flex-col gap-4 p-5">
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (domain.trim()) add.mutate(); }}>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.youragency.com" aria-label="Domain" className="max-w-sm" />
          <Button type="submit" loading={add.isPending} disabled={!domain.trim()}>Add domain</Button>
        </form>
        {domains.map((d) => (
          <div key={d.id} className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{d.domain}</span>
              {d.disabled ? <Badge tone="danger">Turned off by the platform</Badge> : d.verified ? <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> Verified</Badge> : <Badge tone="warning"><Clock className="h-3 w-3" /> Waiting for DNS</Badge>}
              <div className="ml-auto flex gap-1">
                {!d.verified && <Button size="sm" onClick={() => verify.mutate(d.id)} loading={verify.isPending && verify.variables === d.id}>Verify</Button>}
                {d.verified && <a href={`https://${d.domain}/login`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm hover:bg-subtle">Open</a>}
                <Button size="icon" variant="ghost" aria-label={`Remove ${d.domain}`} onClick={async () => { if (await confirm({ title: `Remove ${d.domain}?`, description: "Your clients won't be able to sign in there any more (they can still use the platform's address).", confirmText: "Remove", destructive: true })) remove.mutate(d.id); }}>
                  <Trash2 className="h-4 w-4 text-danger" />
                </Button>
              </div>
            </div>
            {!d.verified && (
              <>
                <p className="mt-3 text-sm text-fg-muted">Add these two records at your DNS provider, then click Verify.</p>
                <div className="mt-2 overflow-x-auto">
                  <Table>
                    <thead><tr><Th>Type</Th><Th>Name</Th><Th>Value</Th></tr></thead>
                    <tbody>
                      {d.records.map((r) => (
                        <Tr key={r.type}>
                          <Td className="font-mono text-xs">{r.type}</Td>
                          <Td className="font-mono text-xs"><span className="flex items-center gap-1 break-all">{r.name}<CopyText text={r.name} label="name" /></span></Td>
                          <Td className="font-mono text-xs"><span className="flex items-center gap-1 break-all">{r.value}<CopyText text={r.value} label="value" /></span></Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
                {d.lastError && <p className="mt-2 text-xs text-warning">{d.lastError}{d.lastCheckedAt ? ` (checked ${formatDate(d.lastCheckedAt)})` : ""}</p>}
              </>
            )}
            {d.verified && <p className="mt-2 text-xs text-fg-muted">Points to {platformHost}. HTTPS is issued automatically by the platform once the CNAME is live.</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Clients({ count }: { count: number }) {
  const { data } = useQuery<{ data: { id: string; username: string; email: string; firstName: string | null; lastName: string | null; status: string; createdAt: string; lastLogin: string | null }[] }>({ queryKey: ["/api/white-label/clients"] });
  const rows = data?.data ?? [];
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Users className="h-4 w-4" /> Clients ({count})</span>} description="Businesses that signed up on your domains." />
      {rows.length === 0 ? (
        <p className="p-5 text-sm text-fg-muted">No clients yet. Share your domain's sign-up page: https://your-domain/signup</p>
      ) : (
        <Table>
          <thead><tr><Th>Client</Th><Th>Email</Th><Th>Status</Th><Th>Joined</Th><Th>Last sign-in</Th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <Tr key={c.id}>
                <Td className="font-medium">{[c.firstName, c.lastName].filter(Boolean).join(" ") || c.username}</Td>
                <Td className="break-all">{c.email}</Td>
                <Td><StatusBadge status={c.status} /></Td>
                <Td className="whitespace-nowrap">{formatDate(c.createdAt)}</Td>
                <Td className="whitespace-nowrap">{c.lastLogin ? formatDate(c.lastLogin) : "—"}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
