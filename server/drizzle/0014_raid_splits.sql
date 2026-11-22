CREATE TABLE `raid_drop_choices` (
	`event_id` text NOT NULL,
	`item_index` integer NOT NULL,
	`mode` text,
	`own_value` integer,
	`party_size` integer,
	`nickname` text,
	`note` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `item_index`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `raid_manual_drops` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`raid` text NOT NULL,
	`raid_group` text NOT NULL,
	`item_id` integer NOT NULL,
	`item_name` text NOT NULL,
	`ge_price_each` integer,
	`ge_price_source` text,
	`ge_price_at` text,
	`mode` text,
	`own_value` integer,
	`party_size` integer,
	`nickname` text,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `raid_manual_drops_account_occurred_idx` ON `raid_manual_drops` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `raid_split_defaults` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action
);
