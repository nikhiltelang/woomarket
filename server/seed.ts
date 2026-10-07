import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { ALL_PERMISSIONS, DEFAULT_TEAM_PERMISSIONS } from "@shared/roles";
import { config } from "./config";
import { logger } from "./lib/logger";
import { usersRepository } from "./repositories/users.repository";
import { billingRepository } from "./repositories/billing.repository";
import { channelsRepository } from "./repositories/channels.repository";
import { contactsRepository } from "./repositories/contacts.repository";
import { groupsRepository } from "./repositories/groups.repository";
import { countTemplateVariables, templatesRepository } from "./repositories/templates.repository";
import { emailTemplatesRepository } from "./repositories/email.repository";
import { seedPlatformDefaults } from "./seed-platform";

const log = logger.child({ module: "seed" });

const PLANS = [
  {
    name: "Free",
    description: "Get started with one WhatsApp number.",
    monthlyPrice: "0.00",
    annualPrice: "0.00",
    permissions: { channel: 1, contacts: 500, team: 1, campaign: 5 },
    features: ["WhatsApp, email & SMS campaigns", "1 WhatsApp number", "500 contacts", "Shared team inbox"],
  },
  {
    name: "Pro",
    description: "For growing teams running regular campaigns.",
    monthlyPrice: "49.00",
    annualPrice: "490.00",
    popular: true,
    permissions: { channel: 3, contacts: 25000, team: 10, campaign: -1 },
    features: ["Unlimited WhatsApp, email & SMS campaigns", "3 WhatsApp numbers", "25,000 contacts", "10 team members"],
  },
  {
    name: "Enterprise",
    description: "Unlimited scale with priority support.",
    monthlyPrice: "199.00",
    annualPrice: "1990.00",
    permissions: { channel: -1, contacts: -1, team: -1, campaign: -1 },
    features: ["Unlimited numbers", "Unlimited contacts", "Unlimited team", "Priority support"],
  },
];

const shell = (inner: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
${inner}
<tr><td style="padding:16px 32px;background:#f9fafb;font-size:12px;color:#6b7280;text-align:center">You're receiving this because you're a customer of ours. <a href="{{unsubscribe_url}}" style="color:#6b7280">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;

const EMAIL_TEMPLATES = [
  {
    name: "Promotion",
    category: "promotional",
    subject: "{{first_name}}, 20% off ends Sunday",
    previewText: "Our biggest sale of the season is here.",
    contentHtml: shell(`<tr><td style="background:#15803d;padding:32px;text-align:center;color:#ffffff"><h1 style="margin:0;font-size:28px">Summer Sale</h1><p style="margin:8px 0 0;font-size:16px">20% off everything until Sunday</p></td></tr>
<tr><td style="padding:32px;font-size:16px;line-height:1.6">Hi {{first_name}},<br><br>As one of our valued customers you get early access to our biggest sale of the season. Use code <strong>SUMMER20</strong> at checkout.<br><br>
<a href="https://example.com/sale" style="display:inline-block;background:#15803d;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold">Shop the sale</a></td></tr>`),
  },
  {
    name: "Newsletter",
    category: "newsletter",
    subject: "What's new this month",
    previewText: "Product updates, tips and stories from our team.",
    contentHtml: shell(`<tr><td style="padding:32px 32px 8px"><h1 style="margin:0;font-size:24px">This month at our store</h1></td></tr>
<tr><td style="padding:8px 32px 32px;font-size:16px;line-height:1.6">Hi {{first_name}},<br><br><strong>New arrivals.</strong> Our autumn collection just landed — see what's new.<br><br><strong>Tip of the month.</strong> Reply to any of our WhatsApp messages to reach a real person in minutes.<br><br><strong>Community.</strong> Thank you for being part of it. See you next month!</td></tr>`),
  },
  {
    name: "Welcome",
    category: "transactional",
    subject: "Welcome aboard, {{first_name}}!",
    previewText: "Here's how to get the most out of your account.",
    contentHtml: shell(`<tr><td style="padding:32px;font-size:16px;line-height:1.6"><h1 style="margin:0 0 16px;font-size:24px">Welcome, {{first_name}}!</h1>Thanks for joining us. Here are three things to try first:<ol><li>Complete your profile</li><li>Message us on WhatsApp any time</li><li>Watch your inbox for member-only offers</li></ol></td></tr>`),
  },
];

/** System email templates available to every tenant. Idempotent. */
export async function seedEmailTemplates(): Promise<void> {
  for (const t of EMAIL_TEMPLATES) {
    if (!(await emailTemplatesRepository.findSystemByName(t.name))) {
      await emailTemplatesRepository.create({ ...t, userId: null, isSystem: true });
    }
  }
}

/** Inserts initial data. Never modifies existing accounts. Safe to run repeatedly. */
export interface SeedOptions {
  /** Superadmin chosen in the installer; without it a default "superadmin" account is created. */
  superadmin?: { username: string; email: string; password: string; firstName?: string; lastName?: string };
  /** Demo tenant with sample data (default: outside production only). */
  demo?: boolean;
}

/** Creates or updates the installer's superadmin. Fails if the username belongs to a non-superadmin. */
export async function upsertSuperadmin(a: NonNullable<SeedOptions["superadmin"]>): Promise<void> {
  const hash = await bcrypt.hash(a.password, 12);
  const existing = (await usersRepository.findByLogin(a.username)) ?? (await usersRepository.findByLogin(a.email));
  if (existing && existing.role !== "superadmin") throw new Error(`The username or email "${existing.username}" already belongs to a non-admin account in this database.`);
  const values = { username: a.username, email: a.email, password: hash, firstName: a.firstName || null, lastName: a.lastName || null, role: "superadmin" as const, status: "active", permissions: [...ALL_PERMISSIONS], isEmailVerified: true };
  if (existing) await usersRepository.update(existing.id, values);
  else await usersRepository.create(values);
  log.info({ username: a.username }, existing ? "Superadmin account updated" : "Superadmin account created");
}

export async function runSeed(opts: SeedOptions = {}): Promise<void> {
  for (const p of PLANS) {
    if (!(await billingRepository.findPlanByName(p.name))) {
      await billingRepository.createPlan(p);
      log.info({ plan: p.name }, "Plan created");
    }
  }

  if (opts.superadmin) {
    await upsertSuperadmin(opts.superadmin);
  } else if (!(await usersRepository.findByLogin("superadmin"))) {
    let password = config.SEED_SUPERADMIN_PASSWORD;
    let generated = false;
    if (!password) {
      if (config.isProduction) {
        password = crypto.randomBytes(12).toString("base64url");
        generated = true;
      } else {
        password = "Superadmin@123";
      }
    }
    await usersRepository.create({
      username: "superadmin",
      email: "superadmin@woomarket360.local",
      password: await bcrypt.hash(password, 12),
      firstName: "Platform",
      lastName: "Owner",
      role: "superadmin",
      status: "active",
      permissions: [...ALL_PERMISSIONS],
      isEmailVerified: true,
    });
    if (generated) {
      // Printed once; not logged through the structured logger to keep it out of log shipping.
      // eslint-disable-next-line no-console
      console.log(`\n  Superadmin created. Username: superadmin  Password: ${password}\n  Store it now; it will not be shown again.\n`);
    } else {
      log.info("Superadmin account created (username: superadmin)");
    }
  }

  await seedEmailTemplates();
  await seedPlatformDefaults();
  if (opts.demo ?? !config.isProduction) await seedDemoTenant();
}

/** Development-only demo tenant with a simulator channel, contacts and an approved template. */
async function seedDemoTenant() {
  if (await usersRepository.findByLogin("demo")) return;
  const admin = await usersRepository.create({
    username: "demo",
    email: "demo@woomarket360.local",
    password: await bcrypt.hash("Demo@1234", 12),
    firstName: "Demo",
    lastName: "Admin",
    role: "admin",
    status: "active",
    permissions: [...ALL_PERMISSIONS],
    isEmailVerified: true,
    accessLevel: 3,
  });
  const pro = await billingRepository.findPlanByName("Pro");
  if (pro) await billingRepository.assign(admin.id, pro, "annual");

  await usersRepository.create({
    username: "agent",
    email: "agent@woomarket360.local",
    password: await bcrypt.hash("Agent@1234", 12),
    firstName: "Alex",
    lastName: "Agent",
    role: "team",
    status: "active",
    permissions: [...DEFAULT_TEAM_PERMISSIONS, "inbox:assign"],
    createdBy: admin.id,
    isEmailVerified: true,
  });

  const channel = await channelsRepository.create({
    name: "Demo (simulator)",
    phoneNumberId: `9${Date.now()}`,
    whatsappBusinessAccountId: "sim-demo",
    accessToken: "simulator",
    phoneNumber: "+15550001111",
    connectionMethod: "simulator",
    createdBy: admin.id,
    healthStatus: "healthy",
  });

  const vip = await groupsRepository.create({ name: "VIP customers", description: "High-value repeat buyers", channelId: channel.id, createdBy: admin.id });
  const people = [
    ["Priya Sharma", "+919812345601", "priya@example.test"],
    ["Liam Johnson", "+14155550102", "liam@example.test"],
    ["Sofia Rossi", "+393401234503", "sofia@example.test"],
    ["Kenji Tanaka", "+819012345604", null],
    ["Amara Okafor", "+2348031234505", "amara@example.test"],
    ["Undeliverable Test", "+15555550000", null],
  ];
  await contactsRepository.insertManyIgnoreDuplicates(
    people.map(([name, phone, email], i) => ({
      channelId: channel.id,
      tenantId: admin.id,
      name: name!,
      phone: phone!,
      email,
      groups: i < 3 ? [vip.id] : [],
      tags: i < 3 ? ["vip"] : [],
      source: "seed",
      createdBy: admin.id,
    })),
  );

  const body = "Hi {{1}}, our summer sale starts today — 20% off everything for you. Reply STOP to opt out.";
  await templatesRepository.create({
    channelId: channel.id,
    createdBy: admin.id,
    name: "summer_sale",
    category: "MARKETING",
    language: "en_US",
    header: "Summer Sale",
    headerType: "text",
    body,
    footer: "WooMarket360 Demo",
    buttons: [{ type: "QUICK_REPLY", text: "Shop now" }],
    bodyVariables: countTemplateVariables(body),
    status: "approved",
    whatsappTemplateId: "sim_demo_summer_sale",
  });
  log.info("Demo tenant created (demo / Demo@1234, agent / Agent@1234)");
}
