CREATE TABLE `api_logs` (
	`id` char(36) NOT NULL,
	`channel_id` char(36),
	`request_type` varchar(50) NOT NULL,
	`endpoint` text NOT NULL,
	`method` varchar(10) NOT NULL,
	`request_body` json,
	`response_status` int,
	`response_body` json,
	`duration` int,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `api_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`id` char(36) NOT NULL,
	`campaign_id` char(36) NOT NULL,
	`contact_id` char(36),
	`phone` varchar(255) NOT NULL,
	`name` text,
	`status` varchar(255) DEFAULT 'pending',
	`whatsapp_message_id` varchar(255),
	`template_params` json,
	`sent_at` datetime(3),
	`delivered_at` datetime(3),
	`read_at` datetime(3),
	`error_code` varchar(255),
	`error_message` text,
	`retry_count` int DEFAULT 0,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `campaign_recipients_id` PRIMARY KEY(`id`),
	CONSTRAINT `campaign_phone_unique` UNIQUE(`campaign_id`,`phone`)
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` char(36) NOT NULL,
	`channel_id` char(36),
	`created_by` char(36) NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`campaign_type` text NOT NULL,
	`type` text NOT NULL,
	`api_type` text NOT NULL,
	`template_id` char(36),
	`template_name` text,
	`template_language` text,
	`variable_mapping` json,
	`contact_groups` json,
	`audience_type` text,
	`platform` text,
	`csv_data` json,
	`api_key` varchar(255),
	`api_endpoint` text,
	`status` varchar(255) DEFAULT 'draft',
	`scheduled_at` datetime(3),
	`recipient_count` int DEFAULT 0,
	`sent_count` int DEFAULT 0,
	`delivered_count` int DEFAULT 0,
	`read_count` int DEFAULT 0,
	`replied_count` int DEFAULT 0,
	`failed_count` int DEFAULT 0,
	`completed_at` datetime(3),
	`population_started_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` char(36) NOT NULL,
	`name` text NOT NULL,
	`phone_number_id` text NOT NULL,
	`access_token` text NOT NULL,
	`whatsapp_business_account_id` text,
	`phone_number` text,
	`app_id` text,
	`is_active` boolean DEFAULT true,
	`is_coexistence` boolean DEFAULT false,
	`health_status` text,
	`last_health_check` datetime(3),
	`health_details` json,
	`connection_method` varchar(20) DEFAULT 'embedded',
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` varchar(255) DEFAULT '',
	CONSTRAINT `channels_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` char(36) NOT NULL,
	`channel_id` char(36) NOT NULL,
	`tenant_id` varchar(255),
	`name` text NOT NULL,
	`phone` varchar(255) NOT NULL,
	`email` text,
	`groups` json,
	`tags` json,
	`status` varchar(255) DEFAULT 'active',
	`source` varchar(100),
	`store_id` char(36),
	`external_id` varchar(255),
	`last_contact` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` char(36),
	CONSTRAINT `contacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `contacts_channel_phone_unique` UNIQUE(`channel_id`,`phone`),
	CONSTRAINT `contacts_store_external_unique` UNIQUE(`store_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_assignments` (
	`id` char(36) NOT NULL,
	`conversation_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`assigned_by` char(36),
	`assigned_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`status` text NOT NULL,
	`priority` text,
	`notes` text,
	`resolved_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `conversation_assignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_pins` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`conversation_id` char(36) NOT NULL,
	`channel_id` char(36),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `conversation_pins_id` PRIMARY KEY(`id`),
	CONSTRAINT `conversation_pins_user_conv_uniq` UNIQUE(`user_id`,`conversation_id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` char(36) NOT NULL,
	`channel_id` char(36),
	`contact_id` char(36),
	`assigned_to` char(36),
	`contact_phone` varchar(255),
	`contact_name` varchar(255),
	`status` varchar(255) DEFAULT 'open',
	`priority` text,
	`type` text,
	`chatbot_id` varchar(255),
	`session_id` text,
	`tags` json,
	`unread_count` int DEFAULT 0,
	`last_message_at` datetime(3),
	`last_incoming_message_at` datetime(3),
	`last_message_text` text,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` char(36) NOT NULL,
	`channelId` char(36),
	`name` varchar(255) NOT NULL,
	`description` text,
	`created_by` char(36),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `groups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `message_queue` (
	`id` char(36) NOT NULL,
	`campaign_id` char(36),
	`channel_id` char(36),
	`recipient_phone` varchar(20) NOT NULL,
	`template_name` varchar(100),
	`template_language` varchar(20) DEFAULT 'en_US',
	`template_params` json,
	`message_type` varchar(20) NOT NULL,
	`status` varchar(20) DEFAULT 'queued',
	`attempts` int DEFAULT 0,
	`whatsapp_message_id` varchar(100),
	`conversation_id` varchar(100),
	`sent_via` varchar(20),
	`cost` varchar(20),
	`error_code` varchar(50),
	`error_message` text,
	`scheduled_for` datetime(3),
	`processed_at` datetime(3),
	`delivered_at` datetime(3),
	`read_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `message_queue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` char(36) NOT NULL,
	`conversation_id` char(36),
	`whatsapp_message_id` varchar(255),
	`from_user` boolean DEFAULT false,
	`direction` varchar(255) DEFAULT 'outbound',
	`content` text NOT NULL,
	`type` text,
	`from_type` varchar(255) DEFAULT 'user',
	`message_type` varchar(255),
	`media_id` varchar(255),
	`media_url` text,
	`media_mime_type` varchar(100),
	`media_sha256` varchar(128),
	`status` varchar(255) DEFAULT 'sent',
	`timestamp` datetime(3),
	`metadata` json,
	`delivered_at` datetime(3),
	`read_at` datetime(3),
	`error_code` varchar(50),
	`error_message` text,
	`error_details` json,
	`campaign_id` char(36),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` char(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`icon` varchar(255),
	`popular` boolean DEFAULT false,
	`badge` varchar(255),
	`color` varchar(255),
	`button_color` varchar(255),
	`monthly_price` decimal(10,2) DEFAULT '0',
	`annual_price` decimal(10,2) DEFAULT '0',
	`multi_currency_prices` json,
	`permissions` json,
	`features` json,
	`stripe_product_id` varchar(255),
	`stripe_price_id_monthly` varchar(255),
	`stripe_price_id_annual` varchar(255),
	`razorpay_plan_id_monthly` varchar(255),
	`razorpay_plan_id_annual` varchar(255),
	`paypal_product_id` varchar(255),
	`paypal_plan_id_monthly` varchar(255),
	`paypal_plan_id_annual` varchar(255),
	`paystack_plan_code_monthly` varchar(255),
	`paystack_plan_code_annual` varchar(255),
	`mercadopago_plan_id_monthly` varchar(255),
	`mercadopago_plan_id_annual` varchar(255),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `plans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`sid` char(36) NOT NULL,
	`sess` json NOT NULL,
	`expire` datetime(3) NOT NULL,
	CONSTRAINT `session_sid` PRIMARY KEY(`sid`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`plan_id` char(36) NOT NULL,
	`plan_data` json NOT NULL,
	`status` varchar(255) NOT NULL,
	`billing_cycle` varchar(255) NOT NULL,
	`start_date` datetime(3) NOT NULL,
	`end_date` datetime(3) NOT NULL,
	`auto_renew` boolean DEFAULT true,
	`gateway_subscription_id` varchar(255),
	`gateway_provider` varchar(255),
	`gateway_status` varchar(255),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` char(36) NOT NULL,
	`channel_id` char(36) NOT NULL,
	`created_by` char(36),
	`name` text NOT NULL,
	`category` text NOT NULL,
	`language` text,
	`header` text,
	`body` text NOT NULL,
	`footer` text,
	`buttons` json,
	`variables` json,
	`status` text,
	`rejection_reason` text,
	`media_type` text,
	`media_url` text,
	`media_handle` text,
	`carousel_cards` json,
	`whatsapp_template_id` varchar(255),
	`usage_count` int DEFAULT 0,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`header_type` text,
	`body_variables` int,
	CONSTRAINT `templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `template_channel_wa_id_unique` UNIQUE(`whatsapp_template_id`,`channel_id`)
);
--> statement-breakpoint
CREATE TABLE `update_run_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` char(36) NOT NULL,
	`step` varchar(50) NOT NULL,
	`status` varchar(20) NOT NULL,
	`message` text NOT NULL,
	`progress` int,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `update_run_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `update_runs` (
	`id` char(36) NOT NULL,
	`triggered_by` char(36),
	`triggered_by_username` text,
	`from_version` text,
	`to_version` text,
	`status` varchar(20) NOT NULL DEFAULT 'running',
	`final_message` text,
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	CONSTRAINT `update_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_activity_logs` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` varchar(255),
	`details` json,
	`ip_address` text,
	`user_agent` text,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_activity_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`username` varchar(255) NOT NULL,
	`password` text NOT NULL,
	`email` varchar(255) NOT NULL,
	`first_name` text,
	`last_name` text,
	`role` varchar(255) NOT NULL DEFAULT 'admin',
	`avatar` text,
	`status` text NOT NULL,
	`permissions` json NOT NULL,
	`channel_id` char(36),
	`last_login` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` char(36),
	`fcm_token` varchar(512),
	`phone` text,
	`is_email_verified` boolean DEFAULT false,
	`is_mobile_verified` boolean DEFAULT false,
	`stripe_customer_id` varchar(255),
	`razorpay_customer_id` varchar(255),
	`paypal_customer_id` varchar(255),
	`paystack_customer_code` varchar(255),
	`mercadopago_customer_id` varchar(255),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_username_unique` UNIQUE(`username`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `webhook_dedup` (
	`wamid` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `webhook_dedup_wamid` PRIMARY KEY(`wamid`)
);
--> statement-breakpoint
ALTER TABLE `api_logs` ADD CONSTRAINT `api_logs_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `campaign_recipients_campaign_id_campaigns_id_fk` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `campaign_recipients_contact_id_contacts_id_fk` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_template_id_templates_id_fk` FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_assignments` ADD CONSTRAINT `conversation_assignments_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_assignments` ADD CONSTRAINT `conversation_assignments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_assignments` ADD CONSTRAINT `conversation_assignments_assigned_by_users_id_fk` FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_pins` ADD CONSTRAINT `conversation_pins_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_pins` ADD CONSTRAINT `conversation_pins_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_pins` ADD CONSTRAINT `conversation_pins_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_contact_id_contacts_id_fk` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_assigned_to_users_id_fk` FOREIGN KEY (`assigned_to`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `groups` ADD CONSTRAINT `groups_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_queue` ADD CONSTRAINT `message_queue_campaign_id_campaigns_id_fk` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_queue` ADD CONSTRAINT `message_queue_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_campaign_id_campaigns_id_fk` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_plan_id_plans_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `templates` ADD CONSTRAINT `templates_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `templates` ADD CONSTRAINT `templates_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `update_run_events` ADD CONSTRAINT `update_run_events_run_id_update_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `update_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `update_runs` ADD CONSTRAINT `update_runs_triggered_by_users_id_fk` FOREIGN KEY (`triggered_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_activity_logs` ADD CONSTRAINT `user_activity_logs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `recipients_campaign_idx` ON `campaign_recipients` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `recipients_status_idx` ON `campaign_recipients` (`status`);--> statement-breakpoint
CREATE INDEX `recipients_phone_idx` ON `campaign_recipients` (`phone`);--> statement-breakpoint
CREATE INDEX `campaigns_channel_idx` ON `campaigns` (`channel_id`);--> statement-breakpoint
CREATE INDEX `campaigns_status_idx` ON `campaigns` (`status`);--> statement-breakpoint
CREATE INDEX `campaigns_created_idx` ON `campaigns` (`created_at`);--> statement-breakpoint
CREATE INDEX `contacts_channel_idx` ON `contacts` (`channel_id`);--> statement-breakpoint
CREATE INDEX `contacts_phone_idx` ON `contacts` (`phone`);--> statement-breakpoint
CREATE INDEX `contacts_status_idx` ON `contacts` (`status`);--> statement-breakpoint
CREATE INDEX `contacts_tenant_idx` ON `contacts` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `contacts_store_idx` ON `contacts` (`store_id`);--> statement-breakpoint
CREATE INDEX `contacts_external_id_idx` ON `contacts` (`external_id`);--> statement-breakpoint
CREATE INDEX `conversation_pins_user_idx` ON `conversation_pins` (`user_id`);--> statement-breakpoint
CREATE INDEX `conversation_pins_user_channel_idx` ON `conversation_pins` (`user_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `conversations_channel_idx` ON `conversations` (`channel_id`);--> statement-breakpoint
CREATE INDEX `conversations_contact_idx` ON `conversations` (`contact_id`);--> statement-breakpoint
CREATE INDEX `conversations_phone_idx` ON `conversations` (`contact_phone`);--> statement-breakpoint
CREATE INDEX `conversations_status_idx` ON `conversations` (`status`);--> statement-breakpoint
CREATE INDEX `conversations_last_msg_idx` ON `conversations` (`channel_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_assigned_idx` ON `conversations` (`assigned_to`);--> statement-breakpoint
CREATE INDEX `conversations_last_msg_at_idx` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `messages_whatsapp_idx` ON `messages` (`whatsapp_message_id`);--> statement-breakpoint
CREATE INDEX `messages_direction_idx` ON `messages` (`direction`);--> statement-breakpoint
CREATE INDEX `messages_status_idx` ON `messages` (`status`);--> statement-breakpoint
CREATE INDEX `messages_timestamp_idx` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE INDEX `messages_created_idx` ON `messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `messages_conv_created_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_conv_status_created_idx` ON `messages` (`conversation_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `templates_channel_idx` ON `templates` (`channel_id`);--> statement-breakpoint
CREATE INDEX `update_run_events_run_id_idx` ON `update_run_events` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `update_runs_started_at_idx` ON `update_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `users_created_by_idx` ON `users` (`created_by`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);