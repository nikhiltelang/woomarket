CREATE TABLE `link_clicks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`link_id` int NOT NULL,
	`recipient_id` char(36) NOT NULL,
	`contact_id` varchar(36),
	`ip` varchar(64),
	`user_agent` varchar(300),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `link_clicks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `short_links` (
	`code` varchar(12) NOT NULL,
	`link_id` int NOT NULL,
	`recipient_id` char(36) NOT NULL,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `short_links_code` PRIMARY KEY(`code`)
);
--> statement-breakpoint
CREATE TABLE `tracked_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`campaign_type` varchar(10) NOT NULL,
	`campaign_id` char(36) NOT NULL,
	`original_url` text NOT NULL,
	`url` text NOT NULL,
	`position` int NOT NULL,
	`clicks` int NOT NULL DEFAULT 0,
	`unique_clicks` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tracked_links_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `email_campaigns` MODIFY COLUMN `content_html` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `email_campaigns` MODIFY COLUMN `content_text` mediumtext;--> statement-breakpoint
ALTER TABLE `email_templates` MODIFY COLUMN `content_html` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `email_templates` MODIFY COLUMN `content_text` mediumtext;--> statement-breakpoint
ALTER TABLE `email_campaign_recipients` ADD `clicked_at` datetime(3);--> statement-breakpoint
ALTER TABLE `email_campaigns` ADD `track_clicks` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `email_campaigns` ADD `utm` json;--> statement-breakpoint
ALTER TABLE `sms_campaign_recipients` ADD `clicked_at` datetime(3);--> statement-breakpoint
ALTER TABLE `sms_campaigns` ADD `clicked_count` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sms_campaigns` ADD `track_clicks` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sms_campaigns` ADD `utm` json;--> statement-breakpoint
ALTER TABLE `link_clicks` ADD CONSTRAINT `link_clicks_link_id_tracked_links_id_fk` FOREIGN KEY (`link_id`) REFERENCES `tracked_links`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `short_links` ADD CONSTRAINT `short_links_link_id_tracked_links_id_fk` FOREIGN KEY (`link_id`) REFERENCES `tracked_links`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `link_clicks_link_idx` ON `link_clicks` (`link_id`);--> statement-breakpoint
CREATE INDEX `link_clicks_recipient_idx` ON `link_clicks` (`recipient_id`);--> statement-breakpoint
CREATE INDEX `link_clicks_contact_idx` ON `link_clicks` (`contact_id`);--> statement-breakpoint
CREATE INDEX `tracked_links_campaign_idx` ON `tracked_links` (`campaign_type`,`campaign_id`);