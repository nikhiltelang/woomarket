CREATE TABLE `request_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`request_id` varchar(64) NOT NULL,
	`method` varchar(10) NOT NULL,
	`path` varchar(500) NOT NULL,
	`query` json,
	`status_code` int NOT NULL,
	`aborted` boolean NOT NULL DEFAULT false,
	`user_id` char(36),
	`username` varchar(255),
	`role` varchar(20),
	`ip` varchar(64),
	`user_agent` varchar(500),
	`request_headers` json,
	`request_body` mediumtext,
	`request_size` int,
	`response_headers` json,
	`response_body` mediumtext,
	`response_size` int,
	`requested_at` datetime(3) NOT NULL,
	`responded_at` datetime(3) NOT NULL,
	`duration_ms` double NOT NULL,
	CONSTRAINT `request_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `system_configurations` ADD `request_log_settings` json;--> statement-breakpoint
CREATE INDEX `request_logs_requested_idx` ON `request_logs` (`requested_at`);--> statement-breakpoint
CREATE INDEX `request_logs_status_idx` ON `request_logs` (`status_code`,`requested_at`);--> statement-breakpoint
CREATE INDEX `request_logs_user_idx` ON `request_logs` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `request_logs_request_id_idx` ON `request_logs` (`request_id`);