CREATE TABLE `session_afk_periods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`session_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_afk_periods_event_id_unique` ON `session_afk_periods` (`event_id`);--> statement-breakpoint
CREATE INDEX `session_afk_periods_session_idx` ON `session_afk_periods` (`session_id`);--> statement-breakpoint
CREATE TABLE `session_heartbeats` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`at` text NOT NULL,
	`region_id` integer NOT NULL,
	`world` integer NOT NULL,
	`world_types` text NOT NULL,
	`world_location` text,
	`world_activity` text,
	`idle` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_heartbeats_session_at_idx` ON `session_heartbeats` (`session_id`,`at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`end_reason` text,
	`world` integer,
	`last_heartbeat_at` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`afk_seconds` integer NOT NULL,
	`active_seconds` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_account_started_idx` ON `sessions` (`account_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_open_heartbeat_idx` ON `sessions` (`last_heartbeat_at`) WHERE "sessions"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `events_session_type_occurred_idx` ON `events` (`session_id`,`type`,`occurred_at`,`event_id`);