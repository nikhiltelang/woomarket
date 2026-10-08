CREATE TABLE `payments` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`plan_id` char(36),
	`plan_name` varchar(255) NOT NULL,
	`billing_cycle` varchar(10) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`price` decimal(12,2) NOT NULL,
	`discount` decimal(12,2) NOT NULL DEFAULT '0',
	`credit` decimal(12,2) NOT NULL DEFAULT '0',
	`tax` decimal(12,2) NOT NULL DEFAULT '0',
	`tax_rate` decimal(5,2) NOT NULL DEFAULT '0',
	`tax_label` varchar(30),
	`total` decimal(12,2) NOT NULL,
	`coupon_code` varchar(40),
	`provider` varchar(12) NOT NULL,
	`provider_ref` varchar(255),
	`provider_payment_id` varchar(255),
	`status` varchar(12) NOT NULL DEFAULT 'pending',
	`failure_reason` varchar(500),
	`subscription_id` char(36),
	`invoice_year` int,
	`invoice_seq` int,
	`invoice_number` varchar(30),
	`billed_to` json,
	`paid_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_invoice_unique` UNIQUE(`invoice_year`,`invoice_seq`)
);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `payment_id` char(36);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `reminder_stage` varchar(10);--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_plan_id_plans_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `payments_user_idx` ON `payments` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `payments_ref_idx` ON `payments` (`provider`,`provider_ref`);--> statement-breakpoint
CREATE INDEX `payments_status_idx` ON `payments` (`status`,`created_at`);