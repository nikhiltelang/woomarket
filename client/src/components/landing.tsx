import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  BarChart3,
  Check,
  ChevronDown,
  Clock,
  Globe,
  Inbox,
  LayoutTemplate,
  Mail,
  Megaphone,
  Menu,
  MessageCircle,
  MessageSquareText,
  Quote,
  Repeat,
  Shield,
  Sparkles,
  Target,
  Users,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { LandingIcon, LandingPage, LandingSection } from "@shared/landing";
import { usePlatform } from "@/contexts/platform";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { ChannelIcon, channelMeta, type MarketingChannel } from "@/lib/channels";
import { PolicyLinks } from "@/components/public";

export interface LandingPlan {
  id: string;
  name: string;
  description: string | null;
  monthlyPrice: number;
  annualPrice: number;
  features: string[];
  popular: boolean;
  badge: string | null;
}

export const ICONS: Record<LandingIcon, LucideIcon> = {
  "message-circle": MessageCircle,
  mail: Mail,
  "message-square-text": MessageSquareText,
  megaphone: Megaphone,
  users: Users,
  "bar-chart": BarChart3,
  zap: Zap,
  shield: Shield,
  clock: Clock,
  globe: Globe,
  inbox: Inbox,
  sparkles: Sparkles,
  target: Target,
  repeat: Repeat,
  "layout-template": LayoutTemplate,
  workflow: Workflow,
};

/** Site paths use the router; anchors scroll; everything else is a normal link. */
function SmartLink({ href, className, children, onClick }: { href: string; className?: string; children: ReactNode; onClick?: () => void }) {
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link href={href} className={className} onClick={onClick}>
        {children}
      </Link>
    );
  }
  const external = /^https?:\/\//i.test(href);
  return (
    <a href={href} className={className} onClick={onClick} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  );
}

const btn = {
  primary: "inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-fg shadow-sm transition-colors hover:bg-primary-hover",
  outline: "inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-5 text-sm font-semibold transition-colors hover:bg-subtle",
};

function SectionHeading({ title, subtitle }: { title?: string; subtitle?: string }) {
  if (!title && !subtitle) return null;
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center">
      {title && <h2 className="text-3xl font-semibold tracking-tight text-balance @2xl:text-4xl">{title}</h2>}
      {subtitle && <p className="mt-3 text-base text-fg-muted text-pretty @2xl:text-lg">{subtitle}</p>}
    </div>
  );
}

const Wrap = ({ id, className, children }: { id?: string; className?: string; children: ReactNode }) => (
  <section id={id || undefined} className={cn("scroll-mt-20 px-4 py-16 @2xl:py-20", className)}>
    <div className="mx-auto max-w-6xl">{children}</div>
  </section>
);

/** Decorative stand-in when the hero has no image: one sample message per channel. */
function HeroArt() {
  const samples: { channel: MarketingChannel; title: string; body: string }[] = [
    { channel: "whatsapp", title: "Order shipped 📦", body: "Hi Priya, your order #1042 is on its way. Track it anytime." },
    { channel: "email", title: "Autumn sale — 20% off", body: "Fresh arrivals for the season, just for our members." },
    { channel: "sms", title: "Your code: 4821", body: "Use it within 10 minutes to sign in." },
  ];
  return (
    <div className="relative mx-auto w-full max-w-md" aria-hidden>
      <div className="absolute -inset-6 rounded-[2rem] bg-primary/10 blur-2xl" />
      <div className="relative space-y-3">
        {samples.map((s, i) => (
          <div key={s.channel} className={cn("flex gap-3 rounded-xl border border-border bg-surface p-4 shadow-lg", i === 1 && "@2xl:ml-8", i === 2 && "@2xl:ml-4")}>
            <ChannelIcon channel={s.channel} />
            <div className="min-w-0">
              <p className="text-xs font-medium text-fg-muted">{channelMeta(s.channel).label}</p>
              <p className="text-sm font-semibold">{s.title}</p>
              <p className="text-sm text-fg-muted">{s.body}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PricingSection({ s, plans }: { s: Extract<LandingSection, { type: "pricing" }>; plans: LandingPlan[] }) {
  const { config } = usePlatform();
  const [annual, setAnnual] = useState(false);
  const symbol = config?.currencySymbol ?? "$";
  const hasAnnual = plans.some((p) => p.annualPrice > 0);
  return (
    <Wrap id={s.anchor}>
      <SectionHeading title={s.title} subtitle={s.subtitle} />
      {hasAnnual && (
        <div className="mb-8 flex justify-center">
          <div role="tablist" className="inline-flex rounded-full border border-border bg-subtle p-1 text-sm">
            {[false, true].map((a) => (
              <button key={String(a)} role="tab" aria-selected={annual === a} onClick={() => setAnnual(a)} className={cn("rounded-full px-4 py-1.5 font-medium", annual === a ? "bg-surface shadow-sm" : "text-fg-muted")}>
                {a ? "Yearly" : "Monthly"}
              </button>
            ))}
          </div>
        </div>
      )}
      {!plans.length ? (
        <p className="text-center text-fg-muted">Plans will appear here once they're set up.</p>
      ) : (
        <div className={cn("grid gap-6", plans.length >= 3 ? "@3xl:grid-cols-3" : plans.length === 2 ? "@3xl:grid-cols-2 @3xl:max-w-3xl @3xl:mx-auto" : "max-w-md mx-auto")}>
          {plans.map((p) => {
            const price = annual ? p.annualPrice : p.monthlyPrice;
            return (
              <div key={p.id} className={cn("relative flex flex-col rounded-2xl border bg-surface p-6", p.popular ? "border-primary shadow-lg ring-1 ring-primary" : "border-border")}>
                {(p.popular || p.badge) && <span className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-0.5 text-xs font-semibold text-primary-fg">{p.badge || "Most popular"}</span>}
                <h3 className="text-lg font-semibold">{p.name}</h3>
                {p.description && <p className="mt-1 text-sm text-fg-muted">{p.description}</p>}
                <p className="mt-5">
                  <span className="text-4xl font-semibold tabular-nums">{price ? `${symbol}${price % 1 ? price.toFixed(2) : price}` : "Free"}</span>
                  {price > 0 && <span className="text-sm text-fg-muted"> / {annual ? "year" : "month"}</span>}
                </p>
                <ul className="mt-6 flex-1 space-y-2 text-sm">
                  {p.features.map((f) => (
                    <li key={f} className="flex gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {f}
                    </li>
                  ))}
                </ul>
                <Link href="/signup" className={cn("mt-6", p.popular ? btn.primary : btn.outline)}>
                  {s.cta || "Get started"}
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </Wrap>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <details className="group rounded-xl border border-border bg-surface px-5 py-4 open:shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
        {q}
        <ChevronDown className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
      </summary>
      <p className="mt-3 text-sm whitespace-pre-line text-fg-muted">{a}</p>
    </details>
  );
}

export function LandingSectionView({ s, plans }: { s: LandingSection; plans: LandingPlan[] }) {
  switch (s.type) {
    case "hero":
      return (
        <section id={s.anchor || undefined} className="relative overflow-hidden px-4 pt-14 pb-16 @2xl:pt-20 @2xl:pb-24">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-gradient-to-b from-primary-soft/70 to-transparent" aria-hidden />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 @5xl:grid-cols-2">
            <div className="text-center @5xl:text-left">
              {s.eyebrow && <p className="mb-4 inline-flex rounded-full border border-primary/30 bg-surface px-3 py-1 text-xs font-semibold tracking-wide text-primary">{s.eyebrow}</p>}
              <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance @2xl:text-5xl">{s.title}</h1>
              {s.subtitle && <p className="mt-5 text-lg text-fg-muted text-pretty">{s.subtitle}</p>}
              <div className="mt-8 flex flex-wrap justify-center gap-3 @5xl:justify-start">
                {s.primary.label && <SmartLink href={s.primary.href || "/signup"} className={btn.primary}>{s.primary.label}</SmartLink>}
                {s.secondary.label && s.secondary.href && <SmartLink href={s.secondary.href} className={btn.outline}>{s.secondary.label}</SmartLink>}
              </div>
            </div>
            {s.image ? <img src={s.image} alt="" className="mx-auto w-full max-w-xl rounded-2xl border border-border shadow-xl" /> : <HeroArt />}
          </div>
        </section>
      );
    case "stats":
      if (!s.items.length) return null;
      return (
        <section id={s.anchor || undefined} className="border-y border-border bg-surface px-4 py-10">
          <dl className={cn("mx-auto grid max-w-6xl gap-8 text-center", s.items.length >= 4 ? "grid-cols-2 @3xl:grid-cols-4" : (["grid-cols-1", "grid-cols-1", "grid-cols-2", "grid-cols-3"] as const)[s.items.length])}>
            {s.items.map((i, n) => (
              <div key={n}>
                <dt className="sr-only">{i.label}</dt>
                <dd className="text-3xl font-semibold tabular-nums">{i.value}</dd>
                <dd className="mt-1 text-sm text-fg-muted">{i.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case "channels": {
      const items: { channel: MarketingChannel; text: string }[] = [
        { channel: "whatsapp", text: s.whatsapp },
        { channel: "email", text: s.email },
        { channel: "sms", text: s.sms },
      ];
      return (
        <Wrap id={s.anchor}>
          <SectionHeading title={s.title} subtitle={s.subtitle} />
          <div className="grid gap-6 @3xl:grid-cols-3">
            {items.map((i) => (
              <div key={i.channel} className="rounded-2xl border border-border bg-surface p-6">
                <ChannelIcon channel={i.channel} size="lg" />
                <h3 className="mt-4 text-lg font-semibold">{channelMeta(i.channel).title}</h3>
                {i.text && <p className="mt-2 text-sm text-fg-muted">{i.text}</p>}
              </div>
            ))}
          </div>
        </Wrap>
      );
    }
    case "features":
      return (
        <Wrap id={s.anchor} className="bg-surface">
          <SectionHeading title={s.title} subtitle={s.subtitle} />
          <div className="grid gap-x-8 gap-y-10 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {s.items.map((f, n) => {
              const Icon = ICONS[f.icon] ?? Sparkles;
              return (
                <div key={n}>
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-semibold">{f.title}</h3>
                  {f.text && <p className="mt-1.5 text-sm text-fg-muted">{f.text}</p>}
                </div>
              );
            })}
          </div>
        </Wrap>
      );
    case "steps":
      return (
        <Wrap id={s.anchor}>
          <SectionHeading title={s.title} subtitle={s.subtitle} />
          <ol className={cn("grid gap-6", s.items.length >= 3 ? "@3xl:grid-cols-3" : "@3xl:grid-cols-2")}>
            {s.items.map((i, n) => (
              <li key={n} className="rounded-2xl border border-border bg-surface p-6">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-fg">{n + 1}</span>
                <h3 className="mt-4 font-semibold">{i.title}</h3>
                {i.text && <p className="mt-1.5 text-sm text-fg-muted">{i.text}</p>}
              </li>
            ))}
          </ol>
        </Wrap>
      );
    case "pricing":
      return <PricingSection s={s} plans={plans} />;
    case "testimonials":
      return (
        <Wrap id={s.anchor} className="bg-surface">
          <SectionHeading title={s.title} />
          <div className="flex flex-wrap justify-center gap-6">
            {s.items.filter((t) => t.quote).map((t, n) => (
              <figure key={n} className="w-full rounded-2xl border border-border bg-bg p-6 @3xl:w-[calc((100%-3rem)/3)]">
                <Quote className="h-5 w-5 text-primary" aria-hidden />
                <blockquote className="mt-3 text-sm leading-relaxed">{t.quote}</blockquote>
                <figcaption className="mt-4 text-sm">
                  <span className="font-semibold">{t.name}</span>
                  {t.role && <span className="text-fg-muted"> · {t.role}</span>}
                </figcaption>
              </figure>
            ))}
          </div>
        </Wrap>
      );
    case "faq":
      return (
        <Wrap id={s.anchor}>
          <SectionHeading title={s.title} />
          <div className="mx-auto max-w-3xl space-y-3">
            {s.items.filter((i) => i.q).map((i, n) => <FaqItem key={n} q={i.q} a={i.a} />)}
          </div>
        </Wrap>
      );
    case "cta":
      return (
        <section id={s.anchor || undefined} className="px-4 py-16">
          <div className="mx-auto max-w-5xl rounded-3xl bg-primary px-6 py-14 text-center text-primary-fg @2xl:px-12">
            <h2 className="text-3xl font-semibold tracking-tight text-balance">{s.title}</h2>
            {s.subtitle && <p className="mx-auto mt-3 max-w-xl opacity-90">{s.subtitle}</p>}
            {s.primary.label && (
              <SmartLink href={s.primary.href || "/signup"} className="mt-8 inline-flex h-11 items-center rounded-lg bg-white px-6 text-sm font-semibold text-gray-900 shadow-sm hover:bg-white/90">
                {s.primary.label}
              </SmartLink>
            )}
          </div>
        </section>
      );
    case "custom":
      return (
        <Wrap id={s.anchor}>
          <div className="mx-auto max-w-3xl">
            {s.title && <h2 className="mb-6 text-3xl font-semibold tracking-tight">{s.title}</h2>}
            <div className="prose-sm text-fg-muted">
              <Markdown source={s.body} />
            </div>
          </div>
        </Wrap>
      );
  }
}

/** The whole public page. `preview` keeps navigation inside the editor (no sticky header). */
export function LandingView({ page, plans, preview = false }: { page: LandingPage; plans: LandingPlan[]; preview?: boolean }) {
  const { config } = usePlatform();
  const [menu, setMenu] = useState(false);
  const site = config?.siteTitle ?? "WooMarket360";
  const sections = page.sections.filter((s) => s.enabled);
  const navLinks = page.nav.links.filter((l) => l.label && l.href);

  return (
    // A size container: layout follows the space the page gets (full window, or the editor's preview pane).
    <div className="@container min-h-full bg-bg text-fg">
      <header className={cn("z-30 border-b border-border bg-bg/85 backdrop-blur", !preview && "sticky top-0")}>
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <img src={config?.logo || "/favicon.svg"} alt="" className="h-8 w-8 rounded object-contain" />
            <span className="text-lg tracking-tight">{site}</span>
          </Link>
          <nav aria-label="Main" className="hidden flex-1 items-center gap-6 text-sm text-fg-muted @3xl:flex">
            {navLinks.map((l, n) => <SmartLink key={n} href={l.href} className="hover:text-fg">{l.label}</SmartLink>)}
          </nav>
          <div className="ml-auto hidden items-center gap-2 @3xl:flex">
            {page.nav.showLogin && <Link href="/login" className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-subtle">Sign in</Link>}
            {page.nav.showSignup && config?.userRegistration !== false && <Link href="/signup" className={cn(btn.primary, "h-9 px-4")}>{page.nav.signupLabel || "Get started"}</Link>}
          </div>
          <button className="ml-auto rounded-md p-2 @3xl:hidden" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label="Menu">
            {menu ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
        {menu && (
          <div className="border-t border-border px-4 py-3 @3xl:hidden">
            <nav className="flex flex-col gap-1 text-sm" aria-label="Mobile">
              {navLinks.map((l, n) => <SmartLink key={n} href={l.href} className="rounded-md px-2 py-2 hover:bg-subtle" onClick={() => setMenu(false)}>{l.label}</SmartLink>)}
              {page.nav.showLogin && <Link href="/login" className="rounded-md px-2 py-2 hover:bg-subtle">Sign in</Link>}
              {page.nav.showSignup && config?.userRegistration !== false && <Link href="/signup" className={cn(btn.primary, "mt-2")}>{page.nav.signupLabel || "Get started"}</Link>}
            </nav>
          </div>
        )}
      </header>

      <main>{sections.map((s) => <LandingSectionView key={s.id} s={s} plans={plans} />)}</main>

      <footer className="border-t border-border bg-surface px-4 py-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 @3xl:flex-row @3xl:items-center @3xl:justify-between">
          <div className="flex items-center gap-2">
            <img src={config?.logo || "/favicon.svg"} alt="" className="h-6 w-6 rounded object-contain" />
            <span className="text-sm text-fg-muted">{page.footer.text || `© ${new Date().getFullYear()} ${config?.companyName || site}`}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-fg-muted">
            {page.footer.links.filter((l) => l.label && l.href).map((l, n) => <SmartLink key={n} href={l.href} className="hover:text-fg">{l.label}</SmartLink>)}
            <PolicyLinks />
          </div>
        </div>
      </footer>
    </div>
  );
}
