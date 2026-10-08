CREATE TABLE `social_accounts` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`channel_id` char(36) NOT NULL,
	`platform` varchar(12) NOT NULL,
	`page_id` varchar(40) NOT NULL,
	`external_id` varchar(40) NOT NULL,
	`name` varchar(200) NOT NULL,
	`username` varchar(100),
	`picture_url` varchar(1000),
	`access_token` text NOT NULL,
	`simulated` boolean NOT NULL DEFAULT false,
	`human_agent_tag` boolean NOT NULL DEFAULT false,
	`enabled` boolean NOT NULL DEFAULT true,
	`status` varchar(20) NOT NULL DEFAULT 'connected',
	`last_error` varchar(500),
	`connected_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `social_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `social_accounts_platform_external` UNIQUE(`platform`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `social_account_id` char(36);--> statement-breakpoint
ALTER TABLE `social_accounts` ADD CONSTRAINT `social_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_accounts` ADD CONSTRAINT `social_accounts_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `social_accounts_user_idx` ON `social_accounts` (`user_id`);