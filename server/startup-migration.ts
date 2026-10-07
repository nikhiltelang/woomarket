import { eq, inArray } from "drizzle-orm";
import { panelConfig, users } from "@shared/schema";
import { ALL_PERMISSIONS } from "@shared/roles";
import { db } from "./db";
import { childLogger } from "./lib/logger";
import { seedEmailTemplates } from "./seed";
import { seedPlatformDefaults } from "./seed-platform";
import { DEFAULT_TAGLINE, LEGACY_TAGLINE } from "./repositories/platform.repository";

const log = childLogger("startup-migration");

/**
 * Permissions are never implied by role, so when a release adds permissions the
 * existing tenant admins and superadmins must be granted them explicitly.
 */
export async function backfillAdminPermissions(): Promise<number> {
  const rows = await db.select({ id: users.id, permissions: users.permissions }).from(users).where(inArray(users.role, ["admin", "superadmin"]));
  let updated = 0;
  for (const u of rows) {
    const current = u.permissions ?? [];
    const missing = ALL_PERMISSIONS.filter((p) => !current.includes(p));
    if (!missing.length) continue;
    await db
      .update(users)
      .set({ permissions: [...current, ...missing] })
      .where(inArray(users.id, [u.id]));
    updated++;
  }
  if (updated) log.info({ updated }, "Granted new permissions to existing admins");
  return updated;
}

/** The old default tagline presented the product as WhatsApp-only; swap it if it was never customised. */
export async function refreshDefaultTagline(): Promise<void> {
  const [res] = await db.update(panelConfig).set({ tagline: DEFAULT_TAGLINE }).where(eq(panelConfig.tagline, LEGACY_TAGLINE));
  if (res.affectedRows) log.info("Updated the default tagline");
}

/** Idempotent data fixes that run on every boot (after migrations). */
export async function runStartupMigrations(): Promise<void> {
  await backfillAdminPermissions();
  await refreshDefaultTagline();
  await seedEmailTemplates();
  await seedPlatformDefaults();
}
