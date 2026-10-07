/**
 * Public landing page: content model, validation and starter content. The superadmin edits it
 * under Landing page; the page renders at "/" for visitors who aren't signed in.
 */
import { z } from "zod";

export const LANDING_ICONS = [
  "message-circle", "mail", "message-square-text", "megaphone", "users", "bar-chart", "zap", "shield",
  "clock", "globe", "inbox", "sparkles", "target", "repeat", "layout-template", "workflow",
] as const;
export type LandingIcon = (typeof LANDING_ICONS)[number];

/** http(s) URLs, in-page anchors (#pricing) and site paths (/signup). Never javascript: and friends. */
const href = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^(https?:\/\/|\/(?!\/)|#|mailto:)/i.test(v), "Use https://…, /path, #section or mailto:");
const text = (max: number) => z.string().trim().max(max).default("");
const link = z.object({ label: text(60), href: href.default("") });

const base = { id: z.string().trim().min(1).max(40), enabled: z.boolean().default(true) };
/** Optional in-page anchor so menus can link to a section, e.g. "pricing" → #pricing. */
const anchor = z.string().trim().max(40).regex(/^[a-z0-9-]*$/, "Lowercase letters, digits and -").default("");

export const landingSectionSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("hero"), anchor, eyebrow: text(80), title: text(160), subtitle: text(400), primary: link, secondary: link, image: href.default("") }),
  z.object({ ...base, type: z.literal("stats"), anchor, items: z.array(z.object({ value: text(20), label: text(60) })).max(6).default([]) }),
  z.object({ ...base, type: z.literal("features"), anchor, title: text(120), subtitle: text(300), items: z.array(z.object({ icon: z.enum(LANDING_ICONS).default("sparkles"), title: text(80), text: text(300) })).max(12).default([]) }),
  z.object({ ...base, type: z.literal("channels"), anchor, title: text(120), subtitle: text(300), whatsapp: text(300), email: text(300), sms: text(300) }),
  z.object({ ...base, type: z.literal("steps"), anchor, title: text(120), subtitle: text(300), items: z.array(z.object({ title: text(80), text: text(300) })).max(6).default([]) }),
  z.object({ ...base, type: z.literal("pricing"), anchor, title: text(120), subtitle: text(300), cta: text(40) }),
  z.object({ ...base, type: z.literal("testimonials"), anchor, title: text(120), items: z.array(z.object({ quote: text(500), name: text(80), role: text(100) })).max(9).default([]) }),
  z.object({ ...base, type: z.literal("faq"), anchor, title: text(120), items: z.array(z.object({ q: text(200), a: text(1500) })).max(20).default([]) }),
  z.object({ ...base, type: z.literal("cta"), anchor, title: text(160), subtitle: text(300), primary: link }),
  z.object({ ...base, type: z.literal("custom"), anchor, title: text(120), body: text(20_000) }),
]);
export type LandingSection = z.infer<typeof landingSectionSchema>;
export type LandingSectionType = LandingSection["type"];

export const landingPageSchema = z
  .object({
    enabled: z.boolean().default(false),
    nav: z
      .object({
        showLogin: z.boolean().default(true),
        showSignup: z.boolean().default(true),
        signupLabel: text(40),
        links: z.array(link).max(6).default([]),
      })
      .default({}),
    sections: z.array(landingSectionSchema).max(30).default([]),
    footer: z.object({ text: text(300), links: z.array(link).max(8).default([]) }).default({}),
  })
  .superRefine((v, ctx) => {
    const ids = new Set<string>();
    v.sections.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["sections", i, "id"], message: "Duplicate section id" });
      ids.add(s.id);
    });
  });
export type LandingPage = z.infer<typeof landingPageSchema>;

/** What each section type is for (editor labels). */
export const SECTION_TYPES: Record<LandingSectionType, { label: string; description: string }> = {
  hero: { label: "Hero", description: "Headline, sub-headline, buttons and an image." },
  stats: { label: "Stats", description: "A row of headline numbers." },
  features: { label: "Features", description: "Grid of features with icons." },
  channels: { label: "Channels", description: "WhatsApp, email and SMS side by side." },
  steps: { label: "How it works", description: "Numbered steps." },
  pricing: { label: "Pricing", description: "Your plans, pulled from Plans automatically." },
  testimonials: { label: "Testimonials", description: "Customer quotes." },
  faq: { label: "FAQ", description: "Questions and answers." },
  cta: { label: "Call to action", description: "Closing banner with a button." },
  custom: { label: "Custom text", description: "Free-form content (Markdown)." },
};

/** A new section of the given type, with sensible placeholder content. */
export function newSection(type: LandingSectionType, id: string): LandingSection {
  const blank: { [K in LandingSectionType]: Omit<Extract<LandingSection, { type: K }>, "id" | "enabled"> } = {
    hero: { type: "hero", anchor: "", eyebrow: "", title: "Your headline", subtitle: "", primary: { label: "Get started", href: "/signup" }, secondary: { label: "", href: "" }, image: "" },
    stats: { type: "stats", anchor: "", items: [{ value: "10k+", label: "Messages a day" }] },
    features: { type: "features", anchor: "features", title: "Features", subtitle: "", items: [{ icon: "sparkles", title: "Feature", text: "What it does for your customers." }] },
    channels: { type: "channels", anchor: "channels", title: "Every channel, one place", subtitle: "", whatsapp: "", email: "", sms: "" },
    steps: { type: "steps", anchor: "how-it-works", title: "How it works", subtitle: "", items: [{ title: "Step one", text: "" }] },
    pricing: { type: "pricing", anchor: "pricing", title: "Pricing", subtitle: "", cta: "Choose plan" },
    testimonials: { type: "testimonials", anchor: "", title: "What customers say", items: [{ quote: "", name: "", role: "" }] },
    faq: { type: "faq", anchor: "faq", title: "Frequently asked questions", items: [{ q: "", a: "" }] },
    cta: { type: "cta", anchor: "", title: "Ready to start?", subtitle: "", primary: { label: "Create your account", href: "/signup" } },
    custom: { type: "custom", anchor: "", title: "", body: "" },
  };
  return { id, enabled: true, ...blank[type] } as LandingSection;
}

/** Starter content: balanced across WhatsApp, email and SMS. Disabled until the superadmin turns it on. */
export const DEFAULT_LANDING: LandingPage = {
  enabled: false,
  nav: {
    showLogin: true,
    showSignup: true,
    signupLabel: "Start free",
    links: [
      { label: "Features", href: "#features" },
      { label: "Channels", href: "#channels" },
      { label: "Pricing", href: "#pricing" },
      { label: "FAQ", href: "#faq" },
    ],
  },
  sections: [
    {
      id: "hero",
      type: "hero",
      enabled: true,
      anchor: "",
      eyebrow: "WhatsApp · Email · SMS",
      title: "Reach every customer on the channel they actually read",
      subtitle: "Run WhatsApp, email and SMS campaigns from one place, reply to customers in a shared inbox, and see what works — without juggling three tools.",
      primary: { label: "Start free", href: "/signup" },
      secondary: { label: "See pricing", href: "#pricing" },
      image: "",
    },
    {
      id: "stats",
      type: "stats",
      enabled: true,
      anchor: "",
      items: [
        { value: "3", label: "Channels in one dashboard" },
        { value: "98%", label: "WhatsApp open rates" },
        { value: "5 min", label: "To your first campaign" },
        { value: "24/7", label: "Delivery tracking" },
      ],
    },
    {
      id: "channels",
      type: "channels",
      enabled: true,
      anchor: "channels",
      title: "Every channel, one place",
      subtitle: "Pick the right channel for each message — or use all three.",
      whatsapp: "Approved templates, rich conversations and a shared team inbox for two-way chat.",
      email: "Newsletters and promotions with templates, open tracking and one-click unsubscribe.",
      sms: "Short, urgent messages through Twilio or Vonage, with delivery receipts.",
    },
    {
      id: "features",
      type: "features",
      enabled: true,
      anchor: "features",
      title: "Everything you need to grow",
      subtitle: "Built for teams that talk to customers every day.",
      items: [
        { icon: "megaphone", title: "Campaigns", text: "Send to everyone, a group, or an uploaded list — now or on a schedule." },
        { icon: "users", title: "Contacts & groups", text: "Import from CSV, organise with groups and tags, keep custom fields." },
        { icon: "inbox", title: "Team inbox", text: "Assign conversations, reply together and never miss a message." },
        { icon: "bar-chart", title: "Analytics", text: "Delivery, read and open rates per campaign and per channel." },
        { icon: "workflow", title: "API", text: "Send from your own apps with one endpoint and access keys." },
        { icon: "shield", title: "Secure by design", text: "Roles and permissions, audit logs and encrypted credentials." },
      ],
    },
    {
      id: "steps",
      type: "steps",
      enabled: true,
      anchor: "how-it-works",
      title: "Up and running in minutes",
      subtitle: "",
      items: [
        { title: "Connect your channels", text: "Add a WhatsApp number, your SMTP server and an SMS gateway." },
        { title: "Bring your contacts", text: "Import a CSV or add them by hand, then group them." },
        { title: "Send and measure", text: "Launch a campaign and watch delivery and engagement live." },
      ],
    },
    { id: "pricing", type: "pricing", enabled: true, anchor: "pricing", title: "Simple pricing", subtitle: "Start free and upgrade when you grow.", cta: "Get started" },
    {
      id: "faq",
      type: "faq",
      enabled: true,
      anchor: "faq",
      title: "Frequently asked questions",
      items: [
        { q: "Do I need all three channels?", a: "No. Use any channel on its own and add the others when you're ready." },
        { q: "Can I try it before connecting real accounts?", a: "Yes. Built-in simulators let you test WhatsApp, email and SMS end to end." },
        { q: "Can my team work together?", a: "Invite team members, give them exactly the permissions they need, and share one inbox." },
      ],
    },
    { id: "cta", type: "cta", enabled: true, anchor: "", title: "Start talking to your customers today", subtitle: "Free plan, no credit card required.", primary: { label: "Create your account", href: "/signup" } },
  ],
  footer: { text: "", links: [] },
};

/** Stored config merged onto defaults, so older or partial saves still render. */
export function resolveLanding(stored: unknown): LandingPage {
  if (!stored || typeof stored !== "object" || !Object.keys(stored).length) return DEFAULT_LANDING;
  const parsed = landingPageSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_LANDING;
}
