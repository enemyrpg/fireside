CREATE TABLE `clog_reads` (
	`account_id` integer NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `read_at`),
	FOREIGN KEY (`account_id`) REFERENCES `account_ids`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `clog_obtained_account_first_seen_idx` ON `clog_obtained` (`account_id`,`first_seen_at`);