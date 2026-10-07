CREATE TABLE `webhook_deliveries` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`endpoint_id` char(36) NOT NULL,
	`event_id` char(36) NOT NULL,
	`event` varchar(50) NOT NULL,
	`payload` json NOT NULL,
	`status` varchar(12) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`next_attempt_at` datetime(3),
	`locked_until` datetime(3),
	`response_status` int,
	`response_body` varchar(2000),
	`error` varchar(500),
	`duration_ms` int,
	`delivered_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `webhook_deliveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`url` varchar(2000) NOT NULL,
	`description` varchar(200),
	`events` json NOT NULL,
	`secret` text NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`source` varchar(20) NOT NULL DEFAULT 'dashboard',
	`api_key_id` char(36),
	`consecutive_failures` int NOT NULL DEFAULT 0,
	`last_success_at` datetime(3),
	`last_failure_at` datetime(3),
	`disabled_reason` varchar(255),
	`created_by` char(36),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `webhook_endpoints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_endpoint_id_webhook_endpoints_id_fk` FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD CONSTRAINT `webhook_endpoints_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD CONSTRAINT `webhook_endpoints_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint_idx` ON `webhook_deliveries` (`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_endpoints_user_idx` ON `webhook_endpoints` (`user_id`);