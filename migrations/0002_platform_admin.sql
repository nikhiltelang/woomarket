CREATE TABLE `cron_job_logs` (
	`id` char(36) NOT NULL,
	`job_key` varchar(100) NOT NULL,
	`job_name` varchar(255) NOT NULL,
	`status` varchar(50) NOT NULL,
	`message` text,
	`duration_ms` int DEFAULT 0,
	`executed_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `cron_job_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`type` varchar(255) NOT NULL DEFAULT 'general',
	`created_by` varchar(255) NOT NULL DEFAULT 'system',
	`channel_id` char(36),
	`target_type` varchar(255) NOT NULL,
	`target_ids` json,
	`status` varchar(255) NOT NULL DEFAULT 'draft',
	`sent_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `otp_verifications` (
	`id` char(36) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`otp_code` varchar(6) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`is_used` boolean DEFAULT false,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `otp_verifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `panel_config` (
	`id` char(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`tagline` varchar(255),
	`description` text,
	`logo` varchar(255),
	`logo2` varchar(255),
	`favicon` varchar(255),
	`default_language` varchar(5) DEFAULT 'en',
	`supported_languages` json,
	`company_name` varchar(255),
	`company_website` varchar(255),
	`support_email` varchar(255),
	`currency` varchar(10) DEFAULT 'INR',
	`country` varchar(2) DEFAULT 'IN',
	`embedded_signup_enabled` boolean DEFAULT true,
	`public_origin` text,
	`appearance_config` json,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `panel_config_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `platform_access_levels` (
	`id` char(36) NOT NULL,
	`level_number` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` text,
	`badge_color` varchar(50) DEFAULT 'blue',
	`max_channels` int DEFAULT 1,
	`max_contacts` int DEFAULT 500,
	`max_messages_monthly` int DEFAULT 1000,
	`max_campaigns` int DEFAULT 5,
	`ai_assistant_enabled` boolean DEFAULT true,
	`sms_enabled` boolean DEFAULT false,
	`email_enabled` boolean DEFAULT false,
	`priority_support` boolean DEFAULT false,
	`api_access` boolean DEFAULT false,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_access_levels_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_access_levels_level_number_unique` UNIQUE(`level_number`)
);
--> statement-breakpoint
CREATE TABLE `platform_languages` (
	`id` char(36) NOT NULL,
	`code` varchar(10) NOT NULL,
	`name` varchar(100) NOT NULL,
	`native_name` varchar(100) NOT NULL,
	`icon` varchar(10),
	`direction` varchar(3) NOT NULL DEFAULT 'ltr',
	`is_enabled` boolean NOT NULL DEFAULT true,
	`is_default` boolean NOT NULL DEFAULT false,
	`translations` json,
	`sort_order` int DEFAULT 0,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_languages_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_languages_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `policy_pages` (
	`id` char(36) NOT NULL,
	`title` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`content` text NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`is_published` boolean DEFAULT true,
	`is_system` boolean DEFAULT false,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `policy_pages_id` PRIMARY KEY(`id`),
	CONSTRAINT `policy_pages_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `sent_notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`notification_id` int NOT NULL,
	`user_id` varchar(255),
	`is_read` boolean DEFAULT false,
	`read_at` datetime(3),
	`sent_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sent_notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `system_configurations` (
	`id` char(36) NOT NULL DEFAULT 'default',
	`site_title` varchar(255) DEFAULT 'Cortesys',
	`timezone` varchar(255) DEFAULT 'UTC',
	`currency` varchar(255) DEFAULT 'USD',
	`currency_symbol` varchar(255) DEFAULT '$',
	`site_base_color` varchar(255) DEFAULT '#16a34a',
	`records_per_page` int DEFAULT 20,
	`currency_display_mode` varchar(255) DEFAULT 'both',
	`home_default_service` varchar(255) DEFAULT 'whatsapp_marketing',
	`referral_commission` double DEFAULT 10,
	`logo` text,
	`favicon` text,
	`user_registration` boolean DEFAULT true,
	`force_ssl` boolean DEFAULT false,
	`agree_policy` boolean DEFAULT true,
	`force_secure_password` boolean DEFAULT true,
	`kyc_verification` boolean DEFAULT false,
	`email_verification` boolean DEFAULT false,
	`email_notification` boolean DEFAULT true,
	`mobile_verification` boolean DEFAULT false,
	`sms_notification` boolean DEFAULT true,
	`push_notification` boolean DEFAULT true,
	`post_auto_approval` boolean DEFAULT true,
	`language_option` boolean DEFAULT true,
	`global_email_template` text,
	`global_sms_template` text,
	`global_push_template` text,
	`smtp_settings` json,
	`sms_settings` json,
	`push_settings` json,
	`seo_settings` json,
	`frontend_settings` json,
	`extension_settings` json,
	`maintenance_mode` json,
	`gdpr_cookie` json,
	`custom_css` text,
	`robots_txt` text,
	`sitemap_xml` text,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `system_configurations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `access_level` int;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sent_notifications` ADD CONSTRAINT `sent_notifications_notification_id_notifications_id_fk` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `notifications_channel_idx` ON `notifications` (`channel_id`);