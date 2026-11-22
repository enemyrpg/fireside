CREATE TABLE `item_icons` (
	`item_id` integer PRIMARY KEY NOT NULL,
	`png` blob NOT NULL,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`updated_at` text NOT NULL
);
