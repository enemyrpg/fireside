-- Task 9.5 (API keys): server-wide settings changed in the dashboard.
CREATE TABLE `server_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
