CREATE TABLE `ai_usage` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`actor_id` char(36),
	`feature` varchar(40) NOT NULL,
	`model` varchar(80) NOT NULL,
	`input_tokens` int NOT NULL DEFAULT 0,
	`output_tokens` int NOT NULL DEFAULT 0,
	`simulated` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ai_usage_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `ai_insights` json;--> statement-breakpoint
ALTER TABLE `conversations` ADD `ai_analyzed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `ai_usage` ADD CONSTRAINT `ai_usage_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ai_usage_user_created_idx` ON `ai_usage` (`user_id`,`created_at`);