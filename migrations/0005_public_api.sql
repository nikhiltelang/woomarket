CREATE TABLE `api_idempotency_keys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`api_key_id` char(36) NOT NULL,
	`idempotency_key` varchar(255) NOT NULL,
	`request_hash` char(64) NOT NULL,
	`status_code` int NOT NULL,
	`response` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `api_idempotency_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_idempotency_key_unique` UNIQUE(`api_key_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`created_by` char(36),
	`name` varchar(100) NOT NULL,
	`access_key_id` varchar(32) NOT NULL,
	`secret_hash` char(64) NOT NULL,
	`secret_encrypted` text NOT NULL,
	`secret_last4` varchar(4) NOT NULL,
	`channels` json NOT NULL,
	`default_channel_id` char(36),
	`status` varchar(20) NOT NULL DEFAULT 'active',
	`expires_at` datetime(3),
	`last_used_at` datetime(3),
	`last_used_ip` varchar(64),
	`request_count` int NOT NULL DEFAULT 0,
	`revoked_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_keys_access_key_id_unique` UNIQUE(`access_key_id`)
);
--> statement-breakpoint
CREATE TABLE `api_used_signatures` (
	`signature` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `api_used_signatures_signature` PRIMARY KEY(`signature`)
);
--> statement-breakpoint
ALTER TABLE `api_idempotency_keys` ADD CONSTRAINT `api_idempotency_keys_api_key_id_api_keys_id_fk` FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_default_channel_id_channels_id_fk` FOREIGN KEY (`default_channel_id`) REFERENCES `channels`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `api_idempotency_created_idx` ON `api_idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE INDEX `api_used_signatures_expires_idx` ON `api_used_signatures` (`expires_at`);