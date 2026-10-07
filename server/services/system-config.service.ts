import type { PanelConfig, SystemConfig } from "@shared/schema";
import type { PublicConfig } from "@shared/platform";
import { languagesRepository, panelRepository, policyRepository, systemConfigRepository } from "../repositories/platform.repository";
import { publicBaseUrl } from "../lib/tokens";

// The configuration is read on hot paths (every API request checks maintenance mode),
// so it is cached briefly. Writes through this service invalidate immediately; other
// instances pick changes up within the TTL.
const TTL_MS = 10_000;

interface Snapshot {
  at: number;
  system: SystemConfig;
  panel: PanelConfig;
  pub: PublicConfig;
}

let cache: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;

async function load(): Promise<Snapshot> {
  const [system, panel, policies, languages] = await Promise.all([
    systemConfigRepository.get(),
    panelRepository.get(),
    policyRepository.listPublished(),
    languagesRepository.listEnabled(),
  ]);
  const google = system.extensionSettings?.googleLogin;
  const pub: PublicConfig = {
    siteTitle: system.siteTitle ?? panel.name,
    tagline: panel.tagline,
    baseColor: system.siteBaseColor ?? "#16a34a",
    logo: panel.logo,
    favicon: panel.favicon,
    companyName: panel.companyName,
    supportEmail: panel.supportEmail,
    userRegistration: system.userRegistration ?? true,
    agreePolicy: (system.agreePolicy ?? true) && policies.length > 0,
    forceSecurePassword: system.forceSecurePassword ?? true,
    emailVerification: system.emailVerification ?? false,
    languageOption: (system.languageOption ?? true) && languages.length > 1,
    googleLogin: Boolean(google?.enabled && google.clientId && google.clientSecret),
    frontend: system.frontendSettings ?? {},
    gdprCookie: system.gdprCookie ?? { enabled: false, bannerText: "", acceptButtonText: "Accept", declineButtonText: "Decline", policyUrl: "", cookieLifespanDays: 365 },
    customCss: system.customCss ?? "",
    maintenance: { enabled: Boolean(system.maintenanceMode?.enabled), title: system.maintenanceMode?.title ?? "", content: system.maintenanceMode?.content ?? "" },
    policies,
    languages,
    recordsPerPage: system.recordsPerPage ?? 20,
    currency: system.currency ?? "USD",
    currencySymbol: system.currencySymbol ?? "$",
  };
  return { at: Date.now(), system, panel, pub };
}

async function current(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (!loading) loading = load().finally(() => (loading = null));
  const snap = await loading;
  cache = snap;
  return snap;
}

export const systemConfig = {
  get: async () => (await current()).system,
  panel: async () => (await current()).panel,
  public: async () => (await current()).pub,
  invalidate() {
    cache = null;
  },
  isCached: () => Boolean(cache && Date.now() - cache.at < TTL_MS),
  async update(patch: Parameters<typeof systemConfigRepository.update>[0]) {
    const r = await systemConfigRepository.update(patch);
    this.invalidate();
    return r;
  },
  async updatePanel(patch: Parameters<typeof panelRepository.update>[0]) {
    const r = await panelRepository.update(patch);
    this.invalidate();
    return r;
  },
};

export const DEFAULT_ROBOTS = (base: string) => `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`;

export async function defaultSitemap(): Promise<string> {
  const base = publicBaseUrl();
  const policies = await policyRepository.listPublished();
  const urls = [
    { loc: `${base}/login`, freq: "monthly", priority: "0.8" },
    { loc: `${base}/signup`, freq: "monthly", priority: "0.8" },
    ...policies.map((p) => ({ loc: `${base}/policy/${p.slug}`, freq: "monthly", priority: "0.5" })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
    .join("\n")}\n</urlset>\n`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Injects title, SEO/Open Graph meta, favicon, theme colour and custom CSS into the SPA shell. */
export async function renderIndexHtml(html: string): Promise<string> {
  let s: SystemConfig, p: PanelConfig;
  try {
    ({ system: s, panel: p } = await current());
  } catch {
    return html; // database unavailable: serve the plain shell
  }
  const seo = s.seoSettings ?? {};
  const title = seo.metaTitle || s.siteTitle || p.name;
  const tags = [
    seo.metaDescription && `<meta name="description" content="${esc(seo.metaDescription)}" />`,
    seo.metaKeywords?.length && `<meta name="keywords" content="${esc(seo.metaKeywords.join(", "))}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    seo.metaDescription && `<meta property="og:description" content="${esc(seo.metaDescription)}" />`,
    seo.ogImage && `<meta property="og:image" content="${esc(seo.ogImage)}" />`,
    `<meta name="theme-color" content="${esc(s.siteBaseColor ?? "#16a34a")}" />`,
    s.customCss?.trim() && `<style id="custom-css">${s.customCss.replace(/<\/style/gi, "<\\/style")}</style>`,
  ]
    .filter(Boolean)
    .join("\n    ");
  let out = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  if (p.favicon) out = out.replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="${esc(p.favicon)}" />`);
  return out.replace("</head>", `    ${tags}\n  </head>`);
}
