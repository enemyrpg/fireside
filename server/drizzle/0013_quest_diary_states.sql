CREATE TABLE `diary_completions` (
	`account_id` integer NOT NULL,
	`region` text NOT NULL,
	`tier` text NOT NULL,
	`first_completed_at` text NOT NULL,
	`event_id` text NOT NULL,
	PRIMARY KEY(`account_id`, `region`, `tier`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `diary_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`taken_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diary_snapshots_event_id_unique` ON `diary_snapshots` (`event_id`);--> statement-breakpoint
CREATE INDEX `diary_snapshots_account_taken_idx` ON `diary_snapshots` (`account_id`,`taken_at`,`event_id`);--> statement-breakpoint
CREATE TABLE `diary_states` (
	`account_id` integer NOT NULL,
	`region` text NOT NULL,
	`tier` text NOT NULL,
	`completed` integer NOT NULL,
	PRIMARY KEY(`account_id`, `region`, `tier`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `quest_completions` (
	`account_id` integer NOT NULL,
	`quest` text NOT NULL,
	`first_finished_at` text NOT NULL,
	`event_id` text NOT NULL,
	PRIMARY KEY(`account_id`, `quest`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quest_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`taken_at` text NOT NULL,
	`quest_points` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quest_snapshots_event_id_unique` ON `quest_snapshots` (`event_id`);--> statement-breakpoint
CREATE INDEX `quest_snapshots_account_taken_idx` ON `quest_snapshots` (`account_id`,`taken_at`,`event_id`);--> statement-breakpoint
CREATE TABLE `quest_states` (
	`account_id` integer NOT NULL,
	`quest` text NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`kind` text,
	PRIMARY KEY(`account_id`, `quest`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
