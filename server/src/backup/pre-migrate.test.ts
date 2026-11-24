import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiKey } from '../auth/api-keys.js';
import { databasePath, openDatabase } from '../db/index.js';
import { TEST_OWNER } from '../test-utils.js';
import { migrationsWithExtra } from './testing.js';
import { backupFileName, listBackups, preMigrateFileName } from './files.js';
import { backupBeforeMigrating, PreMigrateBackupError } from './pre-migrate.js';
import { pruneBackups } from './retention.js';

const N = BRANDING.shortName;
const NOW = new Date('2026-11-18T12:00:05.000Z');

describe('backup before migrating', () => {
  let dir: string;
  let dbFile: string;
  let backupDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${N}-test-`));
    dbFile = databasePath(join(dir, 'data'));
    backupDir = join(dir, 'backups');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A database with every real migration and one API key. */
  function existingDatabase(): void {
    const database = openDatabase(dbFile);
    createApiKey(database.db, TEST_OWNER, 'Gaming PC', NOW);
    database.close();
  }

  const appliedIn = (file: string) => {
    const sqlite = new BetterSqlite3(file, { readonly: true });
    try {
      return sqlite.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get();
    } finally {
      sqlite.close();
    }
  };

  it('copies an existing database with pending migrations, named apart from the backups', () => {
    existingDatabase();
    const migrationsFolder = migrationsWithExtra(dir);
    const before = readFileSync(dbFile);

    const copy = backupBeforeMigrating({ dbFile, backupDir, migrationsFolder, now: () => NOW });

    expect(copy).toBe(join(backupDir, `${N}-pre-migrate-20261118-120005Z.db`));
    expect(readFileSync(dbFile)).toEqual(before);
    // The copy is the database as it was: without the pending migration, with the key.
    expect(appliedIn(copy ?? '')).toBe(appliedIn(dbFile));
    const sqlite = new BetterSqlite3(copy ?? '', { readonly: true });
    expect(sqlite.prepare('SELECT name FROM api_keys').pluck().all()).toEqual(['Gaming PC']);
    sqlite.close();
    // Not a backup by name, so not listed or counted.
    expect(listBackups(backupDir)).toEqual([]);
    expect(readdirSync(backupDir)).toEqual([`${N}-pre-migrate-20261118-120005Z.db`]);
  });

  it('gives a second copy in the same second its own name', () => {
    existingDatabase();
    const migrationsFolder = migrationsWithExtra(dir);
    const options = { dbFile, backupDir, migrationsFolder, now: () => NOW };
    backupBeforeMigrating(options);
    expect(backupBeforeMigrating(options)).toBe(
      join(backupDir, `${N}-pre-migrate-20261118-120005Z-2.db`),
    );
  });

  it('takes no copy when there is no database yet', () => {
    expect(backupBeforeMigrating({ dbFile, backupDir })).toBeUndefined();
    expect(existsSync(backupDir)).toBe(false);
  });

  it('takes no copy of a database that was never migrated', () => {
    mkdirSync(dirname(dbFile), { recursive: true });
    const other = new BetterSqlite3(dbFile);
    other.exec('CREATE TABLE notes (text TEXT)');
    other.close();
    expect(backupBeforeMigrating({ dbFile, backupDir })).toBeUndefined();
    expect(existsSync(backupDir)).toBe(false);
  });

  it('takes no copy when nothing is pending', () => {
    existingDatabase();
    expect(backupBeforeMigrating({ dbFile, backupDir })).toBeUndefined();
    expect(existsSync(backupDir)).toBe(false);
  });

  it('fails without leaving files when the copy cannot be written, and the database is unchanged', () => {
    existingDatabase();
    const migrationsFolder = migrationsWithExtra(dir);
    const before = readFileSync(dbFile);
    writeFileSync(backupDir, 'not a folder');

    expect(() => backupBeforeMigrating({ dbFile, backupDir, migrationsFolder })).toThrow(
      PreMigrateBackupError,
    );
    expect(readFileSync(dbFile)).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(['backups', 'data', 'migrations-newer']);
  });
});

describe('retention and pre-migrate copies', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${N}-test-`));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes a pre-migrate copy only after the max age', () => {
    const old = preMigrateFileName(Date.parse('2020-01-01T03:00:00Z'));
    const recent = preMigrateFileName(Date.parse('2026-11-13T12:00:00Z'));
    writeFileSync(join(dir, old), 'copy');
    writeFileSync(join(dir, recent), 'copy');
    // Ten daily backups, of which retention keeps only the newest two.
    for (let day = 0; day < 10; day++) {
      writeFileSync(
        join(dir, backupFileName(Date.parse('2026-11-14T03:00:00Z') - day * 86_400_000)),
        'b',
      );
    }

    const deleted = pruneBackups(dir, { daily: 2, weekly: 0, monthly: 0 }, 'Europe/Oslo', {
      nowMs: Date.parse('2026-11-14T04:00:00Z'),
      protect: new Set(),
    });

    expect(deleted).toHaveLength(9);
    expect(deleted).toContain(old);
    expect(readdirSync(dir).sort()).toEqual(
      [recent, `${N}-20261114-030000Z.db.gz`, `${N}-20261113-030000Z.db.gz`].sort(),
    );
  });
});
