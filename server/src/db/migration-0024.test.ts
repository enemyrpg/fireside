import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsBefore, tempDir } from '../backup/testing.js';
import { checkMigration } from './migration-check.js';
import { openDatabase } from './index.js';

// Migration 0024 (two-factor) adds four nullable columns to `users` and two
// empty tables. Every existing row must stay as it was, and nobody has 2FA
// after it.

describe('migration 0024 (two-factor)', () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });
  afterEach(() => {
    remove();
  });

  it('keeps every user and session, adds empty 2FA tables and leaves 2FA off', () => {
    const file = join(dir, 'old.db');
    const old = openDatabase(file, { migrationsFolder: migrationsBefore(dir, '0024_two_factor') });
    const at = '2026-11-19T12:00:00.000Z';
    old.sqlite.exec(`
      UPDATE users SET password_hash = '$argon2id$x', last_login_at = '${at}' WHERE id = 1;
      INSERT INTO users (id, username, password_hash, role, can_create_api_keys, created_at, disabled_at)
        VALUES (2, 'ola', '$argon2id$y', 'member', 0, '${at}', '${at}');
      INSERT INTO user_sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent)
        VALUES ('abc', 1, '${at}', '${at}', '2026-12-19T12:00:00.000Z', 'Firefox');
    `);
    old.close();

    const report = checkMigration(file);
    expect(report.tables.filter((row) => !row.ok)).toEqual([]);
    expect(report.ownership.filter((check) => !check.ok)).toEqual([]);
    expect(report.ownership.map((check) => check.name)).toContain(
      'users: 2FA columns empty after 0024',
    );
    expect(report.ok).toBe(true);
    for (const table of ['recovery_codes', 'trusted_devices']) {
      expect(report.tables.find((row) => row.table === table)).toMatchObject({
        before: undefined,
        after: { rows: 0 },
      });
    }
    expect(report.tables.find((row) => row.table === 'users')?.before?.rows).toBe(2);
  });

  it('compares the 2FA columns like any other for a database already at 0024', () => {
    const file = join(dir, 'old.db');
    const old = openDatabase(file, { migrationsFolder: migrationsBefore(dir, '0024_two_factor') });
    old.close();
    // Migrate, then pretend the migration had filled a column.
    const migrated = openDatabase(file);
    migrated.sqlite.exec("UPDATE users SET totp_enabled_at = '2026-11-19T12:00:00.000Z'");
    migrated.close();
    // Already at 0024: the 2FA columns are compared like any other, and the check
    // for empty columns isn't run (the database had them before).
    expect(checkMigration(file).ownership.map((check) => check.name)).not.toContain(
      'users: 2FA columns empty after 0024',
    );
  });
});
