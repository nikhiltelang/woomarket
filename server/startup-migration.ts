import { inArray } from "drizzle-orm";
import { users } from "@shared/schema";
import { ALL_PERMISSIONS } from "@shared/roles";
import { db } from "./db";
import { childLogger } from "./lib/logger";
import { seedEmailTemplates } from "./seed";
import { seedPlatformDefaults } from "./seed-platform";

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

/** Idempotent data fixes that run on every boot (after migrations). */
export async function runStartupMigrations(): Promise<void> {
  await backfillAdminPermissions();
  await seedEmailTemplates();
  await seedPlatformDefaults();
}
