CREATE TABLE `coupon_redemptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`coupon_id` int NOT NULL,
	`user_id` char(36) NOT NULL,
	`subscription_id` char(36),
	`discount` decimal(10,2) NOT NULL,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `coupon_redemptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `coupons` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`code` varchar(40) NOT NULL,
	`type` varchar(20) NOT NULL DEFAULT 'fixed',
	`discount_value` decimal(10,2) NOT NULL,
	`expiry_type` varchar(20) NOT NULL DEFAULT 'lifetime',
	`expires_at` datetime(3),
	`usage_limit` int NOT NULL DEFAULT -1,
	`used_count` int NOT NULL DEFAULT 0,
	`status` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `coupons_id` PRIMARY KEY(`id`),
	CONSTRAINT `coupons_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `support_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`type` varchar(20) NOT NULL,
	`message` text NOT NULL,
	`status` varchar(20) NOT NULL DEFAULT 'open',
	`admin_reply` text,
	`replied_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `support_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `amount` decimal(10,2);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `discount` decimal(10,2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `coupon_code` varchar(40);--> statement-breakpoint
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_coupon_id_coupons_id_fk` FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_requests` ADD CONSTRAINT `support_requests_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `coupon_redemptions_coupon_idx` ON `coupon_redemptions` (`coupon_id`);--> statement-breakpoint
CREATE INDEX `support_requests_user_idx` ON `support_requests` (`user_id`);--> statement-breakpoint
CREATE INDEX `support_requests_status_idx` ON `support_requests` (`status`);