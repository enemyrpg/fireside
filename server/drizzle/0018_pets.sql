CREATE TABLE `account_pets` (
	`account_id` integer NOT NULL,
	`pet_item_id` integer NOT NULL,
	`name` text NOT NULL,
	`obtained_at` text,
	`approximate` integer NOT NULL,
	`source_type` text,
	`source_name` text,
	`confirmed` integer NOT NULL,
	`origin` text NOT NULL,
	`event_id` text,
	PRIMARY KEY(`account_id`, `pet_item_id`),
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pet_drops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`message` text NOT NULL,
	`pet_item_id` integer,
	`pet_name` text,
	`source_type` text,
	`source_name` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pet_drops_event_id_unique` ON `pet_drops` (`event_id`);--> statement-breakpoint
CREATE INDEX `pet_drops_account_occurred_idx` ON `pet_drops` (`account_id`,`occurred_at`,`event_id`);