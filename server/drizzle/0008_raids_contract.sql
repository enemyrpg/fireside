CREATE TABLE `raid_special_loot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`raid` text NOT NULL,
	`raid_group` text NOT NULL,
	`item_id` integer NOT NULL,
	`item_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`ge_price_each` integer NOT NULL,
	`recipient` text NOT NULL,
	`team_size` integer,
	`kill_count` integer,
	`special_event_id` text,
	`loot_event_id` text,
	`loot_item_position` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`special_event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`loot_event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raid_special_loot_special_event_id_unique` ON `raid_special_loot` (`special_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `raid_special_loot_loot_item_idx` ON `raid_special_loot` (`loot_event_id`,`loot_item_position`);--> statement-breakpoint
CREATE INDEX `raid_special_loot_account_occurred_idx` ON `raid_special_loot` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `raid_special_loot_session_idx` ON `raid_special_loot` (`session_id`);--> statement-breakpoint
ALTER TABLE `kc_observations` ADD `team_size` integer;