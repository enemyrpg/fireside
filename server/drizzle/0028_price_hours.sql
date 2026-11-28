DROP TABLE `item_price_history`;--> statement-breakpoint
DROP TABLE `item_prices`;--> statement-breakpoint
CREATE TABLE `price_day_hours` (
	`day` text PRIMARY KEY NOT NULL,
	`hours` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `price_days` (
	`day` text NOT NULL,
	`item_id` integer NOT NULL,
	`high_value` integer NOT NULL,
	`high_volume` integer NOT NULL,
	`low_value` integer NOT NULL,
	`low_volume` integer NOT NULL,
	PRIMARY KEY(`day`, `item_id`)
);
--> statement-breakpoint
CREATE TABLE `price_hour_fetches` (
	`hour_start` text PRIMARY KEY NOT NULL,
	`fetched_at` text NOT NULL,
	`items` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `price_hours` (
	`hour_start` text NOT NULL,
	`item_id` integer NOT NULL,
	`high_value` integer NOT NULL,
	`high_volume` integer NOT NULL,
	`low_value` integer NOT NULL,
	`low_volume` integer NOT NULL,
	PRIMARY KEY(`hour_start`, `item_id`)
);
--> statement-breakpoint
CREATE TABLE `price_hour_failures` (
	`hour_start` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`last_failed_at` text NOT NULL,
	`skipped_at` text
);
