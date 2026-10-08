CREATE TABLE `chat_widgets` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`channel_id` char(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`settings` json NOT NULL,
	`allowed_origins` json NOT NULL,
	`created_by` char(36),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `chat_widgets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD CONSTRAINT `chat_widgets_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD CONSTRAINT `chat_widgets_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_widgets` ADD CONSTRAINT `chat_widgets_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `chat_widgets_user_idx` ON `chat_widgets` (`user_id`);