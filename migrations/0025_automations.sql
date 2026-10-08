CREATE TABLE `automation_runs` (
	`id` char(36) NOT NULL,
	`automation_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`contact_id` char(36) NOT NULL,
	`status` varchar(12) NOT NULL DEFAULT 'active',
	`current_step_id` varchar(40),
	`next_run_at` datetime(3),
	`locked_until` datetime(3),
	`context` json,
	`last_error` varchar(500),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automation_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `automation_step_logs` (
	`id` char(36) NOT NULL,
	`run_id` char(36) NOT NULL,
	`automation_id` char(36) NOT NULL,
	`step_id` varchar(40) NOT NULL,
	`outcome` varchar(10) NOT NULL,
	`detail` varchar(300),
	`ref_id` char(36),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automation_step_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `automations` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` varchar(500),
	`status` varchar(12) NOT NULL DEFAULT 'draft',
	`trigger` json NOT NULL,
	`steps` json NOT NULL,
	`reentry` varchar(12) NOT NULL DEFAULT 'never',
	`step_campaigns` json,
	`enrolled_count` int NOT NULL DEFAULT 0,
	`completed_count` int NOT NULL DEFAULT 0,
	`last_date_run` varchar(10),
	`activated_at` datetime(3),
	`created_by` char(36),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `automation_id` char(36);--> statement-breakpoint
ALTER TABLE `email_campaigns` ADD `automation_id` char(36);--> statement-breakpoint
ALTER TABLE `sms_campaigns` ADD `automation_id` char(36);--> statement-breakpoint
ALTER TABLE `automation_runs` ADD CONSTRAINT `automation_runs_automation_id_automations_id_fk` FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD CONSTRAINT `automation_runs_contact_id_contacts_id_fk` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `automation_step_logs` ADD CONSTRAINT `automation_step_logs_run_id_automation_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `automations` ADD CONSTRAINT `automations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `automation_runs_due_idx` ON `automation_runs` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_flow_contact_idx` ON `automation_runs` (`automation_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `automation_runs_contact_idx` ON `automation_runs` (`contact_id`);--> statement-breakpoint
CREATE INDEX `automation_step_logs_flow_idx` ON `automation_step_logs` (`automation_id`,`step_id`);--> statement-breakpoint
CREATE INDEX `automation_step_logs_run_idx` ON `automation_step_logs` (`run_id`);--> statement-breakpoint
CREATE INDEX `automations_user_idx` ON `automations` (`user_id`,`status`);