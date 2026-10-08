import type { Request, Response } from "express";
import { z } from "zod";
import { brandSchema, domainSchema, verificationRecord } from "@shared/white-label";
import type { Brand, BrandDomain } from "@shared/schema";
import { parse, parseBody } from "../lib/http";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { removeUpload, saveImage } from "../lib/uploads";
import { usersRepository } from "../repositories/users.repository";
import { activityRepository } from "../repositories/activity.repository";
import { brandsRepository, forgetBrandCache, platformHost, verifyDomain, whiteLabelAllowed } from "../services/white-label.service";

const MAX_DOMAINS = 5;

async function agency(req: Request) {
  const user = await usersRepository.findById(req.user!.id);
  if (!user || !(await whiteLabelAllowed(user))) throw forbidden("White-label isn't included in your plan. Contact the platform administrator.", "WHITE_LABEL_NOT_ALLOWED");
  return user;
}

const domainView = (d: BrandDomain) => ({
  id: d.id,
  domain: d.domain,
  verified: Boolean(d.verifiedAt),
  verifiedAt: d.verifiedAt,
  disabled: d.disabled,
  lastCheckedAt: d.lastCheckedAt,
  lastError: d.lastError,
  records: [{ type: "CNAME", name: d.domain, value: platformHost() }, verificationRecord(d.domain, d.verificationToken)],
});

/** GET /api/white-label */
export async function get(req: Request, res: Response) {
  const user = await usersRepository.findById(req.user!.id);
  const allowed = user ? await whiteLabelAllowed(user) : false;
  if (!allowed) return res.json({ data: { allowed: false, brand: null, domains: [], clients: 0 } });
  const brand = await brandsRepository.byOwner(user!.id);
  const domains = brand ? await brandsRepository.domains(brand.id) : [];
  const clients = (await brandsRepository.clientCounts([user!.id])).get(user!.id) ?? 0;
  res.json({ data: { allowed: true, brand: brand ?? null, domains: domains.map(domainView), clients, platformHost: platformHost() } });
}

/** PUT /api/white-label (multipart: fields + optional logo / favicon files, or removeLogo / removeFavicon) */
export async function saveBrand(req: Request, res: Response) {
  const user = await agency(req);
  const body = { ...req.body, hidePoweredBy: req.body.hidePoweredBy === "true" || req.body.hidePoweredBy === true, allowSignup: req.body.allowSignup !== "false" && req.body.allowSignup !== false };
  const input = parse(brandSchema, body);
  const existing = await brandsRepository.byOwner(user.id);
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const images: Partial<Pick<Brand, "logo" | "favicon">> = {};
  for (const field of ["logo", "favicon"] as const) {
    const file = files[field]?.[0];
    if (file) {
      images[field] = await saveImage(file, "brands");
      await removeUpload(existing?.[field]);
    } else if (req.body[`remove${field[0].toUpperCase()}${field.slice(1)}`] === "true") {
      images[field] = null;
      await removeUpload(existing?.[field]);
    }
  }
  const brand = await brandsRepository.upsert(user.id, { ...input, ...images });
  await activityRepository.record(req, req.user!.id, "brand_saved", { type: "brand", id: brand.id });
  res.json({ data: brand });
}

async function ownDomain(req: Request) {
  const user = await agency(req);
  const brand = await brandsRepository.byOwner(user.id);
  const d = brand ? await brandsRepository.domain(req.params.id) : undefined;
  if (!brand || !d || d.brandId !== brand.id) throw notFound("Domain");
  return d;
}

/** POST /api/white-label/domains { domain } */
export async function addDomain(req: Request, res: Response) {
  const user = await agency(req);
  const brand = await brandsRepository.byOwner(user.id);
  if (!brand) throw badRequest("Save your brand first.");
  const { domain } = parseBody(domainSchema, req);
  const own = platformHost();
  if (domain === own || domain.endsWith(`.${own}`) || own.endsWith(`.${domain}`)) throw badRequest("Use your own domain, not the platform's.");
  if ((await brandsRepository.domains(brand.id)).length >= MAX_DOMAINS) throw conflict(`You can add up to ${MAX_DOMAINS} domains.`, "LIMIT_REACHED");
  if (await brandsRepository.domainByName(domain)) throw conflict("That domain is already connected to an account.", "DOMAIN_TAKEN");
  const d = await brandsRepository.addDomain(brand.id, domain);
  await activityRepository.record(req, req.user!.id, "brand_domain_added", { type: "brand_domain", id: d.id }, { domain });
  res.status(201).json({ data: domainView(d) });
}

/** POST /api/white-label/domains/:id/verify */
export async function verify(req: Request, res: Response) {
  const d = await ownDomain(req);
  const result = await verifyDomain(d);
  res.json({ data: { ...domainView((await brandsRepository.domain(d.id))!), ...result } });
}

export async function removeDomain(req: Request, res: Response) {
  const d = await ownDomain(req);
  await brandsRepository.deleteDomain(d.id);
  await activityRepository.record(req, req.user!.id, "brand_domain_removed", { type: "brand_domain", id: d.id }, { domain: d.domain });
  res.json({ success: true });
}

/** GET /api/white-label/clients */
export async function clients(req: Request, res: Response) {
  const user = await agency(req);
  res.json({ data: await brandsRepository.clients(user.id) });
}

/**
 * GET /api/white-label/tls-check?domain=… — for a reverse proxy issuing certificates on demand
 * (Caddy "on_demand_tls ask"): 200 only for verified, enabled brand domains.
 */
export async function tlsCheck(req: Request, res: Response) {
  const { domain } = parse(z.object({ domain: z.string().trim().toLowerCase().max(253) }), req.query);
  const d = await brandsRepository.domainByName(domain);
  if (domain === platformHost() || (d && d.verifiedAt && !d.disabled)) return res.sendStatus(200);
  res.sendStatus(404);
}

// --- Superadmin -----------------------------------------------------------------

export async function adminList(_req: Request, res: Response) {
  const all = await brandsRepository.all();
  const counts = await brandsRepository.clientCounts(all.map((b) => b.ownerId));
  const rows = await Promise.all(
    all.map(async (b) => {
      const owner = await usersRepository.findById(b.ownerId);
      return { ...b, owner: owner ? { id: owner.id, username: owner.username, email: owner.email } : null, clients: counts.get(b.ownerId) ?? 0, domains: (await brandsRepository.domains(b.id)).map(domainView) };
    }),
  );
  res.json({ data: rows });
}

/** PUT /api/admin/white-label/domains/:id { disabled } */
export async function adminSetDomain(req: Request, res: Response) {
  const d = await brandsRepository.domain(req.params.id);
  if (!d) throw notFound("Domain");
  const { disabled } = parseBody(z.object({ disabled: z.boolean() }), req);
  await brandsRepository.updateDomain(d.id, { disabled });
  forgetBrandCache();
  await activityRepository.record(req, req.user!.id, disabled ? "brand_domain_disabled" : "brand_domain_enabled", { type: "brand_domain", id: d.id }, { domain: d.domain });
  res.json({ success: true });
}
