import { useState } from "react";
import { Link } from "wouter";
import { Globe, Wrench } from "lucide-react";
import { usePlatform } from "@/contexts/platform";
import { Button } from "@/components/ui/button";

const CONSENT_KEY = "wm360.cookieConsent";

function readConsent(): { choice: string; until: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "null");
    return v && v.until > Date.now() ? v : null;
  } catch {
    return null;
  }
}

/** GDPR cookie banner, configured under System settings → GDPR Cookie. */
export function CookieBanner() {
  const { config, t } = usePlatform();
  const [consent, setConsent] = useState(readConsent);
  const g = config?.gdprCookie;
  if (!g?.enabled || consent) return null;
  const decide = (choice: "accepted" | "declined") => {
    const v = { choice, until: Date.now() + g.cookieLifespanDays * 86_400_000 };
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify(v));
    } catch {}
    setConsent(v);
  };
  return (
    <div role="dialog" aria-label="Cookie consent" className="fixed inset-x-0 bottom-0 z-[55] border-t border-border bg-surface p-4 shadow-[0_-4px_24px_rgba(0,0,0,0.08)]">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4">
        <p className="min-w-60 flex-1 text-sm text-fg">
          {g.bannerText}{" "}
          {g.policyUrl && (
            <a href={g.policyUrl} className="font-medium text-primary underline">
              {t("cookie.manage")}
            </a>
          )}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => decide("declined")}>
            {g.declineButtonText}
          </Button>
          <Button onClick={() => decide("accepted")}>{g.acceptButtonText}</Button>
        </div>
      </div>
    </div>
  );
}

export function MaintenanceScreen({ title, content, onSignOut }: { title: string; content: string; onSignOut?: () => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-warning-soft text-warning">
        <Wrench className="h-7 w-7" />
      </span>
      <h1 className="text-2xl font-semibold">{title || "Scheduled maintenance"}</h1>
      <p className="max-w-md text-fg-muted">{content}</p>
      {onSignOut ? (
        <Button variant="outline" onClick={onSignOut}>
          Sign out
        </Button>
      ) : (
        <Link href="/login" className="text-sm text-fg-muted underline">
          Administrator sign-in
        </Link>
      )}
    </div>
  );
}

export function LanguageSwitcher({ compact }: { compact?: boolean }) {
  const { config, language, setLanguage, t } = usePlatform();
  if (!config?.languageOption) return null;
  return (
    <label className="relative inline-flex items-center gap-1 text-sm text-fg-muted">
      <Globe className="h-4 w-4" aria-hidden />
      <span className="sr-only">{t("common.language")}</span>
      <select
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
        className={`appearance-none rounded-md border border-border bg-surface py-1 pr-2 pl-1 text-sm ${compact ? "max-w-24" : ""}`}
      >
        {config.languages.map((l) => (
          <option key={l.code} value={l.code}>
            {l.icon ? `${l.icon} ` : ""}
            {l.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Footer links to published policy pages. */
export function PolicyLinks() {
  const { config } = usePlatform();
  if (!config?.policies.length) return null;
  return (
    <nav aria-label="Policies" className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-fg-muted">
      {config.policies.map((p) => (
        <Link key={p.slug} href={`/policy/${p.slug}`} className="hover:text-fg hover:underline">
          {p.title}
        </Link>
      ))}
    </nav>
  );
}
