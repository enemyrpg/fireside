CREATE TABLE `external_sources` (
	`source` text PRIMARY KEY NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	`last_error` text,
	`last_error_at` text
);
--> statement-breakpoint
CREATE TABLE `item_prices` (
	`item_id` integer PRIMARY KEY NOT NULL,
	`high` integer,
	`high_time` text,
	`low` integer,
	`low_time` text,
	`fetched_at` text NOT NULL
);
