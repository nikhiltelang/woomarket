CREATE TABLE `tenant_settings` (
	`user_id` char(36) NOT NULL,
	`sending` json,
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenant_settings_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `delivery` json;--> statement-breakpoint
ALTER TABLE `email_campaign_recipients` ADD `send_after` datetime(3);--> statement-breakpoint
ALTER TABLE `email_campaigns` ADD `delivery` json;--> statement-breakpoint
ALTER TABLE `sms_campaign_recipients` ADD `send_after` datetime(3);--> statement-breakpoint
ALTER TABLE `sms_campaigns` ADD `delivery` json;--> statement-breakpoint
ALTER TABLE `tenant_settings` ADD CONSTRAINT `tenant_settings_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;