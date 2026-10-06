/**
 * Database schema (MySQL 8.0.13+) for the modules implemented in this codebase.
 * Column names, types and keys follow "Database design (MySQL)" / Appendix A of the
 * technical documentation, so a database created from the full script stays compatible.
 */
import { randomUUID } from "node:crypto";
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  type AnyMySqlColumn,
  boolean,
  char,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const id = () => char("id", { length: 36 }).primaryKey().$defaultFn(() => randomUUID());
const ts = (name: string) => datetime(name, { mode: "date", fsp: 3 });
const createdAt = () => ts("created_at").default(sql`CURRENT_TIMESTAMP(3)`);
const updatedAt = () =>
  ts("updated_at")
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date());
const jsonArray = <T>(name: string) => json(name).$type<T[]>().$defaultFn(() => []);
const jsonObject = <T extends object>(name: string) => json(name).$type<T>().$defaultFn(() => ({}) as T);

// ---------------------------------------------------------------------------
// WhatsApp channels
// ---------------------------------------------------------------------------

export interface ChannelHealthDetails {
  qualityRating?: string;
  messagingLimitTier?: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  error?: string;
  [key: string]: unknown;
}

export const channels = mysqlTable("channels", {
  id: id(),
  name: text("name").notNull(),
  phoneNumberId: text("phone_number_id").notNull(),
  accessToken: text("access_token").notNull(),
  whatsappBusinessAccountId: text("whatsapp_business_account_id"),
  phoneNumber: text("phone_number"),
  appId: text("app_id"),
  isActive: boolean("is_active").default(true),
  isCoexistence: boolean("is_coexistence").default(false),
  healthStatus: text("health_status").$defaultFn(() => "unknown"),
  lastHealthCheck: ts("last_health_check"),
  healthDetails: jsonObject<ChannelHealthDetails>("health_details"),
  connectionMethod: varchar("connection_method", { length: 20 }).default("embedded"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  createdBy: varchar("created_by", { length: 255 }).default(""),
});

// ---------------------------------------------------------------------------
// Users & authentication
// ---------------------------------------------------------------------------

export const users = mysqlTable(
  "users",
  {
    id: id(),
    username: varchar("username", { length: 255 }).notNull().unique(),
    password: text("password").notNull(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    role: varchar("role", { length: 255 }).notNull().default("admin"),
    avatar: text("avatar"),
    status: text("status")
      .notNull()
      .$defaultFn(() => "active"),
    permissions: json("permissions")
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    channelId: char("channel_id", { length: 36 }).references(() => channels.id, { onDelete: "set null" }),
    lastLogin: ts("last_login"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: char("created_by", { length: 36 }).references((): AnyMySqlColumn => users.id, { onDelete: "set null" }),
    fcmToken: varchar("fcm_token", { length: 512 }),
    phone: text("phone"),
    isEmailVerified: boolean("is_email_verified").default(false),
    isMobileVerified: boolean("is_mobile_verified").default(false),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    razorpayCustomerId: varchar("razorpay_customer_id", { length: 255 }),
    paypalCustomerId: varchar("paypal_customer_id", { length: 255 }),
    paystackCustomerCode: varchar("paystack_customer_code", { length: 255 }),
    mercadopagoCustomerId: varchar("mercadopago_customer_id", { length: 255 }),
  },
  (t) => [index("users_created_by_idx").on(t.createdBy), index("users_role_idx").on(t.role)],
);

export const session = mysqlTable("session", {
  sid: char("sid", { length: 36 }).primaryKey(),
  sess: json("sess").notNull(),
  expire: ts("expire").notNull(),
});

export const userActivityLogs = mysqlTable("user_activity_logs", {
  id: id(),
  userId: char("user_id", { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: varchar("entity_id", { length: 255 }),
  details: jsonObject<Record<string, unknown>>("details"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Templates & API logs
// ---------------------------------------------------------------------------

export interface TemplateButton {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
  text: string;
  url?: string;
  phoneNumber?: string;
}

export const templates = mysqlTable(
  "templates",
  {
    id: id(),
    channelId: char("channel_id", { length: 36 })
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdBy: char("created_by", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    category: text("category").notNull(),
    language: text("language").$defaultFn(() => "en_US"),
    header: text("header"),
    body: text("body").notNull(),
    footer: text("footer"),
    buttons: jsonArray<TemplateButton>("buttons"),
    variables: jsonArray<string>("variables"),
    status: text("status").$defaultFn(() => "draft"),
    rejectionReason: text("rejection_reason"),
    mediaType: text("media_type").$defaultFn(() => "text"),
    mediaUrl: text("media_url"),
    mediaHandle: text("media_handle"),
    carouselCards: jsonArray<unknown>("carousel_cards"),
    whatsappTemplateId: varchar("whatsapp_template_id", { length: 255 }),
    usageCount: int("usage_count").default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    headerType: text("header_type"),
    bodyVariables: int("body_variables"),
  },
  (t) => [
    uniqueIndex("template_channel_wa_id_unique").on(t.whatsappTemplateId, t.channelId),
    index("templates_channel_idx").on(t.channelId),
  ],
);

export const apiLogs = mysqlTable("api_logs", {
  id: id(),
  channelId: char("channel_id", { length: 36 }).references(() => channels.id),
  requestType: varchar("request_type", { length: 50 }).notNull(),
  endpoint: text("endpoint").notNull(),
  method: varchar("method", { length: 10 }).notNull(),
  requestBody: json("request_body"),
  responseStatus: int("response_status"),
  responseBody: json("response_body"),
  duration: int("duration"),
  createdAt: createdAt(),
});

export const webhookDedup = mysqlTable("webhook_dedup", {
  wamid: varchar("wamid", { length: 255 }).primaryKey(),
  createdAt: ts("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
});

// ---------------------------------------------------------------------------
// Contacts, inbox & messaging
// ---------------------------------------------------------------------------

export const contacts = mysqlTable(
  "contacts",
  {
    id: id(),
    channelId: char("channel_id", { length: 36 })
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    tenantId: varchar("tenant_id", { length: 255 }),
    name: text("name").notNull(),
    phone: varchar("phone", { length: 255 }).notNull(),
    email: text("email"),
    groups: jsonArray<string>("groups"),
    tags: jsonArray<string>("tags"),
    status: varchar("status", { length: 255 }).default("active"),
    source: varchar("source", { length: 100 }),
    storeId: char("store_id", { length: 36 }),
    externalId: varchar("external_id", { length: 255 }),
    lastContact: ts("last_contact"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: char("created_by", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("contacts_channel_phone_unique").on(t.channelId, t.phone),
    uniqueIndex("contacts_store_external_unique").on(t.storeId, t.externalId),
    index("contacts_channel_idx").on(t.channelId),
    index("contacts_phone_idx").on(t.phone),
    index("contacts_status_idx").on(t.status),
    index("contacts_tenant_idx").on(t.tenantId),
    index("contacts_store_idx").on(t.storeId),
    index("contacts_external_id_idx").on(t.externalId),
  ],
);

export const groups = mysqlTable("groups", {
  id: id(),
  channelId: char("channelId", { length: 36 }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  createdBy: char("created_by", { length: 36 }).references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

export const conversations = mysqlTable(
  "conversations",
  {
    id: id(),
    channelId: char("channel_id", { length: 36 }).references(() => channels.id, { onDelete: "cascade" }),
    contactId: char("contact_id", { length: 36 }).references(() => contacts.id, { onDelete: "cascade" }),
    assignedTo: char("assigned_to", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    contactPhone: varchar("contact_phone", { length: 255 }),
    contactName: varchar("contact_name", { length: 255 }),
    status: varchar("status", { length: 255 }).default("open"),
    priority: text("priority").$defaultFn(() => "normal"),
    type: text("type").$defaultFn(() => "whatsapp"),
    chatbotId: varchar("chatbot_id", { length: 255 }),
    sessionId: text("session_id"),
    tags: jsonArray<string>("tags"),
    unreadCount: int("unread_count").default(0),
    lastMessageAt: ts("last_message_at"),
    lastIncomingMessageAt: ts("last_incoming_message_at"),
    lastMessageText: text("last_message_text"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("conversations_channel_idx").on(t.channelId),
    index("conversations_contact_idx").on(t.contactId),
    index("conversations_phone_idx").on(t.contactPhone),
    index("conversations_status_idx").on(t.status),
    index("conversations_last_msg_idx").on(t.channelId, t.lastMessageAt),
    index("conversations_assigned_idx").on(t.assignedTo),
    index("conversations_last_msg_at_idx").on(t.lastMessageAt),
  ],
);

export const campaigns = mysqlTable(
  "campaigns",
  {
    id: id(),
    channelId: char("channel_id", { length: 36 }).references(() => channels.id, { onDelete: "cascade" }),
    createdBy: char("created_by", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    campaignType: text("campaign_type").notNull(),
    type: text("type").notNull(),
    apiType: text("api_type").notNull(),
    templateId: char("template_id", { length: 36 }).references(() => templates.id),
    templateName: text("template_name"),
    templateLanguage: text("template_language"),
    variableMapping: jsonObject<Record<string, string>>("variable_mapping"),
    contactGroups: jsonArray<string>("contact_groups"),
    audienceType: text("audience_type").$defaultFn(() => "all"),
    platform: text("platform"),
    csvData: jsonArray<Record<string, string>>("csv_data"),
    apiKey: varchar("api_key", { length: 255 }),
    apiEndpoint: text("api_endpoint"),
    status: varchar("status", { length: 255 }).default("draft"),
    scheduledAt: ts("scheduled_at"),
    recipientCount: int("recipient_count").default(0),
    sentCount: int("sent_count").default(0),
    deliveredCount: int("delivered_count").default(0),
    readCount: int("read_count").default(0),
    repliedCount: int("replied_count").default(0),
    failedCount: int("failed_count").default(0),
    completedAt: ts("completed_at"),
    populationStartedAt: ts("population_started_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("campaigns_channel_idx").on(t.channelId),
    index("campaigns_status_idx").on(t.status),
    index("campaigns_created_idx").on(t.createdAt),
  ],
);

export const messages = mysqlTable(
  "messages",
  {
    id: id(),
    conversationId: char("conversation_id", { length: 36 }).references(() => conversations.id, { onDelete: "cascade" }),
    whatsappMessageId: varchar("whatsapp_message_id", { length: 255 }),
    fromUser: boolean("from_user").default(false),
    direction: varchar("direction", { length: 255 }).default("outbound"),
    content: text("content").notNull(),
    type: text("type").$defaultFn(() => "text"),
    fromType: varchar("from_type", { length: 255 }).default("user"),
    messageType: varchar("message_type", { length: 255 }),
    mediaId: varchar("media_id", { length: 255 }),
    mediaUrl: text("media_url"),
    mediaMimeType: varchar("media_mime_type", { length: 100 }),
    mediaSha256: varchar("media_sha256", { length: 128 }),
    status: varchar("status", { length: 255 }).default("sent"),
    timestamp: ts("timestamp"),
    metadata: jsonObject<Record<string, unknown>>("metadata"),
    deliveredAt: ts("delivered_at"),
    readAt: ts("read_at"),
    errorCode: varchar("error_code", { length: 50 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details"),
    campaignId: char("campaign_id", { length: 36 }).references(() => campaigns.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId),
    index("messages_whatsapp_idx").on(t.whatsappMessageId),
    index("messages_direction_idx").on(t.direction),
    index("messages_status_idx").on(t.status),
    index("messages_timestamp_idx").on(t.timestamp),
    index("messages_created_idx").on(t.createdAt),
    index("messages_conv_created_idx").on(t.conversationId, t.createdAt),
    index("messages_conv_status_created_idx").on(t.conversationId, t.status, t.createdAt),
  ],
);

export const conversationAssignments = mysqlTable("conversation_assignments", {
  id: id(),
  conversationId: char("conversation_id", { length: 36 })
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  userId: char("user_id", { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  assignedBy: char("assigned_by", { length: 36 }).references(() => users.id, { onDelete: "cascade" }),
  assignedAt: ts("assigned_at").default(sql`CURRENT_TIMESTAMP(3)`),
  status: text("status")
    .notNull()
    .$defaultFn(() => "active"),
  priority: text("priority").$defaultFn(() => "normal"),
  notes: text("notes"),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const conversationPins = mysqlTable(
  "conversation_pins",
  {
    id: id(),
    userId: char("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: char("conversation_id", { length: 36 })
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    channelId: char("channel_id", { length: 36 }).references(() => channels.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("conversation_pins_user_idx").on(t.userId),
    index("conversation_pins_user_channel_idx").on(t.userId, t.channelId),
    uniqueIndex("conversation_pins_user_conv_uniq").on(t.userId, t.conversationId),
  ],
);

export const messageQueue = mysqlTable("message_queue", {
  id: id(),
  campaignId: char("campaign_id", { length: 36 }).references(() => campaigns.id),
  channelId: char("channel_id", { length: 36 }).references(() => channels.id),
  recipientPhone: varchar("recipient_phone", { length: 20 }).notNull(),
  templateName: varchar("template_name", { length: 100 }),
  templateLanguage: varchar("template_language", { length: 20 }).default("en_US"),
  templateParams: jsonArray<string>("template_params"),
  messageType: varchar("message_type", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).default("queued"),
  attempts: int("attempts").default(0),
  whatsappMessageId: varchar("whatsapp_message_id", { length: 100 }),
  conversationId: varchar("conversation_id", { length: 100 }),
  sentVia: varchar("sent_via", { length: 20 }),
  cost: varchar("cost", { length: 20 }),
  errorCode: varchar("error_code", { length: 50 }),
  errorMessage: text("error_message"),
  scheduledFor: ts("scheduled_for"),
  processedAt: ts("processed_at"),
  deliveredAt: ts("delivered_at"),
  readAt: ts("read_at"),
  createdAt: createdAt(),
});

export const campaignRecipients = mysqlTable(
  "campaign_recipients",
  {
    id: id(),
    campaignId: char("campaign_id", { length: 36 })
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    contactId: char("contact_id", { length: 36 }).references(() => contacts.id, { onDelete: "cascade" }),
    phone: varchar("phone", { length: 255 }).notNull(),
    name: text("name"),
    status: varchar("status", { length: 255 }).default("pending"),
    whatsappMessageId: varchar("whatsapp_message_id", { length: 255 }),
    templateParams: jsonObject<Record<string, string>>("template_params"),
    sentAt: ts("sent_at"),
    deliveredAt: ts("delivered_at"),
    readAt: ts("read_at"),
    errorCode: varchar("error_code", { length: 255 }),
    errorMessage: text("error_message"),
    retryCount: int("retry_count").default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("campaign_phone_unique").on(t.campaignId, t.phone),
    index("recipients_campaign_idx").on(t.campaignId),
    index("recipients_status_idx").on(t.status),
    index("recipients_phone_idx").on(t.phone),
  ],
);

// ---------------------------------------------------------------------------
// Billing (plans & subscriptions drive plan limits)
// ---------------------------------------------------------------------------

/** Plan limits keyed by feature. -1 means unlimited, 0 means not included. */
export interface PlanLimits {
  channel?: number;
  contacts?: number;
  campaign?: number;
  team?: number;
  automation?: number;
  [feature: string]: number | undefined;
}

export const plans = mysqlTable("plans", {
  id: id(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  icon: varchar("icon", { length: 255 }),
  popular: boolean("popular").default(false),
  badge: varchar("badge", { length: 255 }),
  color: varchar("color", { length: 255 }),
  buttonColor: varchar("button_color", { length: 255 }),
  monthlyPrice: decimal("monthly_price", { precision: 10, scale: 2 }).default("0"),
  annualPrice: decimal("annual_price", { precision: 10, scale: 2 }).default("0"),
  multiCurrencyPrices: json("multi_currency_prices"),
  permissions: json("permissions").$type<PlanLimits>(),
  features: json("features").$type<string[]>(),
  stripeProductId: varchar("stripe_product_id", { length: 255 }),
  stripePriceIdMonthly: varchar("stripe_price_id_monthly", { length: 255 }),
  stripePriceIdAnnual: varchar("stripe_price_id_annual", { length: 255 }),
  razorpayPlanIdMonthly: varchar("razorpay_plan_id_monthly", { length: 255 }),
  razorpayPlanIdAnnual: varchar("razorpay_plan_id_annual", { length: 255 }),
  paypalProductId: varchar("paypal_product_id", { length: 255 }),
  paypalPlanIdMonthly: varchar("paypal_plan_id_monthly", { length: 255 }),
  paypalPlanIdAnnual: varchar("paypal_plan_id_annual", { length: 255 }),
  paystackPlanCodeMonthly: varchar("paystack_plan_code_monthly", { length: 255 }),
  paystackPlanCodeAnnual: varchar("paystack_plan_code_annual", { length: 255 }),
  mercadopagoPlanIdMonthly: varchar("mercadopago_plan_id_monthly", { length: 255 }),
  mercadopagoPlanIdAnnual: varchar("mercadopago_plan_id_annual", { length: 255 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subscriptions = mysqlTable("subscriptions", {
  id: id(),
  userId: char("user_id", { length: 36 })
    .notNull()
    .references(() => users.id),
  planId: char("plan_id", { length: 36 })
    .notNull()
    .references(() => plans.id),
  planData: json("plan_data").$type<{ name: string; permissions: PlanLimits }>().notNull(),
  status: varchar("status", { length: 255 }).notNull(),
  billingCycle: varchar("billing_cycle", { length: 255 }).notNull(),
  startDate: ts("start_date").notNull(),
  endDate: ts("end_date").notNull(),
  autoRenew: boolean("auto_renew").default(true),
  gatewaySubscriptionId: varchar("gateway_subscription_id", { length: 255 }),
  gatewayProvider: varchar("gateway_provider", { length: 255 }),
  gatewayStatus: varchar("gateway_status", { length: 255 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// In-app updater
// ---------------------------------------------------------------------------

export const updateRuns = mysqlTable(
  "update_runs",
  {
    id: id(),
    triggeredBy: char("triggered_by", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    triggeredByUsername: text("triggered_by_username"),
    fromVersion: text("from_version"),
    toVersion: text("to_version"),
    status: varchar("status", { length: 20 }).notNull().default("running"),
    finalMessage: text("final_message"),
    startedAt: ts("started_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("update_runs_started_at_idx").on(t.startedAt)],
);

export const updateRunEvents = mysqlTable(
  "update_run_events",
  {
    id: int("id").autoincrement().primaryKey(),
    runId: char("run_id", { length: 36 })
      .notNull()
      .references(() => updateRuns.id, { onDelete: "cascade" }),
    step: varchar("step", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    message: text("message").notNull(),
    progress: int("progress"),
    createdAt: ts("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("update_run_events_run_id_idx").on(t.runId, t.id)],
);

/** Tables owned by this schema; drizzle-kit is restricted to these. */
export const MANAGED_TABLES = [
  "channels",
  "users",
  "session",
  "user_activity_logs",
  "templates",
  "api_logs",
  "webhook_dedup",
  "contacts",
  "groups",
  "conversations",
  "campaigns",
  "messages",
  "conversation_assignments",
  "conversation_pins",
  "message_queue",
  "campaign_recipients",
  "plans",
  "subscriptions",
  "update_runs",
  "update_run_events",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Channel = InferSelectModel<typeof channels>;
export type InsertChannel = InferInsertModel<typeof channels>;
export type User = InferSelectModel<typeof users>;
export type InsertUser = InferInsertModel<typeof users>;
export type Template = InferSelectModel<typeof templates>;
export type Contact = InferSelectModel<typeof contacts>;
export type Group = InferSelectModel<typeof groups>;
export type Conversation = InferSelectModel<typeof conversations>;
export type Message = InferSelectModel<typeof messages>;
export type Campaign = InferSelectModel<typeof campaigns>;
export type CampaignRecipient = InferSelectModel<typeof campaignRecipients>;
export type QueuedMessage = InferSelectModel<typeof messageQueue>;
export type Plan = InferSelectModel<typeof plans>;
export type Subscription = InferSelectModel<typeof subscriptions>;
export type UpdateRun = InferSelectModel<typeof updateRuns>;
export type UpdateRunEvent = InferSelectModel<typeof updateRunEvents>;
export type ActivityLog = InferSelectModel<typeof userActivityLogs>;
