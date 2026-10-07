import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy, ExternalLink, Send } from "lucide-react";
import { apiRequest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Badge } from "@/components/ui/display";
import { useToast } from "@/components/ui/overlay";
import { SmtpSettings } from "@/components/smtp-settings";
import { refreshConfig, SectionCard, SectionShell, useSaveSection, WithConfig, type SystemConfigResponse } from "./common";

const SaveBar = ({ onSave, pending, disabled }: { onSave: () => void; pending: boolean; disabled?: boolean }) => (
  <div className="mt-5 flex justify-end border-t border-border pt-4">
    <Button onClick={onSave} loading={pending} disabled={disabled}>Save changes</Button>
  </div>
);

const counter = (v: string, max: number) => <span className={v.length > max ? "text-danger" : ""}>{v.length}/{max}</span>;

// --- General -----------------------------------------------------------------------

function GeneralForm({ c }: { c: SystemConfigResponse }) {
  const d = c.data;
  const [v, setV] = useState({
    siteTitle: d.siteTitle ?? "",
    timezone: d.timezone ?? "UTC",
    currency: d.currency ?? "USD",
    currencySymbol: d.currencySymbol ?? "$",
    siteBaseColor: d.siteBaseColor ?? "#16a34a",
    recordsPerPage: d.recordsPerPage ?? 20,
    currencyDisplayMode: (d.currencyDisplayMode as "symbol" | "code" | "both") ?? "both",
  });
  const save = useSaveSection("general");
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    } catch {
      return ["UTC"];
    }
  }, []);
  return (
    <SectionCard>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Site title" htmlFor="g-title"><Input id="g-title" value={v.siteTitle} onChange={(e) => setV({ ...v, siteTitle: e.target.value })} /></Field>
        <Field label="Timezone" htmlFor="g-tz">
          <Select id="g-tz" value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })}>
            {(zones.includes(v.timezone) ? zones : [v.timezone, ...zones]).map((z) => <option key={z} value={z}>{z}</option>)}
          </Select>
        </Field>
        <Field label="Currency" htmlFor="g-cur" hint="ISO code, e.g. USD, INR, EUR"><Input id="g-cur" maxLength={3} value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase() })} /></Field>
        <Field label="Currency symbol" htmlFor="g-sym"><Input id="g-sym" maxLength={5} value={v.currencySymbol} onChange={(e) => setV({ ...v, currencySymbol: e.target.value })} /></Field>
        <Field label="Show prices as" htmlFor="g-mode">
          <Select id="g-mode" value={v.currencyDisplayMode} onChange={(e) => setV({ ...v, currencyDisplayMode: e.target.value as typeof v.currencyDisplayMode })}>
            <option value="symbol">Symbol ($49)</option>
            <option value="code">Code (49 USD)</option>
            <option value="both">Both ($49 USD)</option>
          </Select>
        </Field>
        <Field label="Records per page" htmlFor="g-rpp"><Input id="g-rpp" type="number" min={5} max={200} value={v.recordsPerPage} onChange={(e) => setV({ ...v, recordsPerPage: Number(e.target.value) })} /></Field>
        <Field label="Brand colour" htmlFor="g-color" hint="Buttons, links and highlights across the app.">
          <div className="flex items-center gap-2">
            <input id="g-color" type="color" value={v.siteBaseColor} onChange={(e) => setV({ ...v, siteBaseColor: e.target.value })} className="h-9 w-12 cursor-pointer rounded border border-border bg-surface" />
            <Input value={v.siteBaseColor} onChange={(e) => setV({ ...v, siteBaseColor: e.target.value })} className="w-32 font-mono" aria-label="Hex colour" />
            <span className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: v.siteBaseColor, color: "#fff" }}>Preview</span>
          </div>
        </Field>
      </div>
      <SaveBar onSave={() => save.mutate(v)} pending={save.isPending} />
    </SectionCard>
  );
}

// --- Logo & favicon ------------------------------------------------------------------

function BrandingForm({ c }: { c: SystemConfigResponse }) {
  const toast = useToast();
  const p = c.panel;
  const [v, setV] = useState({ name: p.name, tagline: p.tagline ?? "", companyName: p.companyName ?? "", companyWebsite: p.companyWebsite ?? "", supportEmail: p.supportEmail ?? "" });
  const [files, setFiles] = useState<{ logo?: File; favicon?: File }>({});
  const [remove, setRemove] = useState<{ logo?: boolean; favicon?: boolean }>({});
  const save = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      Object.entries(v).forEach(([k, val]) => fd.append(k, val));
      if (files.logo) fd.append("logo", files.logo);
      if (files.favicon) fd.append("favicon", files.favicon);
      if (remove.logo) fd.append("remove_logo", "true");
      if (remove.favicon) fd.append("remove_favicon", "true");
      return apiRequest("PUT", "/api/brand-settings", fd);
    },
    onSuccess: () => {
      toast({ title: "Branding saved", variant: "success" });
      setFiles({});
      setRemove({});
      refreshConfig();
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
  const preview = (k: "logo" | "favicon") => (files[k] ? URL.createObjectURL(files[k]!) : remove[k] ? null : p[k]);
  const imageField = ({ k, label, hint }: { k: "logo" | "favicon"; label: string; hint: string }) => (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-border bg-subtle">
          {preview(k) ? <img src={preview(k)!} alt="" className="max-h-16 max-w-16 object-contain" /> : <span className="text-xs text-fg-muted">None</span>}
        </div>
        <div className="flex flex-col gap-2">
          <Input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,.ico" className="pt-1.5" onChange={(e) => setFiles((f) => ({ ...f, [k]: e.target.files?.[0] }))} aria-label={label} />
          {p[k] && !files[k] && <Checkbox label="Remove current image" checked={Boolean(remove[k])} onChange={(on) => setRemove((r) => ({ ...r, [k]: on }))} />}
        </div>
      </div>
    </Field>
  );
  return (
    <SectionCard>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Field label="Platform name" htmlFor="b-name"><Input id="b-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
          <Field label="Tagline" htmlFor="b-tag"><Input id="b-tag" value={v.tagline} onChange={(e) => setV({ ...v, tagline: e.target.value })} /></Field>
          <Field label="Company name" htmlFor="b-co"><Input id="b-co" value={v.companyName} onChange={(e) => setV({ ...v, companyName: e.target.value })} /></Field>
          <Field label="Company website" htmlFor="b-web"><Input id="b-web" type="url" placeholder="https://" value={v.companyWebsite} onChange={(e) => setV({ ...v, companyWebsite: e.target.value })} /></Field>
          <Field label="Support email" htmlFor="b-mail"><Input id="b-mail" type="email" value={v.supportEmail} onChange={(e) => setV({ ...v, supportEmail: e.target.value })} /></Field>
        </div>
        <div className="flex flex-col gap-6">
          {imageField({ k: "logo", label: "Logo", hint: "PNG, JPG, WebP or GIF up to 2 MB. Square images look best." })}
          {imageField({ k: "favicon", label: "Favicon", hint: "ICO or PNG, 32×32 or 64×64." })}
        </div>
      </div>
      <SaveBar onSave={() => save.mutate()} pending={save.isPending} disabled={!v.name.trim()} />
    </SectionCard>
  );
}

// --- System configuration (switches) ---------------------------------------------------

const SWITCHES = [
  { key: "userRegistration", label: "User registration", description: "Allow new businesses to sign up. When off, only you can create accounts." },
  { key: "emailVerification", label: "Email verification", description: "New accounts must confirm their email with a 6-digit code before signing in. Requires working SMTP." },
  { key: "forceSecurePassword", label: "Force secure password", description: "Require 8+ characters with upper- and lowercase letters and a number at sign-up." },
  { key: "agreePolicy", label: "Agree to policies", description: "Sign-up requires accepting your Terms (needs at least one published policy page)." },
  { key: "emailNotification", label: "Email notifications", description: "Allow notifications from Send notification to go out by email." },
  { key: "languageOption", label: "Language option", description: "Show a language switcher when more than one language is enabled." },
  { key: "forceSsl", label: "Force SSL", description: "Redirect plain-HTTP requests to HTTPS in production. Only enable once HTTPS works on your domain." },
] as const;

function ConfigurationForm({ c }: { c: SystemConfigResponse }) {
  const save = useSaveSection("configuration", "Configuration updated");
  return (
    <SectionCard className="divide-y divide-border">
      {SWITCHES.map((s) => (
        <div key={s.key} className="p-5">
          <Switch label={s.label} description={s.description} checked={Boolean(c.data[s.key])} disabled={save.isPending} onChange={(on) => save.mutate({ [s.key]: on })} />
        </div>
      ))}
    </SectionCard>
  );
}

// --- Notification (SMTP + global template) ----------------------------------------------

const DEFAULT_TEMPLATE = `<!doctype html>
<html><body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#111827">
<div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:8px;padding:28px;font-size:15px;line-height:1.6">
<p style="margin:0 0 16px;font-weight:bold;font-size:18px">{{site_name}}</p>
{{message}}
</div></body></html>`;

function NotificationForm({ c }: { c: SystemConfigResponse }) {
  const toast = useToast();
  const [tpl, setTpl] = useState(c.data.globalEmailTemplate || DEFAULT_TEMPLATE);
  const [to, setTo] = useState("");
  const save = useSaveSection("notification");
  const test = useMutation({
    mutationFn: () => apiRequest<{ simulated: boolean }>("POST", "/api/system-config/test-email", { email: to }),
    onSuccess: (r) => toast({ title: r.simulated ? "Test captured by the email simulator" : `Test sent to ${to}`, variant: "success" }),
    onError: (err) => toast({ title: "Test failed", description: (err as Error).message, variant: "error" }),
  });
  const preview = tpl.replace(/\{\{\s*site_name\s*\}\}/g, c.data.siteTitle ?? "").replace(/\{\{\s*message\s*\}\}/g, "<p>This is where the message goes.</p>");
  return (
    <div className="flex flex-col gap-6">
      <SmtpSettings platform canEdit />
      <SectionCard>
        <h2 className="text-sm font-semibold">Global email template</h2>
        <p className="mt-1 mb-4 text-xs text-fg-muted">Wraps every system email (verification codes, notifications). Use <code>{"{{message}}"}</code> for the body and <code>{"{{site_name}}"}</code> for the platform name.</p>
        <div className="grid gap-4 lg:grid-cols-2">
          <Textarea rows={14} className="font-mono text-xs" spellCheck={false} value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Template HTML" />
          <iframe title="Template preview" sandbox="" srcDoc={preview} className="min-h-72 w-full rounded-md border border-border bg-white" />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Input type="email" className="max-w-xs" placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Send a test to" />
          <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending} disabled={!to}><Send className="h-4 w-4" /> Send test</Button>
          <Button variant="ghost" onClick={() => setTpl(DEFAULT_TEMPLATE)}>Reset to default</Button>
        </div>
        <SaveBar onSave={() => save.mutate({ globalEmailTemplate: tpl })} pending={save.isPending} disabled={!tpl.includes("{{message}}")} />
      </SectionCard>
    </div>
  );
}

// --- SEO -------------------------------------------------------------------------------

function SeoForm({ c }: { c: SystemConfigResponse }) {
  const s = c.data.seoSettings ?? {};
  const [v, setV] = useState({ metaTitle: s.metaTitle ?? "", metaDescription: s.metaDescription ?? "", keywords: (s.metaKeywords ?? []).join(", "), ogImage: s.ogImage ?? "" });
  const save = useSaveSection("seo");
  return (
    <SectionCard>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Field label={<span className="flex justify-between">Meta title {counter(v.metaTitle, 70)}</span>} htmlFor="s-title"><Input id="s-title" value={v.metaTitle} onChange={(e) => setV({ ...v, metaTitle: e.target.value })} /></Field>
          <Field label={<span className="flex justify-between">Meta description {counter(v.metaDescription, 170)}</span>} htmlFor="s-desc"><Textarea id="s-desc" rows={3} value={v.metaDescription} onChange={(e) => setV({ ...v, metaDescription: e.target.value })} /></Field>
          <Field label="Keywords" htmlFor="s-kw" hint="Comma separated"><Input id="s-kw" value={v.keywords} onChange={(e) => setV({ ...v, keywords: e.target.value })} /></Field>
          <Field label="Social sharing image URL" htmlFor="s-og" hint="1200×630 works best for link previews."><Input id="s-og" type="url" value={v.ogImage} onChange={(e) => setV({ ...v, ogImage: e.target.value })} /></Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Search result preview</p>
          <div className="rounded-lg border border-border p-4">
            <p className="truncate text-lg text-info">{v.metaTitle || c.data.siteTitle}</p>
            <p className="text-xs text-success">{location.origin}</p>
            <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{v.metaDescription || "Add a description to control the snippet search engines show."}</p>
          </div>
        </div>
      </div>
      <SaveBar
        pending={save.isPending}
        onSave={() => save.mutate({ metaTitle: v.metaTitle || undefined, metaDescription: v.metaDescription || undefined, metaKeywords: v.keywords.split(",").map((k) => k.trim()).filter(Boolean), ogImage: v.ogImage })}
      />
    </SectionCard>
  );
}

// --- Frontend -----------------------------------------------------------------------------

function FrontendForm({ c }: { c: SystemConfigResponse }) {
  const f = c.data.frontendSettings ?? {};
  const [v, setV] = useState({ heroTitle: f.heroTitle ?? "", heroSubtitle: f.heroSubtitle ?? "", features: (f.features ?? []).join("\n"), footerText: f.footerText ?? "" });
  const save = useSaveSection("frontend");
  const features = v.features.split("\n").map((x) => x.trim()).filter(Boolean);
  return (
    <SectionCard>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Field label="Headline" htmlFor="f-h"><Input id="f-h" value={v.heroTitle} maxLength={120} onChange={(e) => setV({ ...v, heroTitle: e.target.value })} /></Field>
          <Field label="Sub-headline" htmlFor="f-s"><Textarea id="f-s" rows={2} value={v.heroSubtitle} maxLength={300} onChange={(e) => setV({ ...v, heroSubtitle: e.target.value })} /></Field>
          <Field label="Highlights" htmlFor="f-f" hint="One per line, up to 8."><Textarea id="f-f" rows={5} value={v.features} onChange={(e) => setV({ ...v, features: e.target.value })} /></Field>
          <Field label="Footer text" htmlFor="f-ft"><Input id="f-ft" value={v.footerText} maxLength={200} onChange={(e) => setV({ ...v, footerText: e.target.value })} /></Field>
        </div>
        <div className="rounded-lg bg-primary p-6 text-primary-fg">
          <p className="text-xs opacity-70">Sign-in page preview</p>
          <p className="mt-6 text-2xl font-semibold">{v.heroTitle || "Turn WhatsApp into your best sales channel"}</p>
          <p className="mt-2 text-sm opacity-85">{v.heroSubtitle || "Shared inbox, campaigns and automation for your whole team."}</p>
          <ul className="mt-4 space-y-1 text-sm">{features.slice(0, 8).map((x) => <li key={x}>✓ {x}</li>)}</ul>
          <p className="mt-6 text-xs opacity-70">{v.footerText}</p>
        </div>
      </div>
      <SaveBar pending={save.isPending} disabled={features.length > 8} onSave={() => save.mutate({ heroTitle: v.heroTitle, heroSubtitle: v.heroSubtitle, features, footerText: v.footerText })} />
    </SectionCard>
  );
}

// --- Social login -----------------------------------------------------------------------------

function SocialLoginForm({ c }: { c: SystemConfigResponse }) {
  const toast = useToast();
  const g = c.data.extensionSettings.googleLogin;
  const [v, setV] = useState({ enabled: g.enabled, clientId: g.clientId, clientSecret: "" });
  const save = useSaveSection("social-login");
  return (
    <SectionCard>
      <div className="flex max-w-2xl flex-col gap-5">
        <Switch label="Sign in with Google" description="Shows “Continue with Google” on the sign-in and sign-up pages. Only verified Google emails are accepted." checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} />
        <Field label="Client ID" htmlFor="gl-id"><Input id="gl-id" value={v.clientId} onChange={(e) => setV({ ...v, clientId: e.target.value })} placeholder="1234…apps.googleusercontent.com" /></Field>
        <Field label="Client secret" htmlFor="gl-secret" hint={g.hasClientSecret ? "A secret is saved. Leave blank to keep it." : "Stored encrypted when ENCRYPTION_KEY is set."}>
          <Input id="gl-secret" type="password" autoComplete="new-password" value={v.clientSecret} onChange={(e) => setV({ ...v, clientSecret: e.target.value })} />
        </Field>
        <div className="rounded-md bg-subtle p-3 text-sm">
          <p className="font-medium">Authorized redirect URI</p>
          <p className="mt-1 text-fg-muted">Add this in Google Cloud Console → Credentials → your OAuth client.</p>
          <p className="mt-2 flex items-center gap-2">
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs break-all">{c.googleRedirectUri}</code>
            <Button size="icon" variant="ghost" aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(c.googleRedirectUri); toast({ title: "Copied", variant: "success" }); }}><Copy className="h-4 w-4" /></Button>
          </p>
        </div>
      </div>
      <SaveBar pending={save.isPending} onSave={() => save.mutate({ googleLogin: { enabled: v.enabled, clientId: v.clientId.trim(), clientSecret: v.clientSecret || undefined } })} />
    </SectionCard>
  );
}

// --- Maintenance ------------------------------------------------------------------------------

function MaintenanceForm({ c }: { c: SystemConfigResponse }) {
  const m = c.data.maintenanceMode ?? { enabled: false, title: "", content: "", bypassSecret: "" };
  const [v, setV] = useState({ ...m });
  const save = useSaveSection("maintenance", "Maintenance settings saved");
  const link = v.bypassSecret ? `${location.origin}/api/maintenance/bypass?secret=${encodeURIComponent(v.bypassSecret)}` : null;
  return (
    <SectionCard>
      <div className="flex max-w-2xl flex-col gap-5">
        {m.enabled && <Badge tone="warning">Maintenance mode is ON — tenants see the message below</Badge>}
        <Switch label="Maintenance mode" description="Tenants and their teams get the maintenance page. You (superadmins) keep full access; webhooks and queued sends keep running." checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} />
        <Field label="Title" htmlFor="m-title"><Input id="m-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="Message" htmlFor="m-content"><Textarea id="m-content" rows={4} value={v.content} onChange={(e) => setV({ ...v, content: e.target.value })} /></Field>
        <Field label="Bypass secret (optional)" htmlFor="m-secret" hint="Testers who open the bypass link can use the app during maintenance (for that browser session).">
          <Input id="m-secret" value={v.bypassSecret} onChange={(e) => setV({ ...v, bypassSecret: e.target.value })} />
        </Field>
        {link && <p className="text-xs text-fg-muted">Bypass link: <code className="break-all">{link}</code></p>}
      </div>
      <SaveBar pending={save.isPending} disabled={!v.title.trim() || !v.content.trim()} onSave={() => save.mutate(v)} />
    </SectionCard>
  );
}

// --- GDPR cookie ------------------------------------------------------------------------------

function GdprForm({ c }: { c: SystemConfigResponse }) {
  const g = c.data.gdprCookie!;
  const [v, setV] = useState({ ...g });
  const save = useSaveSection("gdpr-cookie");
  return (
    <SectionCard>
      <div className="flex flex-col gap-5">
        <Switch label="Show cookie banner" description="Visitors see the banner until they accept or decline; the choice is remembered for the lifespan below." checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} />
        <Field label="Banner text" htmlFor="gd-text"><Textarea id="gd-text" rows={3} value={v.bannerText} onChange={(e) => setV({ ...v, bannerText: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Accept button" htmlFor="gd-a"><Input id="gd-a" value={v.acceptButtonText} onChange={(e) => setV({ ...v, acceptButtonText: e.target.value })} /></Field>
          <Field label="Decline button" htmlFor="gd-d"><Input id="gd-d" value={v.declineButtonText} onChange={(e) => setV({ ...v, declineButtonText: e.target.value })} /></Field>
          <Field label="Policy link" htmlFor="gd-l"><Input id="gd-l" value={v.policyUrl} onChange={(e) => setV({ ...v, policyUrl: e.target.value })} placeholder="/policy/cookie-policy" /></Field>
          <Field label="Remember choice (days)" htmlFor="gd-days"><Input id="gd-days" type="number" min={1} max={730} value={v.cookieLifespanDays} onChange={(e) => setV({ ...v, cookieLifespanDays: Number(e.target.value) })} /></Field>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="mb-2 text-xs text-fg-muted">Preview</p>
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-60 flex-1 text-sm">{v.bannerText} <span className="text-primary underline">Cookie policy</span></p>
            <Button variant="outline" size="sm">{v.declineButtonText}</Button>
            <Button size="sm">{v.acceptButtonText}</Button>
          </div>
        </div>
      </div>
      <SaveBar pending={save.isPending} onSave={() => save.mutate(v)} />
    </SectionCard>
  );
}

// --- Custom CSS / sitemap / robots ------------------------------------------------------------

function CodeForm({ c, section, field, label, hint, publicPath, defaultValue }: { c: SystemConfigResponse; section: string; field: "customCss" | "sitemapXml" | "robotsTxt"; label: string; hint: string; publicPath?: string; defaultValue?: string }) {
  const [v, setV] = useState(c.data[field] ?? "");
  const save = useSaveSection(section);
  return (
    <SectionCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{hint}</p>
        <div className="flex gap-2">
          {defaultValue !== undefined && <Button size="sm" variant="ghost" onClick={() => setV(defaultValue)}>Insert default</Button>}
          {publicPath && <a href={publicPath} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">View live <ExternalLink className="h-3.5 w-3.5" /></a>}
        </div>
      </div>
      <Textarea rows={18} className="font-mono text-xs" spellCheck={false} value={v} onChange={(e) => setV(e.target.value)} aria-label={label} />
      <SaveBar pending={save.isPending} onSave={() => save.mutate({ [field]: v })} />
    </SectionCard>
  );
}

export const SECTIONS: Record<string, { title: string; description: string; render: (c: SystemConfigResponse) => JSX.Element; wide?: boolean }> = {
  general: { title: "General setting", description: "Basic information about your platform.", render: (c) => <GeneralForm c={c} /> },
  "logo-favicon": { title: "Logo and favicon", description: "Shown in the sidebar, sign-in pages, browser tab and emails.", render: (c) => <BrandingForm c={c} /> },
  configuration: { title: "System configuration", description: "Changes apply immediately.", render: (c) => <ConfigurationForm c={c} /> },
  notification: { title: "Notification setting", description: "How platform emails are sent and how they look.", render: (c) => <NotificationForm c={c} />, wide: true },
  seo: { title: "SEO configuration", description: "Injected into every page served by the app.", render: (c) => <SeoForm c={c} /> },
  frontend: { title: "Manage frontend", description: "Content of the public sign-in and sign-up pages.", render: (c) => <FrontendForm c={c} /> },
  "social-login": { title: "Social login setting", description: "Google OAuth 2.0 sign-in.", render: (c) => <SocialLoginForm c={c} /> },
  maintenance: { title: "Maintenance mode", description: "Temporarily take the app offline for tenants.", render: (c) => <MaintenanceForm c={c} /> },
  "gdpr-cookie": { title: "GDPR cookie", description: "Cookie consent for visitors.", render: (c) => <GdprForm c={c} /> },
  "custom-css": { title: "Custom CSS", description: "Loaded on every page after the app's own styles.", render: (c) => <CodeForm c={c} section="custom-css" field="customCss" label="Custom CSS" hint="Plain CSS. Test carefully: it applies to every user." /> },
  sitemap: { title: "Sitemap XML", description: "Served at /sitemap.xml.", render: (c) => <CodeForm c={c} section="sitemap" field="sitemapXml" label="Sitemap XML" hint="Leave empty to serve an automatic sitemap of your public pages." publicPath="/sitemap.xml" defaultValue={c.defaults.sitemapXml} /> },
  robots: { title: "Robots txt", description: "Served at /robots.txt.", render: (c) => <CodeForm c={c} section="robots" field="robotsTxt" label="robots.txt" hint="Leave empty to serve a sensible default that hides /admin and /api." publicPath="/robots.txt" defaultValue={c.defaults.robotsTxt} /> },
};

/** Route component for /system-settings/:section (simple sections). */
export function SimpleSection({ slug }: { slug: string }) {
  const s = SECTIONS[slug];
  return (
    <SectionShell title={s.title} description={s.description} wide={s.wide}>
      <WithConfig>{(c) => s.render(c)}</WithConfig>
    </SectionShell>
  );
}
