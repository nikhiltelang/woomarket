/** Request validation schemas shared by the API and the React forms. */
import { z } from "zod";
import { ALL_PERMISSIONS } from "./roles";

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

export const signupSchema = z.object({
  username,
  email: z.string().trim().toLowerCase().email(),
  password,
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
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
    audienceType: z.enum(["all", "groups", "contacts"]),
    contactGroups: z.array(z.string().uuid()).max(50).default([]),
    contactIds: z.array(z.string().uuid()).max(10000).default([]),
    /** Template variable number -> "field:name" | "field:phone" | "field:email" | "static:<text>" */
    variableMapping: z.record(z.string().regex(/^\d+$/), z.string().max(500)).default({}),
    scheduledAt: z.coerce.date().nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.audienceType === "groups" && v.contactGroups.length === 0) {
      ctx.addIssue({ code: "custom", path: ["contactGroups"], message: "Select at least one group" });
    }
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
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type TemplateInput = z.infer<typeof templateSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type CreateTeamMemberInput = z.infer<typeof createTeamMemberSchema>;
