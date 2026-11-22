DROP INDEX `xp_snapshots_account_taken_idx`;--> statement-breakpoint
CREATE INDEX `xp_snapshots_account_taken_idx` ON `xp_snapshots` (`account_id`,`taken_at`,`event_id`);