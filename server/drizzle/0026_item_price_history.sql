CREATE TABLE `item_price_history` (
	`fetched_at` text NOT NULL,
	`item_id` integer NOT NULL,
	`high` integer,
	`low` integer,
	`seq` integer NOT NULL,
	PRIMARY KEY(`fetched_at`, `item_id`)
);
