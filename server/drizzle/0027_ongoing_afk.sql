CREATE TABLE `projection_versions` (
	`name` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_afk_estimates` (
	`session_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `started_at`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
