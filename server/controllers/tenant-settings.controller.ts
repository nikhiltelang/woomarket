import type { Request, Response } from "express";
import { sendingPreferencesSchema } from "@shared/sending";
import { parseBody } from "../lib/http";
import { requireTenantId } from "../middlewares/tenant";
import { activityRepository } from "../repositories/activity.repository";
import { tenantSettingsRepository } from "../services/delivery.service";

/** GET /api/settings/sending — time zone, quiet hours and best-time default. */
export async function getSending(req: Request, res: Response) {
  res.json({ data: await tenantSettingsRepository.getSending(requireTenantId(req.user)) });
}

export async function saveSending(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const prefs = parseBody(sendingPreferencesSchema, req);
  await tenantSettingsRepository.saveSending(tenantId, prefs);
  await activityRepository.record(req, req.user!.id, "sending_preferences_saved", { type: "tenant_settings", id: tenantId }, { quietHours: prefs.quietHours.enabled });
  res.json({ data: prefs });
}
