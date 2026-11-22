import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsBefore, tempDir } from '../backup/testing.js';
import { checkMigration } from './migration-check.js';
import { openDatabase } from './index.js';

// Migration 0022 (invites and users) rebuilds `api_keys` so the creator and
// revoker can be set to null when that user is deleted. Every row, and the
// AUTOINCREMENT counter, must survive the rebuild.

describe('migration 0022 (invites and users)', () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });
  afterEach(() => {
    remove();
  });

  /** A database at 0021 with two users and three keys, the newest deleted (a gap in the counter). */
  function asVersion0021(): string {
    const file = join(dir, 'old.db');
    const old = openDatabase(file, {
      migrationsFolder: migrationsBefore(dir, '0022_invites_users'),
    });
    const at = '2026-11-18T12:00:00.000Z';
    const prefix = BRANDING.apiKeyPrefix;
    old.sqlite.exec(`
      INSERT INTO users (id, username, password_hash, role, can_create_api_keys, created_at)
        VALUES (2, 'ola', '$argon2id$x', 'member', 1, '${at}');
      INSERT INTO api_keys (id, user_id, created_by_user_id, revoked_by_user_id, name, key_hash, prefix, created_at, revoked_at)
        VALUES (1, 1, 1, NULL, 'PC', 'aa', '${prefix}a', '${at}', NULL),
               (2, 2, 1, 1, 'Laptop', 'bb', '${prefix}b', '${at}', '${at}'),
               (3, 2, 2, NULL, 'Gone', 'cc', '${prefix}c', '${at}', NULL);
      DELETE FROM api_keys WHERE id = 3;
    `);
    old.close();
    return file;
  }

  it('keeps every key and the counter, and lets a deleted user’s references go null', () => {
    const file = asVersion0021();
    const report = checkMigration(file);
    expect(report.tables.filter((row) => !row.ok)).toEqual([]);
    expect(report.ownership.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables.find((row) => row.table === 'invites')).toMatchObject({
      before: undefined,
      after: { rows: 0 },
    });

    const database = openDatabase(file);
    try {
      const sqlite = database.sqlite;
      expect(
        sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'api_keys'").pluck().get(),
      ).toBe(3);
      sqlite.exec(
        'INSERT INTO api_keys (user_id, created_by_user_id, name, key_hash, prefix, created_at) ' +
          `VALUES (1, 1, 'New', 'dd', '${BRANDING.apiKeyPrefix}d', '2026-11-18T12:00:00.000Z')`,
      );
      expect(sqlite.prepare('SELECT max(id) FROM api_keys').pluck().get()).toBe(4);
      // User 1 made and revoked user 2's key: deleting user 1's own rows and
      // then user 1 is possible, and the key stays without its creator.
      sqlite.exec('DELETE FROM api_keys WHERE user_id = 1; DELETE FROM users WHERE id = 1');
      expect(
        sqlite.prepare('SELECT id, created_by_user_id, revoked_by_user_id FROM api_keys').all(),
      ).toEqual([{ id: 2, created_by_user_id: null, revoked_by_user_id: null }]);
    } finally {
      database.close();
    }
  });
});
