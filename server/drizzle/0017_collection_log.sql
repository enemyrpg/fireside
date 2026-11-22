CREATE TABLE `account_clog_sources` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`enabled` integer NOT NULL,
	`enabled_at` text NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	`last_changed_at` text,
	`status` text,
	`verified_name_period` text,
	`feed_synced_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `clog_feed_times` (
	`account_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`obtained_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `item_id`),
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `clog_items` (
	`account_id` integer NOT NULL,
	`tab_position` integer NOT NULL,
	`page_position` integer NOT NULL,
	`position` integer NOT NULL,
	`tab` text NOT NULL,
	`page` text NOT NULL,
	`item_id` integer NOT NULL,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	PRIMARY KEY(`account_id`, `tab_position`, `page_position`, `position`),
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `clog_obtained` (
	`account_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`first_seen_at` text,
	`approximate` integer NOT NULL,
	`snapshot_id` integer NOT NULL,
	PRIMARY KEY(`account_id`, `item_id`),
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `external_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `clog_snapshots` (
	`snapshot_id` integer PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`source` text NOT NULL,
	`taken_at` text NOT NULL,
	`obtained` integer NOT NULL,
	`total` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `external_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `clog_snapshots_account_idx` ON `clog_snapshots` (`account_id`,`snapshot_id`);--> statement-breakpoint
CREATE TABLE `external_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`account_id` integer NOT NULL,
	`fetched_at` text NOT NULL,
	`content_hash` text NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `external_snapshots_account_kind_idx` ON `external_snapshots` (`account_id`,`kind`,`id`);