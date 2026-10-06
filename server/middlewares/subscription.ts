import type { NextFunction, Request, Response } from "express";
import { asyncHandler } from "../lib/http";
import { forbidden, unauthorized } from "../lib/errors";
import { billingRepository } from "../repositories/billing.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { usersRepository } from "../repositories/users.repository";

type Feature = "channel" | "contacts" | "team" | "campaign" | "email" | "sms";

const usage: Record<Feature, (tenantId: string) => Promise<number>> = {
  channel: (t) => channelsRepository.countByTenant(t),
  contacts: (t) => contactsRepository.countByTenant(t),
  team: (t) => usersRepository.countTeamMembers(t),
  // Feature flags only (0 = not included in the plan); no usage counter.
  campaign: async () => 0,
  email: async () => 0,
  sms: async () => 0,
};

/** Checks the tenant's active plan includes `feature` and the current usage is under its limit. */
export async function assertWithinPlan(tenantId: string, feature: Feature, adding = 1): Promise<void> {
  const sub = await billingRepository.activeSubscription(tenantId);
  if (!sub) throw forbidden("Your account has no active subscription. Choose a plan to continue.", "NO_SUBSCRIPTION");
  const limit = sub.planData?.permissions?.[feature];
  if (limit === undefined || limit === -1) return;
  if (limit === 0) throw forbidden(`Your plan (${sub.planData.name}) does not include this feature.`, "PLAN_FEATURE");
  const used = await usage[feature](tenantId);
  if (used + adding > limit) {
    const noun = { channel: "WhatsApp number", contacts: "contact", team: "team member", campaign: "campaign", email: "email campaign", sms: "SMS campaign" }[feature];
    throw forbidden(
      `Plan limit reached: ${sub.planData.name} allows ${limit} ${noun}${limit === 1 ? "" : "s"}. Upgrade to add more.`,
      "PLAN_LIMIT",
    );
  }
}

export function requireSubscription(feature: Feature) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (req.user.role === "superadmin") return next();
    await assertWithinPlan(req.user.tenantId!, feature);
    next();
  });
}
