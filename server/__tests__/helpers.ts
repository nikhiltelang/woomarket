import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { vi } from "vitest";
import type { Channel, User } from "@shared/schema";
import { ALL_PERMISSIONS } from "@shared/roles";
import { usersRepository } from "../repositories/users.repository";
import { activityRepository } from "../repositories/activity.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { systemConfig } from "../services/system-config.service";
import { requestLogsRepository } from "../repositories/request-logs.repository";
import type { PublicConfig } from "@shared/platform";
import type { SystemConfig } from "@shared/schema";

export const PASSWORD = "Passw0rd!";
const HASH = bcrypt.hashSync(PASSWORD, 4);

export function makeUser(overrides: Partial<User> = {}): User {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    username: `user_${id.slice(0, 6)}`,
    password: HASH,
    email: `${id.slice(0, 6)}@example.test`,
    firstName: null,
    lastName: null,
    role: "admin",
    avatar: null,
    status: "active",
    permissions: [...ALL_PERMISSIONS],
    channelId: null,
    lastLogin: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    fcmToken: null,
    phone: null,
    isEmailVerified: true,
    isMobileVerified: false,
    stripeCustomerId: null,
    razorpayCustomerId: null,
    paypalCustomerId: null,
    paystackCustomerCode: null,
    mercadopagoCustomerId: null,
    accessLevel: null,
    ...overrides,
  };
}

export function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: randomUUID(),
    name: "Test channel",
    phoneNumberId: "123456789",
    accessToken: "simulator",
    whatsappBusinessAccountId: "987654321",
    phoneNumber: "+15550000000",
    appId: null,
    isActive: true,
    isCoexistence: false,
    healthStatus: "healthy",
    lastHealthCheck: null,
    healthDetails: {},
    connectionMethod: "simulator",
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: "",
    ...overrides,
  };
}

export function makeSystemConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    id: "default",
    siteTitle: "Test",
    timezone: "UTC",
    currency: "USD",
    currencySymbol: "$",
    siteBaseColor: "#16a34a",
    recordsPerPage: 20,
    currencyDisplayMode: "both",
    homeDefaultService: null,
    referralCommission: 10,
    logo: null,
    favicon: null,
    userRegistration: true,
    forceSsl: false,
    agreePolicy: false,
    forceSecurePassword: true,
    kycVerification: false,
    emailVerification: false,
    emailNotification: true,
    mobileVerification: false,
    smsNotification: true,
    pushNotification: true,
    postAutoApproval: true,
    languageOption: true,
    globalEmailTemplate: null,
    globalSmsTemplate: null,
    globalPushTemplate: null,
    smtpSettings: {},
    smsSettings: {},
    pushSettings: {},
    seoSettings: {},
    frontendSettings: {},
    extensionSettings: {},
    requestLogSettings: {},
    maintenanceMode: { enabled: false, title: "Maintenance", content: "Back soon", bypassSecret: "" },
    gdprCookie: { enabled: false, bannerText: "", acceptButtonText: "OK", declineButtonText: "No", policyUrl: "", cookieLifespanDays: 365 },
    customCss: "",
    robotsTxt: null,
    sitemapXml: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Points the cached system configuration at an in-memory value. */
export function mockSystemConfig(overrides: Partial<SystemConfig> = {}) {
  const cfg = makeSystemConfig(overrides);
  vi.spyOn(systemConfig, "get").mockResolvedValue(cfg);
  // Request logs are captured but never written to the (unreachable) test database.
  vi.spyOn(requestLogsRepository, "insertMany").mockResolvedValue();
  vi.spyOn(systemConfig, "public").mockResolvedValue({
    siteTitle: "Test",
    tagline: null,
    baseColor: "#16a34a",
    logo: null,
    favicon: null,
    companyName: null,
    supportEmail: null,
    userRegistration: Boolean(cfg.userRegistration),
    agreePolicy: Boolean(cfg.agreePolicy),
    forceSecurePassword: Boolean(cfg.forceSecurePassword),
    emailVerification: Boolean(cfg.emailVerification),
    languageOption: false,
    googleLogin: false,
    frontend: {},
    gdprCookie: cfg.gdprCookie!,
    customCss: "",
    maintenance: { enabled: Boolean(cfg.maintenanceMode?.enabled), title: cfg.maintenanceMode?.title ?? "", content: cfg.maintenanceMode?.content ?? "" },
    policies: [],
    languages: [],
    recordsPerPage: 20,
    currency: "USD",
    currencySymbol: "$",
  } satisfies PublicConfig);
  return cfg;
}

/** Replaces the user / channel / audit repositories with in-memory fakes. */
export function mockDirectory(users: User[], channels: Channel[] = []) {
  vi.spyOn(usersRepository, "findById").mockImplementation(async (id) => users.find((u) => u.id === id));
  vi.spyOn(usersRepository, "findByLogin").mockImplementation(async (l) => users.find((u) => u.username === l || u.email === l));
  vi.spyOn(usersRepository, "touchLastLogin").mockResolvedValue();
  vi.spyOn(activityRepository, "record").mockResolvedValue();
  vi.spyOn(channelsRepository, "findById").mockImplementation(async (id) => channels.find((c) => c.id === id));
  mockSystemConfig();
}

export async function login(app: Express, username: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string, token: res.body.token as string };
}
