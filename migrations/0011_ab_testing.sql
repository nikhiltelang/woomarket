ALTER TABLE `campaign_recipients` ADD `variant` varchar(1);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `ab_test` json;--> statement-breakpoint
ALTER TABLE `email_campaign_recipients` ADD `variant` varchar(1);--> statement-breakpoint
ALTER TABLE `email_campaigns` ADD `ab_test` json;--> statement-breakpoint
ALTER TABLE `sms_campaign_recipients` ADD `variant` varchar(1);--> statement-breakpoint
ALTER TABLE `sms_campaigns` ADD `ab_test` json;