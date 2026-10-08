import { useMemo, useState, type ComponentType } from "react";
import { Link } from "wouter";
import {
  Bell,
  Bot,
  Clock,
  Code2,
  Cookie,
  FileCode,
  Globe2,
  Image,
  Languages,
  LayoutTemplate,
  Network,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserCircle,
  Wrench,
  Sparkles,
  Layers,
} from "lucide-react";
import { PageContainer } from "@/components/layout/app-layout";
import { Card, EmptyState, PageHeader } from "@/components/ui/display";
import { Input } from "@/components/ui/form";

export interface SettingCard {
  slug: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export const SETTING_CARDS: SettingCard[] = [
  { slug: "general", title: "General setting", description: "Site name, timezone, currency, brand colour and list sizes.", icon: Settings2 },
  { slug: "logo-favicon", title: "Logo and favicon", description: "Upload your logo and favicon, and set company details.", icon: Image },
  { slug: "configuration", title: "System configuration", description: "Turn registration, email verification, secure passwords and other modules on or off.", icon: SlidersHorizontal },
  { slug: "notification", title: "Notification setting", description: "Platform SMTP server and the global email template for system emails.", icon: Bell },
  { slug: "seo", title: "SEO configuration", description: "Meta title, description, keywords and social sharing image.", icon: Globe2 },
  { slug: "frontend", title: "Manage frontend", description: "Headline, sub-headline and highlights on the sign-in and sign-up pages.", icon: LayoutTemplate },
  { slug: "queue", title: "Queue & scaling", description: "Optional Redis / BullMQ so several servers share sending and scheduled jobs.", icon: Layers },
  { slug: "ai-assistant", title: "AI assistant", description: "Claude-powered drafting, reply suggestions and conversation summaries for tenants.", icon: Sparkles },
  { slug: "social-login", title: "Social login setting", description: "Let people sign in with Google or Microsoft.", icon: UserCircle },
  { slug: "language", title: "Language", description: "Add languages and translate the interface.", icon: Languages },
  { slug: "cron", title: "Cron job setting", description: "See scheduled jobs, their last runs, and run them on demand.", icon: Clock },
  { slug: "policy-pages", title: "Policy pages", description: "Terms, privacy and other legal pages shown to visitors.", icon: ShieldCheck },
  { slug: "maintenance", title: "Maintenance mode", description: "Take the app offline for tenants while you work on it.", icon: Wrench },
  { slug: "gdpr-cookie", title: "GDPR cookie", description: "Cookie consent banner for visitors.", icon: Cookie },
  { slug: "custom-css", title: "Custom CSS", description: "Add your own CSS to fine-tune the look of the app.", icon: Code2 },
  { slug: "sitemap", title: "Sitemap XML", description: "Control the sitemap served at /sitemap.xml.", icon: Network },
  { slug: "robots", title: "Robots txt", description: "Tell search engine crawlers what to index (/robots.txt).", icon: Bot },
];

export default function SettingsHub() {
  const [q, setQ] = useState("");
  const cards = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? SETTING_CARDS.filter((c) => `${c.title} ${c.description}`.toLowerCase().includes(s)) : SETTING_CARDS;
  }, [q]);
  return (
    <PageContainer wide>
      <PageHeader title="System settings" />
      <Card className="mb-6 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-fg-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="h-10 pl-9" aria-label="Search settings" autoFocus />
        </div>
      </Card>
      {cards.length === 0 ? (
        <Card><EmptyState icon={<FileCode className="h-10 w-10" />} title="No matching settings" /></Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {cards.map(({ slug, title, description, icon: Icon }) => (
            <Link
              key={slug}
              href={`/system-settings/${slug}`}
              className="group relative flex items-center gap-5 overflow-hidden rounded-lg border border-border bg-surface p-5 transition-shadow hover:shadow-md focus-visible:shadow-md"
            >
              <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-fg">
                <Icon className="h-8 w-8" />
              </span>
              <span className="min-w-0">
                <span className="block text-lg font-semibold group-hover:text-primary">{title}</span>
                <span className="mt-1 block text-sm text-fg-muted">{description}</span>
              </span>
              <Icon className="pointer-events-none absolute -right-3 -bottom-3 h-16 w-16 text-primary opacity-[0.07]" aria-hidden />
            </Link>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
