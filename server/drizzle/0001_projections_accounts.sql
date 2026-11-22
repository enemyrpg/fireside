CREATE TABLE `account_ids` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_ids_account_hash_unique` ON `account_ids` (`account_hash`);--> statement-breakpoint
CREATE TABLE `account_names` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`display_name` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`first_event_id` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_names_account_first_seen_idx` ON `account_names` (`account_id`,`first_seen_at`,`first_event_id`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY NOT NULL,
	`account_hash` text NOT NULL,
	`account_type` text,
	`display_name` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_account_hash_unique` ON `accounts` (`account_hash`);--> statement-breakpoint
DROP INDEX `events_account_hash_idx`;--> statement-breakpoint
ALTER TABLE `events` ADD `processed_at` text;--> statement-breakpoint
ALTER TABLE `events` ADD `projection_error` text;--> statement-breakpoint
CREATE INDEX `events_account_type_occurred_idx` ON `events` (`account_hash`,`type`,`occurred_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `events_account_occurred_idx` ON `events` (`account_hash`,`occurred_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `events_unprocessed_idx` ON `events` (`event_id`) WHERE "events"."processed_at" IS NULL;