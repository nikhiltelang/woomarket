CREATE TABLE `email_campaign_recipients` (
	`id` char(36) NOT NULL,
	`campaign_id` char(36) NOT NULL,
	`contact_id` varchar(255),
	`email` text NOT NULL,
	`name` text,
	`status` varchar(255) DEFAULT 'pending',
	`sent_at` datetime(3),
	`delivered_at` datetime(3),
	`opened_at` datetime(3),
	`error_message` text,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `email_campaign_recipients_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_campaigns` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`channel_id` varchar(255),
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`preview_text` text,
	`sender_name` text,
	`sender_email` text,
	`reply_to` text,
	`content_html` text NOT NULL,
	`content_text` text,
	`template_id` varchar(255),
	`target_audience` text,
	`target_group_id` varchar(255),
	`target_group_name` text,
	`csv_data` json,
	`status` varchar(255) DEFAULT 'draft',
	`scheduled_at` datetime(3),
	`sent_at` datetime(3),
	`total_recipients` int DEFAULT 0,
	`sent_count` int DEFAULT 0,
	`delivered_count` int DEFAULT 0,
	`opened_count` int DEFAULT 0,
	`clicked_count` int DEFAULT 0,
	`failed_count` int DEFAULT 0,
	`error_message` text,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `email_campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` char(36) NOT NULL,
	`user_id` char(36),
	`name` text NOT NULL,
	`category` text,
	`subject` text,
	`preview_text` text,
	`content_html` text NOT NULL,
	`content_text` text,
	`is_system` boolean DEFAULT false,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `email_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sms_campaign_recipients` (
	`id` char(36) NOT NULL,
	`campaign_id` char(36) NOT NULL,
	`contact_id` varchar(255),
	`phone` text NOT NULL,
	`name` text,
	`segments` int DEFAULT 1,
	`status` varchar(255) DEFAULT 'pending',
	`sent_at` datetime(3),
	`delivered_at` datetime(3),
	`message_id` text,
	`error_message` text,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sms_campaign_recipients_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sms_campaigns` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`channel_id` varchar(255),
	`name` text NOT NULL,
	`sender_id` text,
	`from_number` text,
	`message` text NOT NULL,
	`media_url` text,
	`gateway` text,
	`target_audience` text,
	`target_group_id` varchar(255),
	`target_group_name` text,
	`csv_data` json,
	`status` varchar(255) DEFAULT 'draft',
	`scheduled_at` datetime(3),
	`sent_at` datetime(3),
	`total_recipients` int DEFAULT 0,
	`sent_count` int DEFAULT 0,
	`delivered_count` int DEFAULT 0,
	`failed_count` int DEFAULT 0,
	`sms_segments_per_recipient` int DEFAULT 1,
	`estimated_credits` int DEFAULT 0,
	`error_message` text,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sms_campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sms_gateways` (
	`id` char(36) NOT NULL,
	`user_id` char(36),
	`provider` text NOT NULL,
	`account_sid` text,
	`auth_token` text,
	`from_number` text,
	`sender_id` text,
	`webhook_url` text,
	`is_active` boolean DEFAULT true,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sms_gateways_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `smtp_config` (
	`id` char(36) NOT NULL,
	`user_id` char(36),
	`host` text NOT NULL,
	`port` int NOT NULL,
	`secure` boolean DEFAULT false,
	`user` text NOT NULL,
	`password` text,
	`from_name` text NOT NULL,
	`from_email` text NOT NULL,
	`logo` text,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `smtp_config_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `email_campaign_recipients` ADD CONSTRAINT `email_campaign_recipients_campaign_id_email_campaigns_id_fk` FOREIGN KEY (`campaign_id`) REFERENCES `email_campaigns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_campaigns` ADD CONSTRAINT `email_campaigns_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_templates` ADD CONSTRAINT `email_templates_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sms_campaign_recipients` ADD CONSTRAINT `sms_campaign_recipients_campaign_id_sms_campaigns_id_fk` FOREIGN KEY (`campaign_id`) REFERENCES `sms_campaigns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sms_campaigns` ADD CONSTRAINT `sms_campaigns_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sms_gateways` ADD CONSTRAINT `sms_gateways_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `smtp_config` ADD CONSTRAINT `smtp_config_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `email_recipients_campaign_idx` ON `email_campaign_recipients` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `email_recipients_status_idx` ON `email_campaign_recipients` (`status`);--> statement-breakpoint
CREATE INDEX `email_campaigns_user_idx` ON `email_campaigns` (`user_id`);--> statement-breakpoint
CREATE INDEX `email_campaigns_status_idx` ON `email_campaigns` (`status`);--> statement-breakpoint
CREATE INDEX `sms_recipients_campaign_idx` ON `sms_campaign_recipients` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `sms_recipients_status_idx` ON `sms_campaign_recipients` (`status`);--> statement-breakpoint
CREATE INDEX `sms_campaigns_user_idx` ON `sms_campaigns` (`user_id`);--> statement-breakpoint
CREATE INDEX `sms_campaigns_status_idx` ON `sms_campaigns` (`status`);