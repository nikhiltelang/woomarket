CREATE TABLE `email_suppressions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` char(36),
	`email` varchar(320) NOT NULL,
	`reason` varchar(20) NOT NULL,
	`detail` text,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `email_suppressions_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_suppressions_user_email_unique` UNIQUE(`user_id`,`email`)
);
--> statement-breakpoint
ALTER TABLE `email_campaign_recipients` ADD `message_id` varchar(255);--> statement-breakpoint
ALTER TABLE `smtp_config` ADD `provider` varchar(20) DEFAULT 'smtp' NOT NULL;--> statement-breakpoint
ALTER TABLE `smtp_config` ADD `region` varchar(30);--> statement-breakpoint
ALTER TABLE `smtp_config` ADD `configuration_set` varchar(64);--> statement-breakpoint
ALTER TABLE `smtp_config` ADD `sns_topic_arn` varchar(255);--> statement-breakpoint
ALTER TABLE `email_suppressions` ADD CONSTRAINT `email_suppressions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `email_recipients_message_idx` ON `email_campaign_recipients` (`message_id`);