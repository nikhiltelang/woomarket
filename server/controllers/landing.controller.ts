import type { Request, Response } from "express";
import { landingPageSchema, resolveLanding } from "@shared/landing";
import { badRequest } from "../lib/errors";
import { parseBody } from "../lib/http";
import { saveImage } from "../lib/uploads";
import { activityRepository } from "../repositories/activity.repository";
import { billingRepository } from "../repositories/billing.repository";
import { systemConfig } from "../services/system-config.service";

/** Plan fields that are safe to show publicly (no provider ids or internal limits). */
async function publicPlans() {
  return (await billingRepository.listPlans()).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    monthlyPrice: Number(p.monthlyPrice) || 0,
    annualPrice: Number(p.annualPrice) || 0,
    features: p.features ?? [],
    popular: Boolean(p.popular),
    badge: p.badge,
  }));
}

/**
 * GET /api/landing-page (public). When the page is off, only `{ enabled: false }` is returned,
 * so draft content isn't visible before the superadmin publishes it.
 */
export async function getPublic(_req: Request, res: Response) {
  const page = resolveLanding((await systemConfig.get()).landingPage);
  res.setHeader("Cache-Control", "no-cache");
  if (!page.enabled) return res.json({ data: { enabled: false } });
  const sections = page.sections.filter((s) => s.enabled);
  const plans = sections.some((s) => s.type === "pricing") ? await publicPlans() : [];
  res.json({ data: { ...page, sections }, plans });
}

/** GET /api/superadmin/landing-page — everything, including hidden sections and drafts. */
export async function getAdmin(_req: Request, res: Response) {
  const stored = (await systemConfig.get()).landingPage;
  res.json({ data: resolveLanding(stored), configured: Boolean(stored && Object.keys(stored).length), plans: await publicPlans() });
}

/** PUT /api/superadmin/landing-page — saves (and publishes, when enabled) the whole page. */
export async function update(req: Request, res: Response) {
  const page = parseBody(landingPageSchema, req);
  await systemConfig.update({ landingPage: page as unknown as Record<string, unknown> });
  await activityRepository.record(req, req.user!.id, "landing_page_updated", { type: "system_config", id: "landing_page" }, { enabled: page.enabled, sections: page.sections.length });
  res.json({ data: page });
}

/** POST /api/superadmin/landing-page/image — uploads an image for a section (PNG/JPG/GIF/WebP, 2 MB). */
export async function uploadImage(req: Request, res: Response) {
  if (!req.file) throw badRequest("Attach an image in the `image` field");
  res.status(201).json({ data: { url: await saveImage(req.file, "landing") } });
}
