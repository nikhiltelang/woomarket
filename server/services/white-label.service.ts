/**
 * White-label: agencies give the platform their own name, look and domains. On a verified
 * brand domain, sign-in and sign-up are branded and limited to the agency and its clients;
 * new sign-ups there become the agency's clients (users.reseller_id).
 */
import crypto from "node:crypto";
import dns from "node:dns";
import type { NextFunction, Request, Response } from "express";
import { and, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { verificationRecord, type PublicBrand } from "@shared/white-label";
import { brandDomains, brands, users, type Brand, type BrandDomain, type User } from "@shared/schema";
import { db } from "../db";
import { forbidden } from "../lib/errors";
import { publicBaseUrl } from "../lib/tokens";
import { tenantLevel } from "./levels.service";
import { usersRepository } from "../repositories/users.repository";

export const brandsRepository = {
  async byOwner(ownerId: string): Promise<Brand | undefined> {
    const [row] = await db.select().from(brands).where(eq(brands.ownerId, ownerId)).limit(1);
    return row;
  },
  async byId(id: string): Promise<Brand | undefined> {
    const [row] = await db.select().from(brands).where(eq(brands.id, id)).limit(1);
    return row;
  },
  async upsert(ownerId: string, values: Omit<typeof brands.$inferInsert, "id" | "ownerId">): Promise<Brand> {
    const existing = await this.byOwner(ownerId);
    if (existing) await db.update(brands).set(values).where(eq(brands.id, existing.id));
    else await db.insert(brands).values({ ...values, ownerId, id: crypto.randomUUID() });
    forgetBrandCache();
    return (await this.byOwner(ownerId))!;
  },
  domains(brandId: string) {
    return db.select().from(brandDomains).where(eq(brandDomains.brandId, brandId)).orderBy(desc(brandDomains.createdAt));
  },
  async domain(id: string): Promise<BrandDomain | undefined> {
    const [row] = await db.select().from(brandDomains).where(eq(brandDomains.id, id)).limit(1);
    return row;
  },
  async domainByName(domain: string): Promise<BrandDomain | undefined> {
    const [row] = await db.select().from(brandDomains).where(eq(brandDomains.domain, domain)).limit(1);
    return row;
  },
  async addDomain(brandId: string, domain: string): Promise<BrandDomain> {
    const id = crypto.randomUUID();
    await db.insert(brandDomains).values({ id, brandId, domain, verificationToken: crypto.randomBytes(16).toString("hex") });
    return (await this.domain(id))!;
  },
  async updateDomain(id: string, patch: Partial<typeof brandDomains.$inferInsert>) {
    await db.update(brandDomains).set(patch).where(eq(brandDomains.id, id));
    forgetBrandCache();
    return this.domain(id);
  },
  async deleteDomain(id: string) {
    await db.delete(brandDomains).where(eq(brandDomains.id, id));
    forgetBrandCache();
  },
  clients(ownerId: string) {
    return db
      .select({ id: users.id, username: users.username, email: users.email, firstName: users.firstName, lastName: users.lastName, status: users.status, createdAt: users.createdAt, lastLogin: users.lastLogin })
      .from(users)
      .where(and(eq(users.resellerId, ownerId), eq(users.role, "admin")))
      .orderBy(desc(users.createdAt));
  },
  async clientCounts(ownerIds: string[]): Promise<Map<string, number>> {
    if (!ownerIds.length) return new Map();
    const rows = await db.select({ owner: users.resellerId, n: count() }).from(users).where(and(inArray(users.resellerId, ownerIds), isNotNull(users.resellerId))).groupBy(users.resellerId);
    return new Map(rows.map((r) => [r.owner!, r.n]));
  },
  all() {
    return db.select().from(brands).orderBy(desc(brands.createdAt));
  },
};

// ---------------------------------------------------------------------------
// Host → brand
// ---------------------------------------------------------------------------

const hostCache = new Map<string, { brand: Brand | null; at: number }>();
const forgetBrandCache = () => hostCache.clear();
export { forgetBrandCache };

/** The platform's own host (never a brand domain). */
export const platformHost = () => new URL(publicBaseUrl()).hostname.toLowerCase();

/** Verified, enabled brand for a request host (cached for a minute). */
export async function brandForHost(host: string | undefined): Promise<Brand | null> {
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!h || h === platformHost() || h === "localhost" || /^\d+(\.\d+){3}$/.test(h)) return null;
  const hit = hostCache.get(h);
  if (hit && Date.now() - hit.at < 60_000) return hit.brand;
  const d = await brandsRepository.domainByName(h);
  const brand = d && d.verifiedAt && !d.disabled ? ((await brandsRepository.byId(d.brandId)) ?? null) : null;
  hostCache.set(h, { brand, at: Date.now() });
  if (hostCache.size > 10_000) hostCache.clear();
  return brand;
}

/** Sets req.brand when the request arrived on a brand domain. */
export async function resolveBrand(req: Request, _res: Response, next: NextFunction) {
  try {
    req.brand = (await brandForHost(req.hostname)) ?? undefined;
    next();
  } catch (err) {
    next(err);
  }
}

/** The agency a user belongs to: their own brand, their reseller's, or their admin's reseller's. */
export async function agencyOf(user: Pick<User, "id" | "role" | "createdBy" | "resellerId">): Promise<string | null> {
  if (user.role === "superadmin") return null;
  if (user.resellerId) return user.resellerId;
  if (user.role === "team" && user.createdBy) {
    const admin = await usersRepository.findById(user.createdBy);
    if (admin?.resellerId) return admin.resellerId;
    if (admin && (await brandsRepository.byOwner(admin.id))) return admin.id;
    return null;
  }
  return (await brandsRepository.byOwner(user.id)) ? user.id : null;
}

/** On a brand domain, only the agency, its clients and their teams may sign in. */
export async function assertMaySignInHere(req: Request, user: User): Promise<void> {
  const brand = req.brand;
  if (!brand) return;
  if (user.role === "superadmin" || (await agencyOf(user)) !== brand.ownerId) {
    throw forbidden(`This account can't sign in on ${brand.name}. Use the address you signed up on.`, "WRONG_BRAND");
  }
}

export function toPublicBrand(b: Brand, platformName: string, onBrandDomain: boolean): PublicBrand {
  return {
    name: b.name,
    logo: b.logo,
    favicon: b.favicon,
    baseColor: b.baseColor,
    supportEmail: b.supportEmail,
    supportUrl: b.supportUrl,
    loginTitle: b.loginTitle,
    loginSubtitle: b.loginSubtitle,
    allowSignup: b.allowSignup,
    poweredBy: b.hidePoweredBy ? null : platformName,
    onBrandDomain,
  };
}

/** Whether a tenant may use white-label (an admin whose level allows it, not someone else's client). */
export async function whiteLabelAllowed(user: Pick<User, "id" | "role" | "resellerId">): Promise<boolean> {
  if (user.role !== "admin" || user.resellerId) return false;
  const level = await tenantLevel(user.id);
  return Boolean(level?.whiteLabel);
}

// ---------------------------------------------------------------------------
// Domain verification
// ---------------------------------------------------------------------------

/** Overridable in tests. */
export const dnsLookup = { txt: (name: string) => dns.promises.resolveTxt(name) };

export async function verifyDomain(d: BrandDomain): Promise<{ ok: boolean; error: string | null }> {
  const record = verificationRecord(d.domain, d.verificationToken);
  let error: string | null = null;
  try {
    const txt = (await dnsLookup.txt(record.name)).map((parts) => parts.join(""));
    if (!txt.includes(record.value)) error = txt.length ? "The TXT record was found but its value doesn't match." : "The TXT record has no value yet.";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    error = code === "ENOTFOUND" || code === "ENODATA" ? `No TXT record at ${record.name} yet. DNS changes can take up to an hour.` : `DNS lookup failed (${code ?? "error"}). Try again shortly.`;
  }
  await brandsRepository.updateDomain(d.id, { lastCheckedAt: new Date(), lastError: error, ...(error ? {} : { verifiedAt: d.verifiedAt ?? new Date() }) });
  return { ok: !error, error };
}
