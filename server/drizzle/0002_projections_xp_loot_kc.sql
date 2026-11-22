CREATE TABLE `kc_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`boss` text NOT NULL,
	`kill_count` integer NOT NULL,
	`time_seconds` real,
	`personal_best` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kc_observations_event_id_unique` ON `kc_observations` (`event_id`);--> statement-breakpoint
CREATE INDEX `kc_observations_account_boss_observed_idx` ON `kc_observations` (`account_id`,`boss`,`observed_at`);--> statement-breakpoint
CREATE INDEX `kc_observations_session_idx` ON `kc_observations` (`session_id`);--> statement-breakpoint
CREATE TABLE `loot_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`source_type` text NOT NULL,
	`source_name` text,
	`source_npc_id` integer,
	`kill_count` integer,
	`total_ge_value` integer NOT NULL,
	`total_ha_value` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loot_events_event_id_unique` ON `loot_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `loot_events_account_occurred_idx` ON `loot_events` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `loot_events_session_idx` ON `loot_events` (`session_id`);--> statement-breakpoint
CREATE TABLE `loot_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`loot_event_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`item_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`ge_price_each` integer NOT NULL,
	`ha_price_each` integer NOT NULL,
	FOREIGN KEY (`loot_event_id`) REFERENCES `loot_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `loot_items_loot_event_idx` ON `loot_items` (`loot_event_id`);--> statement-breakpoint
CREATE TABLE `xp_snapshot_skills` (
	`snapshot_id` integer NOT NULL,
	`skill` text NOT NULL,
	`xp` integer NOT NULL,
	`level` integer NOT NULL,
	PRIMARY KEY(`snapshot_id`, `skill`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `xp_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `xp_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`event_id` text NOT NULL,
	`session_id` text NOT NULL,
	`taken_at` text NOT NULL,
	`reason` text NOT NULL,
	`total_xp` integer NOT NULL,
	`total_level` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `xp_snapshots_event_id_unique` ON `xp_snapshots` (`event_id`);--> statement-breakpoint
CREATE INDEX `xp_snapshots_account_taken_idx` ON `xp_snapshots` (`account_id`,`taken_at`);--> statement-breakpoint
CREATE INDEX `xp_snapshots_session_idx` ON `xp_snapshots` (`session_id`);