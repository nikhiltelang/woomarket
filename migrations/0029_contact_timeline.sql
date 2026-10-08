CREATE TABLE `contact_notes` (
	`id` char(36) NOT NULL,
	`contact_id` char(36) NOT NULL,
	`user_id` char(36),
	`body` text NOT NULL,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `contact_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `contact_notes` ADD CONSTRAINT `contact_notes_contact_id_contacts_id_fk` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contact_notes` ADD CONSTRAINT `contact_notes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `contact_notes_contact_idx` ON `contact_notes` (`contact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_recipients_contact_idx` ON `email_campaign_recipients` (`contact_id`);--> statement-breakpoint
CREATE INDEX `sms_recipients_contact_idx` ON `sms_campaign_recipients` (`contact_id`);--> statement-breakpoint
CREATE INDEX `activity_entity_idx` ON `user_activity_logs` (`entity_id`);