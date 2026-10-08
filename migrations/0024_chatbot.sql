CREATE TABLE `chatbot_events` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`conversation_id` char(36),
	`rule_id` char(36),
	`channel` varchar(12) NOT NULL,
	`outcome` varchar(12) NOT NULL,
	`detail` varchar(300),
	`incoming_text` varchar(300),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `chatbot_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `chatbot_rules` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`priority` int NOT NULL DEFAULT 0,
	`channels` json,
	`trigger` json NOT NULL,
	`response` json NOT NULL,
	`actions` json,
	`cooldown_minutes` int NOT NULL DEFAULT 0,
	`times_triggered` int NOT NULL DEFAULT 0,
	`last_triggered_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `chatbot_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `bot_paused_until` datetime(3);--> statement-breakpoint
ALTER TABLE `tenant_settings` ADD `chatbot` json;--> statement-breakpoint
ALTER TABLE `chatbot_events` ADD CONSTRAINT `chatbot_events_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chatbot_events` ADD CONSTRAINT `chatbot_events_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chatbot_events` ADD CONSTRAINT `chatbot_events_rule_id_chatbot_rules_id_fk` FOREIGN KEY (`rule_id`) REFERENCES `chatbot_rules`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chatbot_rules` ADD CONSTRAINT `chatbot_rules_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `chatbot_events_user_idx` ON `chatbot_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chatbot_events_conv_idx` ON `chatbot_events` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chatbot_rules_user_idx` ON `chatbot_rules` (`user_id`,`priority`);