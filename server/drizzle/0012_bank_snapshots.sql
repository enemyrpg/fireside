CREATE TABLE `bank_snapshot_items` (
	`snapshot_id` integer NOT NULL,
	`position` integer NOT NULL,
	`tab` integer NOT NULL,
	`item_id` integer NOT NULL,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	`placeholder` integer NOT NULL,
	`ge_each` integer NOT NULL,
	`ha_each` integer NOT NULL,
	PRIMARY KEY(`snapshot_id`, `position`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `bank_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bank_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`taken_at` text NOT NULL,
	`content_hash` text NOT NULL,
	`tab_sizes` text NOT NULL,
	`total_ge` integer NOT NULL,
	`total_ha` integer NOT NULL,
	`inventory_ge` integer NOT NULL,
	`inventory_ha` integer NOT NULL,
	`equipment_ge` integer NOT NULL,
	`equipment_ha` integer NOT NULL,
	`cash` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_snapshots_event_id_unique` ON `bank_snapshots` (`event_id`);--> statement-breakpoint
CREATE INDEX `bank_snapshots_account_taken_idx` ON `bank_snapshots` (`account_id`,`taken_at`,`event_id`);--> statement-breakpoint
CREATE TABLE `container_snapshot_items` (
	`snapshot_id` integer NOT NULL,
	`container` text NOT NULL,
	`position` integer NOT NULL,
	`slot` text,
	`item_id` integer NOT NULL,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	`ge_each` integer NOT NULL,
	`ha_each` integer NOT NULL,
	PRIMARY KEY(`snapshot_id`, `container`, `position`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `bank_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `potion_storage_items` (
	`snapshot_id` integer NOT NULL,
	`position` integer NOT NULL,
	`potion` text NOT NULL,
	`item_id` integer NOT NULL,
	`doses` integer NOT NULL,
	`item_doses` integer NOT NULL,
	`ge_each` integer NOT NULL,
	`ha_each` integer NOT NULL,
	PRIMARY KEY(`snapshot_id`, `position`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `potion_storage_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `potion_storage_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`taken_at` text NOT NULL,
	`content_hash` text NOT NULL,
	`total_ge` integer NOT NULL,
	`total_ha` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `potion_storage_snapshots_event_id_unique` ON `potion_storage_snapshots` (`event_id`);--> statement-breakpoint
CREATE INDEX `potion_storage_snapshots_account_taken_idx` ON `potion_storage_snapshots` (`account_id`,`taken_at`,`event_id`);