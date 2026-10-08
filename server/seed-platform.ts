import { languagesRepository, levelsRepository, policyRepository, systemConfigRepository, panelRepository } from "./repositories/platform.repository";
import { childLogger } from "./lib/logger";

const log = childLogger("seed");

const LEVELS = [
  { levelNumber: 1, name: "Starter", description: "New accounts.", badgeColor: "gray" as const, maxChannels: 1, maxContacts: 500, maxMessagesMonthly: 1000, maxCampaigns: 5, aiAssistantEnabled: false, smsEnabled: false, emailEnabled: true, prioritySupport: false, apiAccess: false },
  { levelNumber: 2, name: "Growth", description: "Established senders.", badgeColor: "blue" as const, maxChannels: 3, maxContacts: 5000, maxMessagesMonthly: 20000, maxCampaigns: 50, aiAssistantEnabled: true, smsEnabled: true, emailEnabled: true, prioritySupport: false, apiAccess: false },
  { levelNumber: 3, name: "Business", description: "High-volume teams.", badgeColor: "purple" as const, maxChannels: 10, maxContacts: 50000, maxMessagesMonthly: 250000, maxCampaigns: -1, aiAssistantEnabled: true, smsEnabled: true, emailEnabled: true, prioritySupport: true, apiAccess: true },
  { levelNumber: 4, name: "Enterprise", description: "No platform limits.", badgeColor: "amber" as const, maxChannels: -1, maxContacts: -1, maxMessagesMonthly: -1, maxCampaigns: -1, aiAssistantEnabled: true, smsEnabled: true, emailEnabled: true, prioritySupport: true, apiAccess: true, whiteLabel: true },
];

const POLICIES = [
  {
    title: "Terms of Service",
    slug: "terms",
    content: "# Terms of Service\n\nBy creating an account you agree to use the platform lawfully and in line with WhatsApp's Business and Commerce policies.\n\n## Your content\n\nYou are responsible for the messages you send and for having your contacts' consent.\n\n## Changes\n\nWe may update these terms; we'll notify you of material changes.\n\n_Replace this text with your own terms in System settings → Policy pages._",
  },
  {
    title: "Privacy Policy",
    slug: "privacy-policy",
    content: "# Privacy Policy\n\nWe process the personal data you and your contacts provide only to deliver the service.\n\n## What we collect\n\n- Account details (name, email)\n- Contact lists and message history you store\n- Usage and security logs\n\n## Your rights\n\nYou can export or delete your data at any time.\n\n_Replace this text with your own policy in System settings → Policy pages._",
  },
  {
    title: "Cookie Policy",
    slug: "cookie-policy",
    content: "# Cookie Policy\n\nWe use a session cookie to keep you signed in and a security cookie to protect forms. Optional analytics cookies are only set if you accept them.\n\n_Replace this text with your own policy in System settings → Policy pages._",
  },
];

/** Defaults for the platform administration features. Idempotent; never overwrites edits. */
export async function seedPlatformDefaults(): Promise<void> {
  await systemConfigRepository.get();
  await panelRepository.get();
  if ((await levelsRepository.list()).length === 0) {
    for (const l of LEVELS) await levelsRepository.create(l);
    log.info("Access levels created");
  }
  if (!(await languagesRepository.findByCode("en"))) {
    const en = await languagesRepository.create({ code: "en", name: "English", nativeName: "English", icon: "🇬🇧", direction: "ltr", isEnabled: true, isDefault: true, translations: {}, sortOrder: 0 });
    if (!(await languagesRepository.list()).some((l) => l.isDefault && l.id !== en.id)) await languagesRepository.setDefault(en.id);
  }
  for (const p of POLICIES) {
    if (!(await policyRepository.findBySlug(p.slug))) await policyRepository.create({ ...p, isSystem: true, isPublished: true });
  }
}
