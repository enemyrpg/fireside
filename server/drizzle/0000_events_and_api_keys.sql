CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`account_hash` text NOT NULL,
	`session_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`received_at` text NOT NULL,
	`api_key_id` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_occurred_at_idx` ON `events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `events_account_hash_idx` ON `events` (`account_hash`);