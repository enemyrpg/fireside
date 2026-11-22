CREATE TABLE `session_summaries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`xp_gained_total` integer NOT NULL,
	`xp_gained_by_skill` text NOT NULL,
	`loot_ge_value` integer NOT NULL,
	`loot_count` integer NOT NULL,
	`kc_gained_by_boss` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `kc_observations_session_idx`;--> statement-breakpoint
DROP INDEX `kc_observations_account_boss_observed_idx`;--> statement-breakpoint
CREATE INDEX `kc_observations_session_boss_observed_idx` ON `kc_observations` (`session_id`,`boss`,`observed_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `kc_observations_session_boss_kc_idx` ON `kc_observations` (`session_id`,`boss`,`kill_count`);--> statement-breakpoint
CREATE INDEX `kc_observations_account_boss_observed_idx` ON `kc_observations` (`account_id`,`boss`,`observed_at`,`event_id`);--> statement-breakpoint
DROP INDEX `xp_snapshots_session_idx`;--> statement-breakpoint
CREATE INDEX `xp_snapshots_session_taken_idx` ON `xp_snapshots` (`session_id`,`taken_at`,`event_id`);