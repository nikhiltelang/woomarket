CREATE TABLE `user_two_factor` (
	`user_id` char(36) NOT NULL,
	`secret` text,
	`pending_secret` text,
	`recovery_codes` json,
	`last_used_step` bigint,
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_two_factor_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `system_configurations` ADD `two_factor_policy` varchar(20) DEFAULT 'optional';--> statement-breakpoint
ALTER TABLE `users` ADD `two_factor_enabled_at` datetime(3);--> statement-breakpoint
ALTER TABLE `user_two_factor` ADD CONSTRAINT `user_two_factor_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;