ALTER TABLE `channels` ADD `business_id` varchar(40);--> statement-breakpoint
ALTER TABLE `channels` ADD `two_step_pin` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `onboarding` json;