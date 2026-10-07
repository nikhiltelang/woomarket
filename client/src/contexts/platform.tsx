import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { translate, type PublicConfig } from "@shared/platform";
import { apiRequest } from "@/lib/api";

interface PlatformValue {
  config: PublicConfig | null;
  t: (key: string, vars?: Record<string, string>) => string;
  language: string;
  setLanguage: (code: string) => void;
}

const PlatformCtx = createContext<PlatformValue>({ config: null, t: (k, v) => translate({}, k, v), language: "en", setLanguage: () => {} });
export const PUBLIC_CONFIG_KEY = ["/api/system-config/public"];
const LANG_KEY = "wm360.lang";

const readLang = () => {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
};

/** Relative luminance → dark or light text on the brand colour. */
function contrastText(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0f14" : "#ffffff";
}

/** Applies the platform's branding to the document (theme colour, favicon, custom CSS). */
function applyBranding(cfg: PublicConfig) {
  const root = document.documentElement;
  if (/^#[0-9a-f]{6}$/i.test(cfg.baseColor) && cfg.baseColor.toLowerCase() !== "#16a34a") {
    root.style.setProperty("--primary", cfg.baseColor);
    root.style.setProperty("--primary-hover", `color-mix(in srgb, ${cfg.baseColor} 82%, black)`);
    root.style.setProperty("--primary-fg", contrastText(cfg.baseColor));
    root.style.setProperty("--primary-soft", `color-mix(in srgb, ${cfg.baseColor} 16%, var(--surface))`);
  } else {
    for (const v of ["--primary", "--primary-hover", "--primary-fg", "--primary-soft"]) root.style.removeProperty(v);
  }
  if (cfg.favicon) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = cfg.favicon;
  }
  let style = document.getElementById("custom-css");
  if (!style) {
    style = document.createElement("style");
    style.id = "custom-css";
    document.head.appendChild(style);
  }
  style.textContent = cfg.customCss ?? "";
}

export function PlatformProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery<{ data: PublicConfig }>({ queryKey: PUBLIC_CONFIG_KEY, staleTime: 60_000, retry: 1 });
  const config = data?.data ?? null;
  const [chosen, setChosen] = useState<string | null>(readLang);

  const language = useMemo(() => {
    const langs = config?.languages ?? [];
    if (chosen && langs.some((l) => l.code === chosen)) return chosen;
    return langs.find((l) => l.isDefault)?.code ?? "en";
  }, [config, chosen]);

  const translations = useQuery<{ direction: string; translations: Record<string, string> }>({
    queryKey: [`/api/languages/translations/${language}`],
    queryFn: () => apiRequest("GET", `/api/languages/translations/${language}`),
    enabled: Boolean(config) && (config?.languages.length ?? 0) > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const dict = translations.data?.translations ?? {};

  useEffect(() => {
    if (config) applyBranding(config);
  }, [config]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = translations.data?.direction === "rtl" ? "rtl" : "ltr";
  }, [language, translations.data?.direction]);

  const setLanguage = useCallback((code: string) => {
    setChosen(code);
    try {
      localStorage.setItem(LANG_KEY, code);
    } catch {}
  }, []);

  const t = useCallback((key: string, vars?: Record<string, string>) => translate(dict, key, vars), [dict]);

  return <PlatformCtx.Provider value={{ config, t, language, setLanguage }}>{children}</PlatformCtx.Provider>;
}

export const usePlatform = () => useContext(PlatformCtx);
