CREATE TABLE `report_schedules` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`sections` json NOT NULL,
	`frequency` varchar(10) NOT NULL,
	`day_of_week` int NOT NULL DEFAULT 1,
	`hour` int NOT NULL DEFAULT 8,
	`format` varchar(4) NOT NULL DEFAULT 'pdf',
	`recipients` json NOT NULL,
	`channel_id` char(36),
	`enabled` boolean NOT NULL DEFAULT true,
	`next_run_at` datetime(3),
	`last_run_at` datetime(3),
	`last_status` varchar(300),
	`created_by` char(36),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `report_schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `report_schedules` ADD CONSTRAINT `report_schedules_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_schedules` ADD CONSTRAINT `report_schedules_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `report_schedules_due_idx` ON `report_schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `report_schedules_user_idx` ON `report_schedules` (`user_id`);