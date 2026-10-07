CREATE TABLE `segments` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` text,
	`rules` json NOT NULL,
	`last_count` int,
	`last_counted_at` datetime(3),
	`created_by` char(36),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `segments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `segment_id` char(36);--> statement-breakpoint
ALTER TABLE `email_campaigns` ADD `target_segment_id` char(36);--> statement-breakpoint
ALTER TABLE `sms_campaigns` ADD `target_segment_id` char(36);--> statement-breakpoint
ALTER TABLE `segments` ADD CONSTRAINT `segments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `segments` ADD CONSTRAINT `segments_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `segments_user_idx` ON `segments` (`user_id`);