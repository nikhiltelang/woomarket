ALTER TABLE `api_logs` DROP FOREIGN KEY `api_logs_channel_id_channels_id_fk`;
--> statement-breakpoint
ALTER TABLE `message_queue` DROP FOREIGN KEY `message_queue_campaign_id_campaigns_id_fk`;
--> statement-breakpoint
ALTER TABLE `message_queue` DROP FOREIGN KEY `message_queue_channel_id_channels_id_fk`;
--> statement-breakpoint
ALTER TABLE `api_logs` ADD CONSTRAINT `api_logs_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_queue` ADD CONSTRAINT `message_queue_campaign_id_campaigns_id_fk` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_queue` ADD CONSTRAINT `message_queue_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;