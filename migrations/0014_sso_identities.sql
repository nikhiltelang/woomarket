CREATE TABLE `user_identities` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`provider` varchar(20) NOT NULL,
	`subject` varchar(255) NOT NULL,
	`email` varchar(255),
	`last_login_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_identities_provider_subject` UNIQUE(`provider`,`subject`)
);
--> statement-breakpoint
ALTER TABLE `user_identities` ADD CONSTRAINT `user_identities_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `user_identities_user_idx` ON `user_identities` (`user_id`);