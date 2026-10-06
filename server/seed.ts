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

const log = logger.child({ module: "seed" });

const PLANS = [
  {
    name: "Free",
    description: "Get started with one WhatsApp number.",
    monthlyPrice: "0.00",
    annualPrice: "0.00",
    permissions: { channel: 1, contacts: 500, team: 1, campaign: 5 },
    features: ["1 WhatsApp number", "500 contacts", "Shared team inbox", "Basic campaigns"],
  },
  {
    name: "Pro",
    description: "For growing teams running regular campaigns.",
    monthlyPrice: "49.00",
    annualPrice: "490.00",
    popular: true,
    permissions: { channel: 3, contacts: 25000, team: 10, campaign: -1 },
    features: ["3 WhatsApp numbers", "25,000 contacts", "10 team members", "Unlimited campaigns"],
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

/** Inserts initial data. Never modifies existing accounts. Safe to run repeatedly. */
export async function runSeed(): Promise<void> {
  for (const p of PLANS) {
    if (!(await billingRepository.findPlanByName(p.name))) {
      await billingRepository.createPlan(p);
      log.info({ plan: p.name }, "Plan created");
    }
  }

  if (!(await usersRepository.findByLogin("superadmin"))) {
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

  if (!config.isProduction) await seedDemoTenant();
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
    ["Priya Sharma", "+919812345601"],
    ["Liam Johnson", "+14155550102"],
    ["Sofia Rossi", "+393401234503"],
    ["Kenji Tanaka", "+819012345604"],
    ["Amara Okafor", "+2348031234505"],
    ["Undeliverable Test", "+15555550000"],
  ];
  await contactsRepository.insertManyIgnoreDuplicates(
    people.map(([name, phone], i) => ({
      channelId: channel.id,
      tenantId: admin.id,
      name,
      phone,
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
