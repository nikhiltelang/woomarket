/** Platform administration: settings validators, the public config shape and UI translation keys. */
import type { PublicBrand } from "./white-label";
import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #16a34a");
const bool = z.boolean();

export const generalSettingsSchema = z.object({
  siteTitle: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(64),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, "3-letter ISO code, e.g. USD"),
  currencySymbol: z.string().trim().min(1).max(5),
  siteBaseColor: hex,
  recordsPerPage: z.coerce.number().int().min(5).max(200),
  currencyDisplayMode: z.enum(["symbol", "code", "both"]),
});

export const brandingSchema = z.object({
  name: z.string().trim().min(1).max(100),
  tagline: z.string().trim().max(255).nullish(),
  companyName: z.string().trim().max(255).nullish(),
  companyWebsite: z.string().trim().url().or(z.literal("")).nullish(),
  supportEmail: z.string().trim().email().or(z.literal("")).nullish(),
});

/** Feature switches that the platform actually enforces. */
export const systemSwitchesSchema = z
  .object({
    userRegistration: bool,
    forceSsl: bool,
    agreePolicy: bool,
    forceSecurePassword: bool,
    emailVerification: bool,
    emailNotification: bool,
    languageOption: bool,
    twoFactorPolicy: z.enum(["optional", "superadmin", "admins"]),
  })
  .partial();

export const notificationSettingsSchema = z.object({
  globalEmailTemplate: z
    .string()
    .max(100_000)
    .refine((v) => !v.trim() || v.includes("{{message}}"), "The template must contain {{message}} where the email body goes"),
});

export const seoSettingsSchema = z.object({
  metaTitle: z.string().trim().max(70).optional(),
  metaDescription: z.string().trim().max(170).optional(),
  metaKeywords: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  ogImage: z.string().trim().url().or(z.literal("")).optional(),
});

export const frontendSettingsSchema = z.object({
  heroTitle: z.string().trim().max(120).optional(),
  heroSubtitle: z.string().trim().max(300).optional(),
  features: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  footerText: z.string().trim().max(200).optional(),
});

export const socialLoginSchema = z.object({
  googleLogin: z.object({
    enabled: bool,
    clientId: z.string().trim().max(255),
    /** Omit to keep the stored secret. */
    clientSecret: z.string().trim().max(255).optional(),
  }),
  microsoftLogin: z
    .object({
      enabled: bool,
      clientId: z.string().trim().max(255),
      clientSecret: z.string().trim().max(255).optional(),
      /** "common", "organizations", "consumers", a directory (tenant) id or a verified domain */
      tenant: z
        .string()
        .trim()
        .max(255)
        .regex(/^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i, "Use common, organizations, consumers, a directory ID or a domain")
        .default("common"),
    })
    .optional(),
});

export const maintenanceSchema = z.object({
  enabled: bool,
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(2000),
  bypassSecret: z.string().trim().max(100).regex(/^[A-Za-z0-9_-]*$/, "Letters, numbers, dash and underscore only"),
});

export const gdprCookieSchema = z.object({
  enabled: bool,
  bannerText: z.string().trim().min(1).max(1000),
  acceptButtonText: z.string().trim().min(1).max(40),
  declineButtonText: z.string().trim().min(1).max(40),
  policyUrl: z.string().trim().max(255),
  cookieLifespanDays: z.coerce.number().int().min(1).max(730),
});

export const customCssSchema = z.object({ customCss: z.string().max(100_000) });
export const robotsSchema = z.object({ robotsTxt: z.string().max(20_000) });
export const sitemapSchema = z.object({
  sitemapXml: z
    .string()
    .max(1_000_000)
    .refine((v) => !v.trim() || /^\s*(<\?xml[^>]*>\s*)?<(urlset|sitemapindex)\b/.test(v), "Must be a <urlset> or <sitemapindex> XML document"),
});

export const policyPageSchema = z.object({
  title: z.string().trim().min(1).max(255),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and dashes"),
  content: z.string().min(1).max(200_000),
  metaTitle: z.string().trim().max(255).nullish(),
  metaDescription: z.string().trim().max(500).nullish(),
  isPublished: bool.default(true),
});

const limit = z.coerce.number().int().min(-1, "-1 means unlimited");
export const accessLevelSchema = z.object({
  levelNumber: z.coerce.number().int().min(1).max(999),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).nullish(),
  badgeColor: z.enum(["blue", "green", "amber", "purple", "red", "gray"]).default("blue"),
  maxChannels: limit,
  maxContacts: limit,
  maxMessagesMonthly: limit,
  maxCampaigns: limit,
  aiAssistantEnabled: bool,
  whiteLabel: bool,
  smsEnabled: bool,
  emailEnabled: bool,
  prioritySupport: bool,
  apiAccess: bool,
});

export const assignLevelSchema = z.object({ level: z.number().int().min(1).nullable() });

export const languageSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, "ISO code like en, es or pt-BR"),
  name: z.string().trim().min(1).max(100),
  nativeName: z.string().trim().min(1).max(100),
  icon: z.string().trim().max(10).nullish(),
  direction: z.enum(["ltr", "rtl"]).default("ltr"),
  isEnabled: bool.default(true),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export const translationsSchema = z.object({ translations: z.record(z.string().max(100), z.string().max(2000)) });

export const sendNotificationSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(5000),
    type: z.enum(["general", "announcement", "maintenance", "promotion"]).default("general"),
    targetType: z.enum(["all", "admins", "team", "superadmins", "users"]),
    targetIds: z.array(z.string().uuid()).max(5000).default([]),
    viaInApp: bool.default(true),
    viaEmail: bool.default(false),
  })
  .refine((v) => v.viaInApp || v.viaEmail, { message: "Choose at least one delivery channel", path: ["viaInApp"] })
  .refine((v) => v.targetType !== "users" || v.targetIds.length > 0, { message: "Choose at least one user", path: ["targetIds"] });

export const couponSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{3,40}$/, "3–40 letters, digits, - or _"),
    type: z.enum(["fixed", "percent"]),
    discountValue: z.coerce.number().positive("Must be more than 0").max(99_999_999),
    expiryType: z.enum(["lifetime", "date"]),
    expiresAt: z.coerce.date().nullish(),
    usageLimit: z.coerce
      .number()
      .int()
      .min(-1)
      .refine((n) => n !== 0, "Enter -1 for unlimited or at least 1"),
    status: bool.default(true),
  })
  .refine((v) => v.type !== "percent" || v.discountValue <= 100, { message: "A percentage can't exceed 100", path: ["discountValue"] })
  .refine((v) => v.expiryType !== "date" || v.expiresAt, { message: "Choose an expiry date", path: ["expiresAt"] });

export const couponPreviewSchema = z.object({
  code: z.string().trim().toUpperCase().min(1).max(40),
  planId: z.string().uuid(),
  billingCycle: z.enum(["monthly", "annual"]).default("monthly"),
});

/** Discount a coupon gives on a price, rounded to cents and never more than the price. */
export function couponDiscount(coupon: { type: string; discountValue: string | number }, price: number): number {
  const value = Number(coupon.discountValue);
  const raw = coupon.type === "percent" ? (price * value) / 100 : value;
  return Math.round(Math.min(Math.max(raw, 0), price) * 100) / 100;
}

export const SUPPORT_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export const supportRequestSchema = z.object({
  type: z.enum(["bug", "support"]),
  message: z.string().trim().min(10, "Please describe it in at least 10 characters").max(5000),
});
export const supportUpdateSchema = z.object({
  status: z.enum(SUPPORT_STATUSES),
  reply: z.string().trim().max(5000).nullish(),
});

export const REQUEST_LOG_DEFAULTS = { enabled: true, captureBodies: true, retentionDays: 14, excludePaths: [] as string[] };
export const requestLogSettingsSchema = z.object({
  enabled: bool,
  captureBodies: bool,
  retentionDays: z.coerce.number().int().min(1, "At least 1 day").max(365, "At most 365 days"),
  excludePaths: z.array(z.string().trim().regex(/^\/\S{0,299}$/, "Each path starts with / and has no spaces")).max(50),
});

export const verifyEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});
export const resendVerificationSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const banUserSchema = z.object({ reason: z.string().trim().min(1, "Give a reason").max(500) });

/** Strong-password rule, applied when "force secure password" is on. */
export function passwordProblems(pw: string): string | null {
  if (pw.length < 8) return "At least 8 characters";
  if (!/[a-z]/.test(pw)) return "Include a lowercase letter";
  if (!/[A-Z]/.test(pw)) return "Include an uppercase letter";
  if (!/\d/.test(pw)) return "Include a number";
  return null;
}

/** Settings that unauthenticated pages (and the SPA shell) may read. */
export interface PublicConfig {
  siteTitle: string;
  tagline: string | null;
  baseColor: string;
  logo: string | null;
  favicon: string | null;
  companyName: string | null;
  supportEmail: string | null;
  userRegistration: boolean;
  agreePolicy: boolean;
  forceSecurePassword: boolean;
  emailVerification: boolean;
  languageOption: boolean;
  googleLogin: boolean;
  microsoftLogin: boolean;
  twoFactorPolicy: TwoFactorPolicy;
  /** White-label branding for this domain (or the signed-in client's agency). */
  brand: PublicBrand | null;
  frontend: { heroTitle?: string; heroSubtitle?: string; features?: string[]; footerText?: string };
  gdprCookie: { enabled: boolean; bannerText: string; acceptButtonText: string; declineButtonText: string; policyUrl: string; cookieLifespanDays: number };
  customCss: string;
  maintenance: { enabled: boolean; title: string; content: string };
  policies: { title: string; slug: string }[];
  languages: { code: string; name: string; nativeName: string; icon: string | null; direction: string; isDefault: boolean }[];
  recordsPerPage: number;
  currency: string;
  currencySymbol: string;
}

/** English base strings; languages override any subset of these keys. */
export const BASE_TRANSLATIONS: Record<string, string> = {
  "nav.workspace": "Workspace",
  "nav.overview": "Overview",
  "nav.audience": "Audience",
  "nav.whatsappMarketing": "WhatsApp marketing",
  "nav.channelSettings": "Settings",
  "nav.dashboard": "Dashboard",
  "nav.reports": "Reports",
  "nav.inbox": "Inbox",
  "nav.widget": "Website widget",
  "nav.social": "Instagram & Messenger",
  "nav.contacts": "Contacts",
  "nav.groups": "Groups",
  "nav.segments": "Segments",
  "nav.templates": "Templates",
  "nav.campaigns": "Campaigns",
  "nav.marketing": "Marketing",
  "nav.emailMarketing": "Email marketing",
  "nav.smsMarketing": "SMS marketing",
  "nav.account": "Account",
  "nav.team": "Team",
  "nav.whatsappNumbers": "WhatsApp numbers",
  "nav.plan": "Plan & usage",
  "nav.platform": "Platform",
  "nav.manageUsers": "Manage users",
  "nav.activeUsers": "Active users",
  "nav.bannedUsers": "Banned users",
  "nav.emailUnverified": "Email unverified",
  "nav.mobileUnverified": "Mobile unverified",
  "nav.withSubscription": "With subscription",
  "nav.allUsers": "All users",
  "nav.sendNotification": "Send notification",
  "nav.manageLevels": "Manage levels",
  "nav.channels": "Channels",
  "nav.plans": "Plans",
  "nav.system": "System",
  "nav.systemSettings": "System settings",
  "nav.appUpdate": "Update",
  "nav.coupons": "Manage coupons",
  "nav.extra": "Extra",
  "nav.application": "Application",
  "nav.server": "Server",
  "nav.cache": "Cache",
  "nav.reportRequest": "Report & request",
  "nav.logs": "Logs",
  "nav.apiKeys": "API keys",
  "nav.webhooks": "Webhooks",
  "nav.whiteLabel": "White-label",
  "nav.landingPage": "Landing page",
  "nav.preferences": "Sending preferences",
  "nav.signOut": "Sign out",
  "nav.signingOut": "Signing out…",
  "topbar.live": "Live",
  "topbar.offline": "Offline",
  "topbar.notifications": "Notifications",
  "topbar.markAllRead": "Mark all as read",
  "topbar.noNotifications": "You're all caught up",
  "auth.signIn": "Sign in",
  "auth.signInTitle": "Sign in to {site}",
  "auth.username": "Username or email",
  "auth.password": "Password",
  "auth.noAccount": "New here?",
  "auth.createAccount": "Create an account",
  "auth.haveAccount": "Already have an account?",
  "auth.signupTitle": "Create your account",
  "auth.continueWithGoogle": "Continue with Google",
  "auth.continueWithMicrosoft": "Continue with Microsoft",
  "auth.or": "or",
  "auth.verifyTitle": "Verify your email",
  "auth.verifyHelp": "We sent a 6-digit code to {email}. It expires in 10 minutes.",
  "auth.verify": "Verify",
  "auth.resend": "Resend code",
  "auth.agreeTerms": "I agree to the",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.search": "Search",
  "common.language": "Language",
  "cookie.manage": "Cookie policy",
};

export function translate(dict: Record<string, string>, key: string, vars?: Record<string, string>): string {
  const raw = dict[key] || BASE_TRANSLATIONS[key] || key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`) : raw;
}

// ---------------------------------------------------------------------------
// Two-factor authentication
// ---------------------------------------------------------------------------

export type TwoFactorPolicy = "optional" | "superadmin" | "admins";

/** Whether a role must have two-factor authentication under the platform policy. */
export function twoFactorRequired(role: string, policy: string | null | undefined): boolean {
  if (policy === "superadmin") return role === "superadmin";
  if (policy === "admins") return role === "superadmin" || role === "admin";
  return false;
}

export const twoFactorCodeSchema = z.object({
  /** 6-digit authenticator code, or a recovery code (xxxxx-xxxxx). */
  code: z.string().trim().min(6).max(20),
});
