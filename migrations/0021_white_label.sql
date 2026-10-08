CREATE TABLE `brand_domains` (
	`id` char(36) NOT NULL,
	`brand_id` char(36) NOT NULL,
	`domain` varchar(253) NOT NULL,
	`verification_token` varchar(64) NOT NULL,
	`verified_at` datetime(3),
	`last_checked_at` datetime(3),
	`last_error` varchar(300),
	`disabled` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `brand_domains_id` PRIMARY KEY(`id`),
	CONSTRAINT `brand_domains_domain_unique` UNIQUE(`domain`)
);
--> statement-breakpoint
CREATE TABLE `brands` (
	`id` char(36) NOT NULL,
	`owner_id` char(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`logo` varchar(255),
	`favicon` varchar(255),
	`base_color` varchar(7) NOT NULL DEFAULT '#16a34a',
	`support_email` varchar(255),
	`support_url` varchar(500),
	`login_title` varchar(120),
	`login_subtitle` varchar(300),
	`hide_powered_by` boolean NOT NULL DEFAULT false,
	`allow_signup` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `brands_id` PRIMARY KEY(`id`),
	CONSTRAINT `brands_owner_id_unique` UNIQUE(`owner_id`)
);
--> statement-breakpoint
ALTER TABLE `platform_access_levels` ADD `white_label` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `users` ADD `reseller_id` char(36);--> statement-breakpoint
ALTER TABLE `brand_domains` ADD CONSTRAINT `brand_domains_brand_id_brands_id_fk` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `brands` ADD CONSTRAINT `brands_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `brand_domains_brand_idx` ON `brand_domains` (`brand_id`);--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_reseller_id_users_id_fk` FOREIGN KEY (`reseller_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `users_reseller_idx` ON `users` (`reseller_id`);