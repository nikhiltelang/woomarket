/** Request validation schemas shared by the API and the React forms. */
import { z } from "zod";
import { emailDesignSchema } from "./email-design";
import { ALL_PERMISSIONS } from "./roles";
import { contactFieldsSchema } from "./contact-fields";
import { utmSchema } from "./tracking";
import { deliverySchema } from "./sending";
import { emailAbSchema, smsAbSchema, whatsappAbSchema } from "./ab-test";

const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ""))
  .pipe(z.string().regex(/^\+?[1-9]\d{6,14}$/, "Enter a phone number in international format, e.g. +14155550123"));

const password = z
  .string()
  .min(8, "At least 8 characters")
  .max(128)
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/\d/, "Include a number");

const username = z
  .string()
  .trim()
  .min(3, "At least 3 characters")
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "Letters, numbers, dot, dash and underscore only");

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(200).optional(),
});

// --- Auth -----------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Required").max(255),
  password: z.string().min(1, "Required").max(128),
});

/** Strength rules are applied server-side when "force secure password" is enabled. */
export const signupSchema = z.object({
  username,
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(6, "At least 6 characters").max(128),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  acceptTerms: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});

export const updateProfileSchema = z.object({
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: z.string().trim().max(30).nullish(),
});

// --- Users / team -----------------------------------------------------------

const permissionList = z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(ALL_PERMISSIONS.length);

export const createTeamMemberSchema = z.object({
  username,
  email: z.string().trim().toLowerCase().email(),
  password,
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  permissions: permissionList.optional(),
});

export const updateTeamMemberSchema = z.object({
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: z.string().trim().max(30).nullish(),
});

export const updatePermissionsSchema = z.object({ permissions: permissionList });
export const updateStatusSchema = z.object({ status: z.enum(["active", "inactive"]) });
export const setPasswordSchema = z.object({ password });

export const adminCreateUserSchema = createTeamMemberSchema.extend({
  role: z.enum(["admin", "superadmin"]).default("admin"),
});

export const adminUpdateUserSchema = updateTeamMemberSchema.extend({
  role: z.enum(["admin", "superadmin", "team"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  isEmailVerified: z.boolean().optional(),
});

export const bulkStatusSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  status: z.enum(["active", "inactive"]),
});

// --- Channels --------------------------------------------------------------

export const createChannelSchema = z.discriminatedUnion("connectionMethod", [
  z.object({
    connectionMethod: z.literal("manual"),
    name: z.string().trim().min(1).max(100),
    phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "Numeric phone number ID from Meta"),
    whatsappBusinessAccountId: z.string().trim().regex(/^\d{5,30}$/, "Numeric WABA ID from Meta"),
    accessToken: z.string().trim().min(20, "Paste the permanent access token"),
    phoneNumber: z.string().trim().max(30).optional(),
    appId: z.string().trim().max(50).optional(),
  }),
  z.object({
    connectionMethod: z.literal("simulator"),
    name: z.string().trim().min(1).max(100),
    phoneNumber: z.string().trim().max(30).optional(),
  }),
]);

export const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  accessToken: z.string().trim().min(20).optional(),
  isActive: z.boolean().optional(),
  phoneNumber: z.string().trim().max(30).optional(),
});

export const simulateInboundSchema = z.object({
  from: phone,
  name: z.string().trim().max(100).optional(),
  text: z.string().trim().min(1).max(4096),
});

// --- Contacts & groups -------------------------------------------------------

export const contactSchema = z.object({
  name: z.string().trim().min(1, "Required").max(255),
  phone,
  email: z.string().trim().toLowerCase().email().or(z.literal("")).nullish(),
  groups: z.array(z.string().uuid()).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  status: z.enum(["active", "inactive", "blocked", "unsubscribed"]).optional(),
  /** Custom fields, e.g. { "age": "34", "address": "12 High St" }. Replaces the stored set when given. */
  metadata: contactFieldsSchema.optional(),
});

export const updateContactSchema = contactSchema.partial();

export const contactListQuery = paginationQuery.extend({
  channelId: z.string().uuid(),
  groupId: z.string().uuid().optional(),
  status: z.string().max(30).optional(),
});

export const bulkIdsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) });

export const groupSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(1000).nullish(),
});

export const groupContactsSchema = z.object({
  groupId: z.string().uuid(),
  contactIds: z.array(z.string().uuid()).min(1).max(1000),
});

export const moveContactsSchema = z.object({
  fromGroupId: z.string().uuid(),
  toGroupId: z.string().uuid(),
  contactIds: z.array(z.string().uuid()).min(1).max(1000),
});

// --- Templates ---------------------------------------------------------------

export const templateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers and underscores only"),
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
  language: z.string().trim().min(2).max(10).default("en_US"),
  header: z.string().trim().max(60).nullish(),
  body: z.string().trim().min(1).max(1024),
  footer: z.string().trim().max(60).nullish(),
  buttons: z
    .array(
      z.object({
        type: z.enum(["QUICK_REPLY", "URL", "PHONE_NUMBER"]),
        text: z.string().trim().min(1).max(25),
        url: z.string().url().optional(),
        phoneNumber: z.string().max(20).optional(),
      }),
    )
    .max(10)
    .optional(),
});

// --- Inbox -----------------------------------------------------------------

export const conversationListQuery = paginationQuery.extend({
  channelId: z.string().uuid(),
  status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
  assigned: z.enum(["me", "unassigned", "all"]).optional(),
  unread: z.coerce.boolean().optional(),
});

export const updateConversationSchema = z.object({
  assignedTo: z.string().uuid().nullable().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
});

export const conversationStatusSchema = z.object({ status: z.enum(["open", "pending", "resolved", "closed"]) });

export const sendMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(4096) }),
  z.object({
    type: z.literal("template"),
    templateId: z.string().uuid(),
    params: z.array(z.string().max(1024)).max(20).default([]),
  }),
]);

// --- Campaigns ---------------------------------------------------------------

export const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(1000).nullish(),
    templateId: z.string().uuid(),
    audienceType: z.enum(["all", "groups", "contacts", "segment"]),
    segmentId: z.string().uuid().nullish(),
    contactGroups: z.array(z.string().uuid()).max(50).default([]),
    contactIds: z.array(z.string().uuid()).max(10000).default([]),
    /** Template variable number -> "field:name" | "field:phone" | "field:email" | "static:<text>" */
    variableMapping: z.record(z.string().regex(/^\d+$/), z.string().max(500)).default({}),
    scheduledAt: z.coerce.date().nullish(),
    delivery: deliverySchema.nullish(),
    abTest: whatsappAbSchema.nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.audienceType === "groups" && v.contactGroups.length === 0) {
      ctx.addIssue({ code: "custom", path: ["contactGroups"], message: "Select at least one group" });
    }
    if (v.audienceType === "segment" && !v.segmentId) ctx.addIssue({ code: "custom", path: ["segmentId"], message: "Choose a segment" });
    if (v.audienceType === "contacts" && v.contactIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["contactIds"], message: "Select at least one contact" });
    }
    if (v.scheduledAt && v.scheduledAt.getTime() < Date.now() - 60_000) {
      ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "Schedule time must be in the future" });
    }
  });

export const campaignStatusSchema = z.object({ status: z.enum(["paused", "running", "cancelled"]) });

// --- Plans -----------------------------------------------------------------

export const planSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullish(),
  monthlyPrice: z.coerce.number().min(0).max(1_000_000),
  annualPrice: z.coerce.number().min(0).max(10_000_000),
  popular: z.boolean().default(false),
  permissions: z.record(z.string(), z.number().int().min(-1)),
  features: z.array(z.string().max(200)).max(50).default([]),
});

export const assignSubscriptionSchema = z.object({
  userId: z.string().uuid(),
  planId: z.string().uuid(),
  billingCycle: z.enum(["monthly", "annual"]).default("monthly"),
  couponCode: z.string().trim().toUpperCase().max(40).nullish(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type TemplateInput = z.infer<typeof templateSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type CreateTeamMemberInput = z.infer<typeof createTeamMemberSchema>;

// --- Email marketing ----------------------------------------------------------

const optionalEmail = z.string().trim().toLowerCase().email().or(z.literal("")).nullish();

const smtpServerSchema = z.object({
  provider: z.literal("smtp"),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  user: z.string().trim().min(1, "Required").max(255),
  /** Omit to keep the stored password. */
  password: z.string().max(500).optional(),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.string().trim().toLowerCase().email(),
});

/** Regions where Amazon SES sends email (the list in the settings form). */
export const SES_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1",
  "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "me-south-1", "me-central-1", "af-south-1", "il-central-1", "us-gov-west-1",
] as const;

const sesSchema = z.object({
  provider: z.literal("ses"),
  region: z.string().trim().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "Choose an AWS region, e.g. us-east-1"),
  accessKeyId: z.string().trim().regex(/^(AKIA|ASIA)[A-Z0-9]{12,124}$/, "An access key id starts with AKIA"),
  /** Omit to keep the stored secret. */
  secretAccessKey: z.string().trim().min(16).max(256).optional(),
  configurationSet: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "Letters, digits, - and _")
    .or(z.literal(""))
    .optional(),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.string().trim().toLowerCase().email(),
});

/** Email sending settings: an SMTP server or Amazon SES. Requests without `provider` mean SMTP. */
export const smtpConfigSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !("provider" in v) ? { ...v, provider: "smtp" } : v),
  z.discriminatedUnion("provider", [smtpServerSchema, sesSchema]),
);
export type EmailProviderInput = z.infer<typeof smtpConfigSchema>;

export const emailTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  category: z.enum(["promotional", "newsletter", "transactional", "announcement"]).default("promotional"),
  subject: z.string().trim().max(255).nullish(),
  previewText: z.string().trim().max(255).nullish(),
  contentHtml: z.string().min(1).max(500_000),
  contentText: z.string().max(200_000).nullish(),
  design: emailDesignSchema.nullish(),
});

const csvEmailRows = z
  .array(z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().max(255).optional() }))
  .max(50_000);

export const emailCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    subject: z.string().trim().min(1, "Subject is required").max(255),
    previewText: z.string().trim().max(255).nullish(),
    senderName: z.string().trim().min(1).max(100),
    replyTo: optionalEmail,
    contentHtml: z.string().min(1, "Email content is required").max(500_000),
    contentText: z.string().max(200_000).nullish(),
    design: emailDesignSchema.nullish(),
    templateId: z.string().uuid().nullish(),
    targetAudience: z.enum(["all_contacts", "group", "segment", "csv"]),
    targetGroupId: z.string().uuid().nullish(),
    targetSegmentId: z.string().uuid().nullish(),
    csvData: csvEmailRows.default([]),
    scheduledAt: z.coerce.date().nullish(),
    trackClicks: z.boolean().default(true),
    utm: utmSchema.nullish(),
    delivery: deliverySchema.nullish(),
    abTest: emailAbSchema.nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.targetAudience === "group" && !v.targetGroupId) ctx.addIssue({ code: "custom", path: ["targetGroupId"], message: "Choose a group" });
    if (v.targetAudience === "segment" && !v.targetSegmentId) ctx.addIssue({ code: "custom", path: ["targetSegmentId"], message: "Choose a segment" });
    if (v.targetAudience === "csv" && v.csvData.length === 0) ctx.addIssue({ code: "custom", path: ["csvData"], message: "Upload a CSV with an email column" });
    if (v.abTest?.enabled && v.abTest.metric === "click" && !v.trackClicks) ctx.addIssue({ code: "custom", path: ["abTest"], message: "Testing by click rate needs click tracking on" });
    if (v.scheduledAt && v.scheduledAt.getTime() < Date.now() - 60_000) ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "Schedule time must be in the future" });
  });

export const testEmailSchema = z.object({ email: z.string().trim().toLowerCase().email() });

export const marketingStatusSchema = z.object({ status: z.enum(["paused", "sending", "cancelled"]) });

// --- SMS marketing --------------------------------------------------------------

export const smsGatewaySchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("simulator"), fromNumber: z.string().trim().max(30).optional(), senderId: z.string().trim().max(11).optional() }),
  z.object({
    provider: z.literal("twilio"),
    accountSid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, "Twilio Account SID starts with AC"),
    authToken: z.string().trim().min(16).max(128).optional(),
    fromNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "E.164 number, e.g. +14155550123").or(z.literal("")).optional(),
    senderId: z.string().trim().regex(/^[A-Za-z0-9 ]{1,11}$/, "Up to 11 letters/digits").or(z.literal("")).optional(),
  }),
  z.object({
    provider: z.literal("vonage"),
    accountSid: z.string().trim().min(4).max(64),
    authToken: z.string().trim().min(4).max(128).optional(),
    fromNumber: z.string().trim().max(30).optional(),
    senderId: z.string().trim().regex(/^[A-Za-z0-9 ]{1,11}$/, "Up to 11 letters/digits").or(z.literal("")).optional(),
  }),
]);

const csvPhoneRows = z.array(z.object({ phone, name: z.string().trim().max(255).optional() })).max(50_000);

export const smsCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    message: z.string().trim().min(1, "Message is required").max(1600),
    targetAudience: z.enum(["all_contacts", "group", "segment", "csv"]),
    targetGroupId: z.string().uuid().nullish(),
    targetSegmentId: z.string().uuid().nullish(),
    csvData: csvPhoneRows.default([]),
    scheduledAt: z.coerce.date().nullish(),
    trackClicks: z.boolean().default(false),
    utm: utmSchema.nullish(),
    delivery: deliverySchema.nullish(),
    abTest: smsAbSchema.nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.targetAudience === "group" && !v.targetGroupId) ctx.addIssue({ code: "custom", path: ["targetGroupId"], message: "Choose a group" });
    if (v.targetAudience === "segment" && !v.targetSegmentId) ctx.addIssue({ code: "custom", path: ["targetSegmentId"], message: "Choose a segment" });
    if (v.targetAudience === "csv" && v.csvData.length === 0) ctx.addIssue({ code: "custom", path: ["csvData"], message: "Upload a CSV with a phone column" });
    if (v.abTest?.enabled && !v.trackClicks) ctx.addIssue({ code: "custom", path: ["abTest"], message: "SMS A/B tests pick the winner by click rate: turn on link tracking" });
    if (v.scheduledAt && v.scheduledAt.getTime() < Date.now() - 60_000) ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "Schedule time must be in the future" });
  });

export const testSmsSchema = z.object({ to: phone, message: z.string().trim().min(1).max(1600) });
export const segmentsSchema = z.object({ message: z.string().max(5000) });

export type EmailCampaignInput = z.infer<typeof emailCampaignSchema>;
export type SmsCampaignInput = z.infer<typeof smsCampaignSchema>;
