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
  double,
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
    /** Assigned platform access level (platform_access_levels.level_number); NULL = no level limits. */
    accessLevel: int("access_level"),
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

// ---------------------------------------------------------------------------
// Email & SMS marketing
// ---------------------------------------------------------------------------

export const smtpConfig = mysqlTable("smtp_config", {
  id: id(),
  /** Tenant admin id; NULL is the platform-wide default managed by the superadmin. */
  userId: char("user_id", { length: 36 }).references(() => users.id, { onDelete: "cascade" }),
  host: text("host").notNull(),
  port: int("port").notNull(),
  secure: boolean("secure").default(false),
  user: text("user").notNull(),
  password: text("password"),
  fromName: text("from_name").notNull(),
  fromEmail: text("from_email").notNull(),
  logo: text("logo").$defaultFn(() => "null"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const emailTemplates = mysqlTable("email_templates", {
  id: id(),
  userId: char("user_id", { length: 36 }).references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category").$defaultFn(() => "promotional"),
  subject: text("subject"),
  previewText: text("preview_text"),
  contentHtml: text("content_html").notNull(),
  contentText: text("content_text"),
  isSystem: boolean("is_system").default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const emailCampaigns = mysqlTable(
  "email_campaigns",
  {
    id: id(),
    /** Owning tenant (admin id), so the whole team shares campaigns. */
    userId: char("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: varchar("channel_id", { length: 255 }),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    previewText: text("preview_text"),
    senderName: text("sender_name").$defaultFn(() => "Cortesys Marketing"),
    senderEmail: text("sender_email"),
    replyTo: text("reply_to"),
    contentHtml: text("content_html").notNull(),
    contentText: text("content_text"),
    templateId: varchar("template_id", { length: 255 }),
    targetAudience: text("target_audience").$defaultFn(() => "all_contacts"),
    targetGroupId: varchar("target_group_id", { length: 255 }),
    targetGroupName: text("target_group_name"),
    csvData: jsonArray<{ email: string; name?: string }>("csv_data"),
    status: varchar("status", { length: 255 }).default("draft"),
    scheduledAt: ts("scheduled_at"),
    sentAt: ts("sent_at"),
    totalRecipients: int("total_recipients").default(0),
    sentCount: int("sent_count").default(0),
    deliveredCount: int("delivered_count").default(0),
    openedCount: int("opened_count").default(0),
    clickedCount: int("clicked_count").default(0),
    failedCount: int("failed_count").default(0),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("email_campaigns_user_idx").on(t.userId), index("email_campaigns_status_idx").on(t.status)],
);

export const emailCampaignRecipients = mysqlTable(
  "email_campaign_recipients",
  {
    id: id(),
    campaignId: char("campaign_id", { length: 36 })
      .notNull()
      .references(() => emailCampaigns.id, { onDelete: "cascade" }),
    contactId: varchar("contact_id", { length: 255 }),
    email: text("email").notNull(),
    name: text("name"),
    status: varchar("status", { length: 255 }).default("pending"),
    sentAt: ts("sent_at"),
    deliveredAt: ts("delivered_at"),
    openedAt: ts("opened_at"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
  },
  (t) => [index("email_recipients_campaign_idx").on(t.campaignId), index("email_recipients_status_idx").on(t.status)],
);

export const smsGateways = mysqlTable("sms_gateways", {
  id: id(),
  userId: char("user_id", { length: 36 }).references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider")
    .notNull()
    .$defaultFn(() => "simulator"),
  accountSid: text("account_sid"),
  authToken: text("auth_token"),
  fromNumber: text("from_number").$defaultFn(() => "+18005550199"),
  senderId: text("sender_id").$defaultFn(() => "CORTESYS"),
  webhookUrl: text("webhook_url"),
  isActive: boolean("is_active").default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const smsCampaigns = mysqlTable(
  "sms_campaigns",
  {
    id: id(),
    userId: char("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: varchar("channel_id", { length: 255 }),
    name: text("name").notNull(),
    senderId: text("sender_id").$defaultFn(() => "CORTESYS"),
    fromNumber: text("from_number"),
    message: text("message").notNull(),
    mediaUrl: text("media_url"),
    gateway: text("gateway").$defaultFn(() => "simulator"),
    targetAudience: text("target_audience").$defaultFn(() => "all_contacts"),
    targetGroupId: varchar("target_group_id", { length: 255 }),
    targetGroupName: text("target_group_name"),
    csvData: jsonArray<{ phone: string; name?: string }>("csv_data"),
    status: varchar("status", { length: 255 }).default("draft"),
    scheduledAt: ts("scheduled_at"),
    sentAt: ts("sent_at"),
    totalRecipients: int("total_recipients").default(0),
    sentCount: int("sent_count").default(0),
    deliveredCount: int("delivered_count").default(0),
    failedCount: int("failed_count").default(0),
    smsSegmentsPerRecipient: int("sms_segments_per_recipient").default(1),
    estimatedCredits: int("estimated_credits").default(0),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sms_campaigns_user_idx").on(t.userId), index("sms_campaigns_status_idx").on(t.status)],
);

export const smsCampaignRecipients = mysqlTable(
  "sms_campaign_recipients",
  {
    id: id(),
    campaignId: char("campaign_id", { length: 36 })
      .notNull()
      .references(() => smsCampaigns.id, { onDelete: "cascade" }),
    contactId: varchar("contact_id", { length: 255 }),
    phone: text("phone").notNull(),
    name: text("name"),
    segments: int("segments").default(1),
    status: varchar("status", { length: 255 }).default("pending"),
    sentAt: ts("sent_at"),
    deliveredAt: ts("delivered_at"),
    messageId: text("message_id"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
  },
  (t) => [index("sms_recipients_campaign_idx").on(t.campaignId), index("sms_recipients_status_idx").on(t.status)],
);

// ---------------------------------------------------------------------------
// Platform administration
// ---------------------------------------------------------------------------

export interface SeoSettings {
  metaTitle?: string;
  metaDescription?: string;
  metaKeywords?: string[];
  ogImage?: string;
}
export interface FrontendSettings {
  heroTitle?: string;
  heroSubtitle?: string;
  features?: string[];
  footerText?: string;
}
export interface MaintenanceMode {
  enabled: boolean;
  title: string;
  content: string;
  bypassSecret: string;
}
export interface GdprCookie {
  enabled: boolean;
  bannerText: string;
  acceptButtonText: string;
  declineButtonText: string;
  policyUrl: string;
  cookieLifespanDays: number;
}
export interface ExtensionSettings {
  googleLogin?: { enabled: boolean; clientId: string; clientSecret?: string };
}

export const systemConfigurations = mysqlTable("system_configurations", {
  id: char("id", { length: 36 }).primaryKey().default("default"),
  siteTitle: varchar("site_title", { length: 255 }).default("Cortesys"),
  timezone: varchar("timezone", { length: 255 }).default("UTC"),
  currency: varchar("currency", { length: 255 }).default("USD"),
  currencySymbol: varchar("currency_symbol", { length: 255 }).default("$"),
  siteBaseColor: varchar("site_base_color", { length: 255 }).default("#16a34a"),
  recordsPerPage: int("records_per_page").default(20),
  currencyDisplayMode: varchar("currency_display_mode", { length: 255 }).default("both"),
  homeDefaultService: varchar("home_default_service", { length: 255 }).default("whatsapp_marketing"),
  referralCommission: double("referral_commission").default(10),
  logo: text("logo"),
  favicon: text("favicon"),
  userRegistration: boolean("user_registration").default(true),
  forceSsl: boolean("force_ssl").default(false),
  agreePolicy: boolean("agree_policy").default(true),
  forceSecurePassword: boolean("force_secure_password").default(true),
  kycVerification: boolean("kyc_verification").default(false),
  emailVerification: boolean("email_verification").default(false),
  emailNotification: boolean("email_notification").default(true),
  mobileVerification: boolean("mobile_verification").default(false),
  smsNotification: boolean("sms_notification").default(true),
  pushNotification: boolean("push_notification").default(true),
  postAutoApproval: boolean("post_auto_approval").default(true),
  languageOption: boolean("language_option").default(true),
  globalEmailTemplate: text("global_email_template"),
  globalSmsTemplate: text("global_sms_template"),
  globalPushTemplate: text("global_push_template"),
  smtpSettings: jsonObject<Record<string, unknown>>("smtp_settings"),
  smsSettings: jsonObject<Record<string, unknown>>("sms_settings"),
  pushSettings: jsonObject<Record<string, unknown>>("push_settings"),
  seoSettings: jsonObject<SeoSettings>("seo_settings"),
  frontendSettings: jsonObject<FrontendSettings>("frontend_settings"),
  extensionSettings: jsonObject<ExtensionSettings>("extension_settings"),
  maintenanceMode: json("maintenance_mode")
    .$type<MaintenanceMode>()
    .$defaultFn(() => ({ enabled: false, title: "Platform Maintenance", content: "We are currently undergoing scheduled maintenance. Please check back shortly.", bypassSecret: "" })),
  gdprCookie: json("gdpr_cookie")
    .$type<GdprCookie>()
    .$defaultFn(() => ({
      enabled: true,
      bannerText: "We use cookies to improve your experience and analyze site traffic. By continuing to use our website, you agree to our use of cookies.",
      acceptButtonText: "Accept All",
      declineButtonText: "Reject Non-Essential",
      policyUrl: "/policy/cookie-policy",
      cookieLifespanDays: 365,
    })),
  customCss: text("custom_css").$defaultFn(() => ""),
  robotsTxt: text("robots_txt"),
  sitemapXml: text("sitemap_xml"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const panelConfig = mysqlTable("panel_config", {
  id: id(),
  name: varchar("name", { length: 255 }).notNull(),
  tagline: varchar("tagline", { length: 255 }),
  description: text("description"),
  logo: varchar("logo", { length: 255 }),
  logo2: varchar("logo2", { length: 255 }),
  favicon: varchar("favicon", { length: 255 }),
  defaultLanguage: varchar("default_language", { length: 5 }).default("en"),
  supportedLanguages: json("supported_languages")
    .$type<string[]>()
    .$defaultFn(() => ["en"]),
  companyName: varchar("company_name", { length: 255 }),
  companyWebsite: varchar("company_website", { length: 255 }),
  supportEmail: varchar("support_email", { length: 255 }),
  currency: varchar("currency", { length: 10 }).default("INR"),
  country: varchar("country", { length: 2 }).default("IN"),
  embeddedSignupEnabled: boolean("embedded_signup_enabled").default(true),
  publicOrigin: text("public_origin"),
  appearanceConfig: jsonObject<Record<string, unknown>>("appearance_config"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const policyPages = mysqlTable("policy_pages", {
  id: id(),
  title: varchar("title", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  content: text("content").notNull(),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  isPublished: boolean("is_published").default(true),
  isSystem: boolean("is_system").default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cronJobLogs = mysqlTable("cron_job_logs", {
  id: id(),
  jobKey: varchar("job_key", { length: 100 }).notNull(),
  jobName: varchar("job_name", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  message: text("message"),
  durationMs: int("duration_ms").default(0),
  executedAt: ts("executed_at").default(sql`CURRENT_TIMESTAMP(3)`),
});

export const platformAccessLevels = mysqlTable("platform_access_levels", {
  id: id(),
  levelNumber: int("level_number").notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  badgeColor: varchar("badge_color", { length: 50 }).default("blue"),
  maxChannels: int("max_channels").default(1),
  maxContacts: int("max_contacts").default(500),
  maxMessagesMonthly: int("max_messages_monthly").default(1000),
  maxCampaigns: int("max_campaigns").default(5),
  aiAssistantEnabled: boolean("ai_assistant_enabled").default(true),
  smsEnabled: boolean("sms_enabled").default(false),
  emailEnabled: boolean("email_enabled").default(false),
  prioritySupport: boolean("priority_support").default(false),
  apiAccess: boolean("api_access").default(false),
  createdAt: ts("created_at").default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: ts("updated_at")
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date()),
});

export const platformLanguages = mysqlTable("platform_languages", {
  id: id(),
  code: varchar("code", { length: 10 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  nativeName: varchar("native_name", { length: 100 }).notNull(),
  icon: varchar("icon", { length: 10 }),
  direction: varchar("direction", { length: 3 }).notNull().default("ltr"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  translations: jsonObject<Record<string, string>>("translations"),
  sortOrder: int("sort_order").default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const notifications = mysqlTable(
  "notifications",
  {
    id: int("id").autoincrement().primaryKey(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    type: varchar("type", { length: 255 }).notNull().default("general"),
    createdBy: varchar("created_by", { length: 255 }).notNull().default("system"),
    channelId: char("channel_id", { length: 36 }).references(() => channels.id, { onDelete: "set null" }),
    targetType: varchar("target_type", { length: 255 }).notNull(),
    targetIds: jsonArray<string>("target_ids"),
    status: varchar("status", { length: 255 }).notNull().default("draft"),
    sentAt: ts("sent_at"),
    createdAt: ts("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index("notifications_channel_idx").on(t.channelId)],
);

export const sentNotifications = mysqlTable("sent_notifications", {
  id: int("id").autoincrement().primaryKey(),
  notificationId: int("notification_id")
    .notNull()
    .references(() => notifications.id, { onDelete: "cascade" }),
  userId: varchar("user_id", { length: 255 }),
  isRead: boolean("is_read").default(false),
  readAt: ts("read_at"),
  sentAt: ts("sent_at").default(sql`CURRENT_TIMESTAMP(3)`),
});

export const otpVerifications = mysqlTable("otp_verifications", {
  id: id(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  otpCode: varchar("otp_code", { length: 6 }).notNull(),
  expiresAt: ts("expires_at").notNull(),
  isUsed: boolean("is_used").default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
  "smtp_config",
  "email_templates",
  "email_campaigns",
  "email_campaign_recipients",
  "sms_gateways",
  "sms_campaigns",
  "sms_campaign_recipients",
  "system_configurations",
  "panel_config",
  "policy_pages",
  "cron_job_logs",
  "platform_access_levels",
  "platform_languages",
  "notifications",
  "sent_notifications",
  "otp_verifications",
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
export type SmtpConfig = InferSelectModel<typeof smtpConfig>;
export type EmailTemplate = InferSelectModel<typeof emailTemplates>;
export type EmailCampaign = InferSelectModel<typeof emailCampaigns>;
export type EmailRecipient = InferSelectModel<typeof emailCampaignRecipients>;
export type SmsGateway = InferSelectModel<typeof smsGateways>;
export type SmsCampaign = InferSelectModel<typeof smsCampaigns>;
export type SmsRecipient = InferSelectModel<typeof smsCampaignRecipients>;
export type SystemConfig = InferSelectModel<typeof systemConfigurations>;
export type PanelConfig = InferSelectModel<typeof panelConfig>;
export type PolicyPage = InferSelectModel<typeof policyPages>;
export type CronJobLog = InferSelectModel<typeof cronJobLogs>;
export type AccessLevel = InferSelectModel<typeof platformAccessLevels>;
export type PlatformLanguage = InferSelectModel<typeof platformLanguages>;
export type Notification = InferSelectModel<typeof notifications>;
export type SentNotification = InferSelectModel<typeof sentNotifications>;
