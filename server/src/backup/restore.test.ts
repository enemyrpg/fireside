import { BRANDING, encodeBase64, makeSolidPng } from '@fireside/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { createApiKey, listApiKeys } from '../auth/api-keys.js';
import { databasePath, openDatabase, type Database } from '../db/index.js';
import { storeIcons } from '../icons/store.js';
import { generateSeed } from '../seed/generator/generate.js';
import { seedInProcess } from '../seed/in-process.js';
import { testConfig, TEST_OWNER } from '../test-utils.js';
import { createBackup } from './backup.js';
import { acquireInstanceLock, InstanceLockedError, lockPath } from './lock.js';
import { restoreBackup, RestoreError } from './restore.js';
import { dumpTables, migrationsWithExtra, tempDir } from './testing.js';

const N = BRANDING.shortName;

const KEEP = { daily: 7, weekly: 4, monthly: 6 };
const NOW = () => new Date('2026-11-14T12:00:00.000Z');
const TZ = 'Europe/Oslo';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function dir(): string {
  const { dir: path, remove } = tempDir();
  cleanups.push(remove);
  return path;
}

function open(file: string): Database {
  const database = openDatabase(file);
  cleanups.push(() => {
    database.close();
  });
  return database;
}

function dumpFile(file: string): Record<string, unknown> {
  const sqlite = new BetterSqlite3(file, { readonly: true });
  try {
    return dumpTables(sqlite);
  } finally {
    sqlite.close();
  }
}

describe('restore', () => {
  // Seeding takes a few seconds, so it is done once and copied per test.
  let seedFile: string;
  beforeAll(async () => {
    const { dir: seedDir, remove } = tempDir();
    seedFile = join(seedDir, 'seed.db');
    const database = openDatabase(seedFile);
    try {
      const data = generateSeed({
        seed: 3,
        accounts: 2,
        months: 0.25,
        until: new Date('2026-11-10T20:00:00.000Z'),
        timeZone: TZ,
      });
      const result = await seedInProcess(database, testConfig({ TZ }), data);
      expect(result.failed).toEqual([]);
    } finally {
      database.close();
    }
    return remove;
  }, 60_000);

  /** A data folder with a copy of the seeded database, open like a running server. */
  function instance() {
    const root = dir();
    const dataDir = join(root, 'data');
    const backupDir = join(dataDir, 'backups');
    const dbFile = databasePath(dataDir);
    // Through VACUUM INTO, so the copy is complete whatever state seed.db is in.
    mkdirSync(dataDir, { recursive: true });
    const seed = new BetterSqlite3(seedFile, { readonly: true });
    try {
      seed.prepare('VACUUM INTO ?').run(dbFile);
    } finally {
      seed.close();
    }
    return { root, dataDir, backupDir, dbFile };
  }

  function backup(dbFile: string, backupDir: string) {
    return createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: TZ, now: NOW }).path;
  }

  it('gives identical content in every table, also after a rebuild', { timeout: 30_000 }, () => {
    const a = instance();
    const live = open(a.dbFile);
    // Something only in the WAL when the backup is taken.
    createApiKey(live.db, TEST_OWNER, 'Before backup');
    // Icons are assets, not events: in the backup, and untouched by rebuild.
    const icon = makeSolidPng(32, 32, [200, 60, 40, 255]);
    storeIcons(
      live.db,
      [
        { itemId: 4151, png: encodeBase64(icon) },
        { kind: 'BOSS', key: 'Zulrah', png: encodeBase64(icon) },
      ],
      NOW(),
    );
    const file = backup(a.dbFile, a.backupDir);
    const atBackup = dumpTables(live.sqlite);
    const tables = atBackup.tables as Record<string, unknown[]>;
    expect(tables.events?.length).toBeGreaterThan(100);
    expect(tables.sessions?.length).toBeGreaterThan(0);
    expect(tables.item_icons).toEqual([
      expect.objectContaining({ item_id: 4151, png: Buffer.from(icon) }),
    ]);
    expect(tables.named_icons).toEqual([
      expect.objectContaining({ kind: 'BOSS', key: 'Zulrah', png: Buffer.from(icon) }),
    ]);

    // Into an empty data folder.
    const b = { dataDir: join(dir(), 'data') };
    const result = restoreBackup({
      file,
      dataDir: b.dataDir,
      backupDir: join(b.dataDir, 'backups'),
      now: NOW,
    });
    expect(result).toMatchObject({
      backupCreatedAt: NOW(),
      migrationsApplied: 0,
      previousSavedTo: null,
    });
    expect(dumpFile(result.dbFile)).toEqual(atBackup);

    // A rebuild of both gives the same tables again.
    const restored = open(result.dbFile);
    const rebuildNow = () => new Date('2026-11-14T13:00:00.000Z');
    rebuildDerivedTables(live.db, { now: rebuildNow });
    rebuildDerivedTables(restored.db, { now: rebuildNow });
    expect(dumpTables(restored.sqlite)).toEqual(dumpTables(live.sqlite));
    expect((dumpTables(restored.sqlite).tables as Record<string, unknown[]>).item_icons).toEqual(
      tables.item_icons,
    );
  });

  it('replaces the current database and keeps a copy of it, WAL included', () => {
    const a = instance();
    const file = backup(a.dbFile, a.backupDir);
    const atBackup = dumpFile(file);

    // Like the manual test: a key created after the backup, still only in the WAL.
    const live = openDatabase(a.dbFile);
    createApiKey(live.db, TEST_OWNER, 'restore-test');
    // Simulate a crash: the -wal file stays behind with the new key.
    copyFileSync(`${a.dbFile}-wal`, `${a.dbFile}-wal.saved`);
    live.close();
    copyFileSync(`${a.dbFile}-wal.saved`, `${a.dbFile}-wal`);

    const result = restoreBackup({
      file,
      dataDir: a.dataDir,
      backupDir: a.backupDir,
      now: () => new Date('2026-11-14T12:30:00.000Z'),
    });

    expect(result.previousSavedTo).toBe(join(a.backupDir, `${N}-pre-restore-20261114-123000Z.db`));
    expect(result.previousRawCopy).toBe(false);
    expect(existsSync(`${a.dbFile}-shm`)).toBe(false);
    expect(dumpFile(a.dbFile)).toEqual(atBackup);

    const restored = open(a.dbFile);
    expect(listApiKeys(restored.db).map((key) => key.name)).not.toContain('restore-test');
    const previous = new BetterSqlite3(result.previousSavedTo ?? '', { readonly: true });
    try {
      expect(previous.prepare('SELECT name FROM api_keys').pluck().all()).toContain('restore-test');
    } finally {
      previous.close();
    }
    // No temp files left, and the copy is not a backup that retention would delete.
    expect(readdirSync(a.dataDir).filter((name) => name.includes('restore-tmp'))).toEqual([]);
  });

  it('migrates a backup from an older version', () => {
    const a = instance();
    const file = backup(a.dbFile, a.backupDir);
    const migrationsFolder = migrationsWithExtra(a.root);

    const result = restoreBackup({
      file,
      dataDir: a.dataDir,
      backupDir: a.backupDir,
      migrationsFolder,
    });
    expect(result.migrationsApplied).toBe(1);
    const restored = openDatabase(a.dbFile, { migrationsFolder });
    cleanups.push(() => {
      restored.close();
    });
    expect(
      restored.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name = 'future_feature'")
        .pluck()
        .get(),
    ).toBe('future_feature');
  });

  describe('refuses, and changes nothing,', () => {
    /** Runs a restore that must fail, and checks that the database is untouched. */
    function expectRefused(
      a: ReturnType<typeof instance>,
      file: string,
      error: RegExp | (new (...args: never[]) => Error),
      extra: Partial<Parameters<typeof restoreBackup>[0]> = {},
    ) {
      const before = readFileSync(a.dbFile);
      const backupsBefore = existsSync(a.backupDir) ? readdirSync(a.backupDir).sort() : [];
      expect(() =>
        restoreBackup({ file, dataDir: a.dataDir, backupDir: a.backupDir, ...extra }),
      ).toThrow(error);
      expect(readFileSync(a.dbFile).equals(before)).toBe(true);
      expect(existsSync(a.backupDir) ? readdirSync(a.backupDir).sort() : []).toEqual(backupsBefore);
      expect(readdirSync(a.dataDir).filter((name) => name.includes('restore-tmp'))).toEqual([]);
    }

    it('while the server runs (lock held in this process)', () => {
      const a = instance();
      const file = backup(a.dbFile, a.backupDir);
      const lock = acquireInstanceLock(a.dataDir);
      cleanups.push(() => {
        lock.release();
      });
      expectRefused(a, file, InstanceLockedError);
    });

    it('while the server runs in another process', { timeout: 15_000 }, async () => {
      const a = instance();
      const file = backup(a.dbFile, a.backupDir);
      const holder = await holdLockInChild(a.dataDir);
      cleanups.push(() => holder.kill('SIGKILL'));
      expectRefused(a, file, InstanceLockedError);

      // Once it has stopped (even killed), restore works.
      await new Promise((resolve) => {
        holder.once('exit', resolve);
        holder.kill('SIGKILL');
      });
      expect(() =>
        restoreBackup({ file, dataDir: a.dataDir, backupDir: a.backupDir }),
      ).not.toThrow();
    });

    it.each([
      ['random bytes', () => Buffer.from(Array.from({ length: 65_536 }, (_, i) => (i * 31) % 251))],
      ['a text file', () => 'hello'],
    ])('for a corrupt file (%s)', (_name, content) => {
      const a = instance();
      const file = join(a.root, 'corrupt.db');
      writeFileSync(file, content());
      expectRefused(a, file, RestoreError);
    });

    it('for a truncated backup', () => {
      const a = instance();
      const full = readFileSync(backup(a.dbFile, a.backupDir));
      const file = join(a.root, 'truncated.db');
      writeFileSync(file, full.subarray(0, Math.floor(full.length / 2)));
      expectRefused(a, file, /Nothing was changed/);
    });

    it('for a backup with damaged pages', () => {
      const a = instance();
      const damaged = Buffer.from(readFileSync(backup(a.dbFile, a.backupDir)));
      // Overwrite a stretch in the middle (keeps the header and page 1).
      damaged.fill(0x5a, Math.floor(damaged.length / 2), Math.floor(damaged.length / 2) + 8192);
      const file = join(a.root, 'damaged.db');
      writeFileSync(file, damaged);
      expectRefused(a, file, /Nothing was changed/);
    });

    it('for a backup from a newer version', () => {
      const a = instance();
      // A database made by a version with one more migration.
      const newer = join(a.root, 'newer.db');
      copyFileSync(backup(a.dbFile, a.backupDir), newer);
      openDatabase(newer, { migrationsFolder: migrationsWithExtra(a.root) }).close();
      expectRefused(a, newer, /newer version/);
    });

    it('for a file that is not there, or is the database itself', () => {
      const a = instance();
      expectRefused(a, join(a.root, 'missing.db'), /No backup file/);
      expectRefused(a, a.dbFile, /is the current database/);
    });
  });

  it('holds the lock while it runs and releases it after', () => {
    const a = instance();
    const file = backup(a.dbFile, a.backupDir);
    restoreBackup({ file, dataDir: a.dataDir, backupDir: a.backupDir });
    expect(existsSync(lockPath(a.dataDir))).toBe(true);
    // Released: a server can start.
    acquireInstanceLock(a.dataDir).release();
  });
});

/** A child process that holds the instance lock, like a running server, until killed. */
function holdLockInChild(dataDir: string): Promise<ChildProcess> {
  const code = `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { timeout: 0 });
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE; COMMIT');
    console.log('locked');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', code, lockPath(dataDir)], {
    cwd: join(import.meta.dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => {
      resolve(child);
    });
  });
}
