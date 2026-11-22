-- Hand-edited: `position` is NOT NULL without a default, so `loot_items` is
-- rebuilt (the pattern drizzle-kit uses for such changes). Existing items were
-- inserted in payload order, so `id` order within a loot event is the payload
-- order. IDs are kept.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_loot_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`loot_event_id` integer NOT NULL,
	`position` integer NOT NULL,
	`item_id` integer NOT NULL,
	`item_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`ge_price_each` integer NOT NULL,
	`ha_price_each` integer NOT NULL,
	FOREIGN KEY (`loot_event_id`) REFERENCES `loot_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_loot_items` (`id`, `loot_event_id`, `position`, `item_id`, `item_name`, `quantity`, `ge_price_each`, `ha_price_each`)
SELECT `id`, `loot_event_id`, row_number() OVER (PARTITION BY `loot_event_id` ORDER BY `id`) - 1, `item_id`, `item_name`, `quantity`, `ge_price_each`, `ha_price_each`
FROM `loot_items`;--> statement-breakpoint
DROP TABLE `loot_items`;--> statement-breakpoint
ALTER TABLE `__new_loot_items` RENAME TO `loot_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `loot_items_loot_event_position_idx` ON `loot_items` (`loot_event_id`,`position`);--> statement-breakpoint
DROP INDEX `loot_events_account_occurred_idx`;--> statement-breakpoint
CREATE INDEX `loot_events_occurred_idx` ON `loot_events` (`occurred_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `loot_events_account_occurred_idx` ON `loot_events` (`account_id`,`occurred_at`,`event_id`);
