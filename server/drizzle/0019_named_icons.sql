CREATE TABLE `named_icons` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`png` blob NOT NULL,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`kind`, `key`)
);
