import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsBefore, tempDir } from '../backup/testing.js';
import { checkMigration } from './migration-check.js';
import { openDatabase } from './index.js';

// Migration 0025 adds the raw table `clog_reads`, empty, and an index on
// `clog_obtained (account_id, first_seen_at)`. Every existing row stays as it
// was, and a rebuild leaves `clog_reads` alone.

describe('migration 0025 (collection log per session)', () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });
  afterEach(() => {
    remove();
  });

  it('keeps the collection log, adds an empty clog_reads and the index', () => {
    const file = join(dir, 'old.db');
    const old = openDatabase(file, {
      migrationsFolder: migrationsBefore(dir, '0025_session_clog_feed'),
    });
    const at = '2026-11-16T21:39:58.802Z';
    old.sqlite.exec(`
      INSERT INTO account_ids (id, user_id, account_hash) VALUES (1, 1, '1111111111');
      INSERT INTO external_snapshots (id, source, kind, account_id, fetched_at, content_hash, body)
        VALUES (1, 'RUNEPROFILE', 'COLLECTION_LOG', 1, '${at}', 'sha256:${'0'.repeat(64)}', '{}');
      INSERT INTO account_clog_sources (account_id, source, enabled, enabled_at, last_success_at)
        VALUES (1, 'RUNEPROFILE', 1, '${at}', '${at}');
    `);
    old.close();

    const report = checkMigration(file);
    expect(report.tables.filter((row) => !row.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables.find((row) => row.table === 'clog_reads')).toMatchObject({
      before: undefined,
      after: { rows: 0 },
    });
    expect(report.rebuild.map((check) => check.name)).toContain('clog_reads');

    const migrated = openDatabase(file);
    try {
      const indexes = migrated.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'clog_obtained'",
        )
        .pluck()
        .all();
      expect(indexes).toContain('clog_obtained_account_first_seen_idx');
    } finally {
      migrated.close();
    }
  });
});
