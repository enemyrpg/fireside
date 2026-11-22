CREATE TABLE `pb_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`boss` text NOT NULL,
	`scope` text NOT NULL,
	`team_size` integer NOT NULL,
	`seconds` real NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pb_records_event_scope_team_size_idx` ON `pb_records` (`event_id`,`scope`,`team_size`);--> statement-breakpoint
CREATE INDEX `pb_records_account_boss_scope_idx` ON `pb_records` (`account_id`,`boss`,`scope`,`team_size`);