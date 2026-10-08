import type { Request, Response } from "express";
import { config } from "../config";
import { maskRedisUrl, queueSettingsSchema } from "@shared/queue";
import { queueManager, queueSettings, testRedis } from "../services/queue/manager";
import { usersRepository } from "../repositories/users.repository";
import { billingRepository } from "../repositories/billing.repository";
import { agencyOf, brandsRepository, toPublicBrand } from "../services/white-label.service";
import { aiSettingsSchema, DEFAULT_AI_MODEL, DEFAULT_AI_MONTHLY_LIMIT } from "@shared/ai";
import { signupSettingsSchema } from "@shared/whatsapp-signup";
import { paymentSettingsSchema } from "@shared/billing";
import { z } from "zod";
import {
  brandingSchema,
  customCssSchema,
  frontendSettingsSchema,
  gdprCookieSchema,
  generalSettingsSchema,
  maintenanceSchema,
  notificationSettingsSchema,
  requestLogSettingsSchema,
  robotsSchema,
  seoSettingsSchema,
  sitemapSchema,
  socialLoginSchema,
  systemSwitchesSchema,
} from "@shared/platform";
import type { SystemConfig } from "@shared/schema";
import { parse } from "../lib/http";
import { badRequest, notFound, unprocessable } from "../lib/errors";
import { decryptStoredSecret, encryptSecret, encryptStoredSecret } from "../lib/crypto";
import { publicBaseUrl } from "../lib/tokens";
import { removeUpload, saveImage } from "../lib/uploads";
import { activityRepository } from "../repositories/activity.repository";
import { cronLogRepository } from "../repositories/platform.repository";
import { DEFAULT_ROBOTS, defaultSitemap, systemConfig } from "../services/system-config.service";
import { sendSystemEmail, textToHtml } from "../services/email/system-mail";
import { executeJob, isRunning, jobs, nextRunAt } from "../cron/scheduler";

/** Full configuration for the superadmin; secrets are replaced by "is set" flags. */
function adminView(s: SystemConfig) {
  const google = s.extensionSettings?.googleLogin;
  const microsoft = s.extensionSettings?.microsoftLogin;
  return {
    ...s,
    extensionSettings: {
      googleLogin: { enabled: Boolean(google?.enabled), clientId: google?.clientId ?? "", hasClientSecret: Boolean(google?.clientSecret) },
      microsoftLogin: { enabled: Boolean(microsoft?.enabled), clientId: microsoft?.clientId ?? "", tenant: microsoft?.tenant ?? "common", hasClientSecret: Boolean(microsoft?.clientSecret) },
      queue: (() => {
        const q = s.extensionSettings?.queue;
        const url = q?.url ? decryptStoredSecret(q.url) : null;
        return { enabled: q ? q.enabled : Boolean(config.REDIS_URL), prefix: q?.prefix ?? "wm360", concurrency: q?.concurrency ?? 2, urlMasked: url ? maskRedisUrl(url) : null, envUrl: config.REDIS_URL ? maskRedisUrl(config.REDIS_URL) : null };
      })(),
      payments: (() => {
        const p = s.extensionSettings?.payments;
        return {
          stripe: { enabled: Boolean(p?.stripe?.enabled), publishableKey: p?.stripe?.publishableKey ?? "", hasSecretKey: Boolean(p?.stripe?.secretKey), hasWebhookSecret: Boolean(p?.stripe?.webhookSecret) },
          razorpay: { enabled: Boolean(p?.razorpay?.enabled), keyId: p?.razorpay?.keyId ?? "", hasKeySecret: Boolean(p?.razorpay?.keySecret), hasWebhookSecret: Boolean(p?.razorpay?.webhookSecret) },
          taxRate: p?.taxRate ?? 0,
          taxLabel: p?.taxLabel ?? "Tax",
          invoiceDetails: p?.invoiceDetails ?? "",
          trialPlanId: p?.trialPlanId ?? null,
          trialDays: p?.trialDays ?? 0,
        };
      })(),
      whatsappSignup: (() => {
        const w = s.extensionSettings?.whatsappSignup;
        return { enabled: Boolean(w?.enabled), appId: w?.appId ?? "", configId: w?.configId ?? "", coexistence: w?.coexistence ?? true, hasAppSecret: Boolean(w?.appSecret), envAppSecret: Boolean(config.WHATSAPP_APP_SECRET) };
      })(),
      aiAssistant: { enabled: Boolean(s.extensionSettings?.aiAssistant?.enabled), model: s.extensionSettings?.aiAssistant?.model ?? DEFAULT_AI_MODEL, monthlyLimit: s.extensionSettings?.aiAssistant?.monthlyLimit ?? DEFAULT_AI_MONTHLY_LIMIT, hasApiKey: Boolean(s.extensionSettings?.aiAssistant?.apiKey) },
    },
    maintenanceMode: s.maintenanceMode,
  };
}

export async function getAll(_req: Request, res: Response) {
  const [s, panel] = await Promise.all([systemConfig.get(), systemConfig.panel()]);
  res.json({
    data: adminView(s),
    panel,
    googleRedirectUri: `${publicBaseUrl()}/api/auth/google/callback`,
    microsoftRedirectUri: `${publicBaseUrl()}/api/auth/microsoft/callback`,
    defaults: { robotsTxt: DEFAULT_ROBOTS(publicBaseUrl()), sitemapXml: await defaultSitemap() },
  });
}

export async function getPublic(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-cache");
  const pub = await systemConfig.public();
  // White-label: the brand of this domain, else the signed-in client's agency.
  let brand = req.brand ?? null;
  const onBrandDomain = Boolean(brand);
  if (!brand && req.user) {
    const user = await usersRepository.findById(req.user.id);
    const agency = user ? await agencyOf(user) : null;
    brand = agency ? ((await brandsRepository.byOwner(agency)) ?? null) : null;
  }
  if (!brand) return res.json({ data: { ...pub, brand: null } });
  const b = toPublicBrand(brand, pub.siteTitle, onBrandDomain);
  res.json({
    data: {
      ...pub,
      siteTitle: b.name,
      tagline: b.loginSubtitle ?? pub.tagline,
      logo: b.logo,
      favicon: b.favicon ?? pub.favicon,
      baseColor: b.baseColor,
      companyName: b.name,
      supportEmail: b.supportEmail,
      ...(onBrandDomain
        ? {
            userRegistration: pub.userRegistration && b.allowSignup,
            googleLogin: false,
            microsoftLogin: false,
            frontend: { ...pub.frontend, heroTitle: b.loginTitle ?? undefined, heroSubtitle: b.loginSubtitle ?? undefined, features: [] },
          }
        : {}),
      brand: b,
    },
  });
}

const SECTIONS = {
  general: generalSettingsSchema,
  configuration: systemSwitchesSchema,
  notification: notificationSettingsSchema,
  seo: seoSettingsSchema,
  frontend: frontendSettingsSchema,
  "social-login": socialLoginSchema,
  "ai-assistant": aiSettingsSchema,
  "whatsapp-signup": signupSettingsSchema,
  payments: paymentSettingsSchema,
  queue: queueSettingsSchema,
  maintenance: maintenanceSchema,
  "gdpr-cookie": gdprCookieSchema,
  "custom-css": customCssSchema,
  robots: robotsSchema,
  sitemap: sitemapSchema,
  "request-logs": requestLogSettingsSchema,
} as const;
type Section = keyof typeof SECTIONS;

/** PUT /api/system-config/:section — one settings card at a time. */
export async function updateSection(req: Request, res: Response) {
  const section = req.params.section as Section;
  if (!(section in SECTIONS)) throw notFound("Settings section");
  const input = parse(SECTIONS[section] as z.ZodTypeAny, req.body ?? {});
  const current = await systemConfig.get();

  let patch: Parameters<typeof systemConfig.update>[0];
  switch (section) {
    case "seo":
      patch = { seoSettings: input };
      break;
    case "frontend":
      patch = { frontendSettings: input };
      break;
    case "maintenance":
      patch = { maintenanceMode: input };
      break;
    case "gdpr-cookie":
      patch = { gdprCookie: input };
      break;
    case "request-logs":
      patch = { requestLogSettings: { ...input, excludePaths: [...new Set(input.excludePaths as string[])] } };
      break;
    case "queue": {
      const prev = current.extensionSettings?.queue;
      const url = input.url ? encryptStoredSecret(input.url) : prev?.url;
      if (input.enabled && !url && !config.REDIS_URL) throw badRequest("Enter the Redis URL to turn Redis mode on");
      patch = { extensionSettings: { ...current.extensionSettings, queue: { enabled: input.enabled, url, prefix: input.prefix, concurrency: input.concurrency } } };
      break;
    }
    case "payments": {
      const prev = current.extensionSettings?.payments;
      const keep = (v: string | undefined, old: string | undefined) => (v ? encryptStoredSecret(v) : old);
      const stripe = { enabled: input.stripe.enabled, publishableKey: input.stripe.publishableKey, secretKey: keep(input.stripe.secretKey, prev?.stripe?.secretKey), webhookSecret: keep(input.stripe.webhookSecret, prev?.stripe?.webhookSecret) };
      const razorpay = { enabled: input.razorpay.enabled, keyId: input.razorpay.keyId, keySecret: keep(input.razorpay.keySecret, prev?.razorpay?.keySecret), webhookSecret: keep(input.razorpay.webhookSecret, prev?.razorpay?.webhookSecret) };
      if (stripe.enabled && !stripe.secretKey) throw badRequest("Enter the Stripe secret key to turn Stripe on");
      if (stripe.secretKey && input.stripe.secretKey && !/^(sk|rk)_(test|live)_/.test(input.stripe.secretKey)) throw badRequest("The Stripe secret key starts with sk_live_ or sk_test_");
      if (razorpay.enabled && (!razorpay.keyId || !razorpay.keySecret)) throw badRequest("Enter the Razorpay key id and key secret to turn Razorpay on");
      if (input.trialDays > 0 && input.trialPlanId && !(await billingRepository.findPlan(input.trialPlanId))) throw badRequest("The trial plan doesn't exist");
      patch = { extensionSettings: { ...current.extensionSettings, payments: { stripe, razorpay, taxRate: input.taxRate, taxLabel: input.taxLabel, invoiceDetails: input.invoiceDetails, trialPlanId: input.trialPlanId ?? null, trialDays: input.trialDays } } };
      break;
    }
    case "whatsapp-signup": {
      const prev = current.extensionSettings?.whatsappSignup;
      const appSecret = input.appSecret ? encryptSecret(input.appSecret) : prev?.appSecret;
      if (input.enabled && (!input.appId || !input.configId || (!appSecret && !config.WHATSAPP_APP_SECRET))) throw badRequest("App ID, App secret and configuration ID are all needed to turn Embedded Signup on");
      patch = { extensionSettings: { ...current.extensionSettings, whatsappSignup: { enabled: input.enabled, appId: input.appId, configId: input.configId, coexistence: input.coexistence, appSecret } } };
      break;
    }
    case "ai-assistant": {
      const prev = current.extensionSettings?.aiAssistant;
      const apiKey = input.apiKey ? encryptSecret(input.apiKey) : prev?.apiKey;
      patch = { extensionSettings: { ...current.extensionSettings, aiAssistant: { enabled: input.enabled, model: input.model, monthlyLimit: input.monthlyLimit, apiKey } } };
      break;
    }
    case "social-login": {
      const prev = current.extensionSettings?.googleLogin;
      const secret = input.googleLogin.clientSecret ? encryptSecret(input.googleLogin.clientSecret) : prev?.clientSecret;
      if (input.googleLogin.enabled && (!input.googleLogin.clientId || !secret)) throw badRequest("Client ID and client secret are required to enable Google sign-in");
      const ext = { ...current.extensionSettings, googleLogin: { enabled: input.googleLogin.enabled, clientId: input.googleLogin.clientId, clientSecret: secret } };
      if (input.microsoftLogin) {
        const m = input.microsoftLogin;
        const prevMs = current.extensionSettings?.microsoftLogin;
        const msSecret = m.clientSecret ? encryptSecret(m.clientSecret) : prevMs?.clientSecret;
        if (m.enabled && (!m.clientId || !msSecret)) throw badRequest("Application (client) ID and client secret are required to enable Microsoft sign-in");
        ext.microsoftLogin = { enabled: m.enabled, clientId: m.clientId, clientSecret: msSecret, tenant: m.tenant };
      }
      patch = { extensionSettings: ext };
      break;
    }
    default:
      patch = input;
  }
  const updated = await systemConfig.update(patch);
  // Apply queue changes here now; other servers pick them up within 15 seconds.
  if (section === "queue") await queueManager.reconcile();
  await activityRepository.record(req, req.user!.id, "system_config_updated", { type: "system_config", id: section });
  res.json({ data: adminView(updated) });
}

/** Branding: name/tagline/company plus optional logo and favicon files (multipart). */
export async function updateBranding(req: Request, res: Response) {
  const body = { ...req.body };
  for (const k of ["tagline", "companyName", "companyWebsite", "supportEmail"]) if (body[k] === "") body[k] = null;
  const input = parse(brandingSchema, body);
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const panel = await systemConfig.panel();
  const patch: Parameters<typeof systemConfig.updatePanel>[0] = { ...input };
  for (const field of ["logo", "favicon"] as const) {
    const f = files[field]?.[0];
    if (f) {
      patch[field] = await saveImage(f, "branding");
      await removeUpload(panel[field]);
    } else if (req.body[`remove_${field}`] === "true") {
      patch[field] = null;
      await removeUpload(panel[field]);
    }
  }
  const updated = await systemConfig.updatePanel(patch);
  if (input.name) await systemConfig.update({ siteTitle: input.name, logo: updated.logo, favicon: updated.favicon });
  await activityRepository.record(req, req.user!.id, "branding_updated", { type: "panel_config", id: updated.id });
  res.json({ data: updated });
}

export async function getBranding(_req: Request, res: Response) {
  const p = await systemConfig.panel();
  res.json({ data: { name: p.name, tagline: p.tagline, logo: p.logo, favicon: p.favicon, companyName: p.companyName, companyWebsite: p.companyWebsite, supportEmail: p.supportEmail } });
}

/** Sends a sample through the global email template. */
export async function testEmail(req: Request, res: Response) {
  const { email } = parse(z.object({ email: z.string().trim().email() }), req.body ?? {});
  try {
    const r = await sendSystemEmail(email, "Test email from your platform", textToHtml("This is a test of your global email template.\n\nIf you can read this, platform emails are working."));
    res.json({ success: true, simulated: r.simulated });
  } catch (err) {
    throw unprocessable(`Could not send: ${(err as Error).message}`, "EMAIL_FAILED");
  }
}

// --- robots.txt & sitemap.xml (public, root paths) ----------------------------------

export async function robotsTxt(_req: Request, res: Response) {
  const s = await systemConfig.get();
  res.type("text/plain").send(s.robotsTxt?.trim() ? s.robotsTxt : DEFAULT_ROBOTS(publicBaseUrl()));
}

export async function sitemapXml(_req: Request, res: Response) {
  const s = await systemConfig.get();
  res.type("application/xml").send(s.sitemapXml?.trim() ? s.sitemapXml : await defaultSitemap());
}

// --- Cron jobs -------------------------------------------------------------------

export async function listCronJobs(_req: Request, res: Response) {
  const data = await Promise.all(
    jobs.map(async (j) => {
      const logs = await cronLogRepository.latest(j.key, 10);
      return {
        key: j.key,
        name: j.name,
        description: j.description,
        intervalSeconds: Math.round(j.intervalMs / 1000),
        running: isRunning(j.key),
        nextRunAt: nextRunAt.has(j.key) ? new Date(nextRunAt.get(j.key)!).toISOString() : null,
        lastRun: logs[0] ?? null,
        recent: logs,
      };
    }),
  );
  res.json({ data });
}

export async function runCronJob(req: Request, res: Response) {
  const job = jobs.find((j) => j.key === req.params.jobKey);
  if (!job) throw notFound("Cron job");
  const result = await executeJob(job);
  await activityRepository.record(req, req.user!.id, "cron_job_run", { type: "cron_job", id: job.key }, result);
  res.json({ data: result });
}



/** POST /api/system-config/queue/test { url? } — tries the URL (or the saved one). */
export async function testQueue(req: Request, res: Response) {
  const body = (req.body ?? {}) as { url?: string };
  const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : (await queueSettings()).url;
  if (!url) throw badRequest("Enter a Redis URL to test");
  if (!/^rediss?:\/\//.test(url)) throw badRequest("Use a redis:// or rediss:// URL");
  try {
    res.json({ data: await testRedis(url) });
  } catch (err) {
    throw badRequest(`Couldn't connect: ${(err as Error).message}`);
  }
}

/** GET /api/system-config/queue/status */
export async function queueStatus(_req: Request, res: Response) {
  res.json({ data: await queueManager.status() });
}
