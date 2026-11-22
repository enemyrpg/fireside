CREATE TABLE `weekly_summaries` (
	`account_id` integer NOT NULL,
	`iso_week` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`data` text NOT NULL,
	`computed_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `iso_week`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `weekly_summaries_account_end_idx` ON `weekly_summaries` (`account_id`,`end`);