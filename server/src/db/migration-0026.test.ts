import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsBefore, tempDir } from '../backup/testing.js';
import { checkMigration } from './migration-check.js';
import { openDatabase } from './index.js';

// Migration 0026 adds `item_price_history`, empty. The prices already fetched
// stay as they were, and a rebuild leaves both price tables alone: they are not
// derived from events.

describe('migration 0026 (price history)', () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });
  afterEach(() => {
    remove();
  });

  it('keeps the fetched prices and adds an empty item_price_history', () => {
    const file = join(dir, 'old.db');
    const old = openDatabase(file, {
      migrationsFolder: migrationsBefore(dir, '0026_item_price_history'),
    });
    const at = '2026-11-20T12:00:01.500Z';
    old.sqlite.exec(`
      INSERT INTO item_prices (item_id, high, high_time, low, low_time, fetched_at)
        VALUES (4151, 1500000, '${at}', 1490000, '${at}', '${at}');
      INSERT INTO external_sources (source, last_attempt_at, last_success_at)
        VALUES ('WIKI_PRICES', '${at}', '${at}');
    `);
    old.close();

    const report = checkMigration(file);
    expect(report.tables.filter((row) => !row.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables.find((row) => row.table === 'item_price_history')).toMatchObject({
      before: undefined,
      after: { rows: 0 },
    });
    expect(report.tables.find((row) => row.table === 'item_prices')).toMatchObject({
      after: { rows: 1 },
    });
    expect(report.rebuild.map((check) => check.name)).toEqual(
      expect.arrayContaining(['item_prices', 'item_price_history']),
    );
  });
});
