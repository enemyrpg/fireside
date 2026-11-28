import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsBefore, tempDir } from '../backup/testing.js';
import {
  checkMigration,
  TABLES_ADDED_BY_PRICE_HOURS_MIGRATION,
  TABLES_DROPPED_BY_PRICE_HOURS_MIGRATION,
} from './migration-check.js';
import { openDatabase } from './index.js';

// Migration 0028 drops the `/latest` prices and their midpoint history and adds
// the hourly and daily trade tables, empty. The old prices are fetched data,
// not derived from events, and not comparable with hourly averages
// (docs/decisions/0021-prices-from-hourly-volume-weighted-averages.md).
// Everything else stays as it was.

describe('migration 0028 (price hours)', () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });
  afterEach(() => {
    remove();
  });

  it('drops the old prices and history, adds empty price tables, and keeps the source state', () => {
    const file = join(dir, 'old.db');
    const old = openDatabase(file, { migrationsFolder: migrationsBefore(dir, '0028_price_hours') });
    const at = '2026-11-20T12:00:01.500Z';
    old.sqlite.exec(`
      INSERT INTO item_prices (item_id, high, high_time, low, low_time, fetched_at)
        VALUES (4151, 1500000, '${at}', 1490000, '${at}', '${at}');
      INSERT INTO item_price_history (fetched_at, item_id, high, low, seq)
        VALUES ('${at}', 4151, 1500000, 1490000, 1);
      INSERT INTO external_sources (source, last_attempt_at, last_success_at)
        VALUES ('WIKI_PRICES', '${at}', '${at}');
    `);
    old.close();

    const report = checkMigration(file);
    expect(report.tables.filter((row) => !row.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    for (const table of TABLES_DROPPED_BY_PRICE_HOURS_MIGRATION) {
      expect(report.tables.find((row) => row.table === table)).toMatchObject({
        before: { rows: 1 },
        after: undefined,
        ok: true,
      });
    }
    for (const table of TABLES_ADDED_BY_PRICE_HOURS_MIGRATION) {
      expect(report.tables.find((row) => row.table === table)).toMatchObject({
        before: undefined,
        after: { rows: 0 },
      });
    }
    expect(report.tables.find((row) => row.table === 'external_sources')).toMatchObject({
      before: { rows: 1 },
      ok: true,
    });
    expect(report.rebuild.map((check) => check.name)).toEqual(
      expect.arrayContaining([...TABLES_ADDED_BY_PRICE_HOURS_MIGRATION]),
    );
  });
});
