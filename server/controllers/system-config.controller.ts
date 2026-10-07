import type { Request, Response } from "express";
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
import { encryptSecret } from "../lib/crypto";
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
  return {
    ...s,
    extensionSettings: {
      googleLogin: { enabled: Boolean(google?.enabled), clientId: google?.clientId ?? "", hasClientSecret: Boolean(google?.clientSecret) },
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
    defaults: { robotsTxt: DEFAULT_ROBOTS(publicBaseUrl()), sitemapXml: await defaultSitemap() },
  });
}

export async function getPublic(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-cache");
  res.json({ data: await systemConfig.public() });
}

const SECTIONS = {
  general: generalSettingsSchema,
  configuration: systemSwitchesSchema,
  notification: notificationSettingsSchema,
  seo: seoSettingsSchema,
  frontend: frontendSettingsSchema,
  "social-login": socialLoginSchema,
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
    case "social-login": {
      const prev = current.extensionSettings?.googleLogin;
      const secret = input.googleLogin.clientSecret ? encryptSecret(input.googleLogin.clientSecret) : prev?.clientSecret;
      if (input.googleLogin.enabled && (!input.googleLogin.clientId || !secret)) throw badRequest("Client ID and client secret are required to enable Google sign-in");
      patch = { extensionSettings: { ...current.extensionSettings, googleLogin: { enabled: input.googleLogin.enabled, clientId: input.googleLogin.clientId, clientSecret: secret } } };
      break;
    }
    default:
      patch = input;
  }
  const updated = await systemConfig.update(patch);
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

