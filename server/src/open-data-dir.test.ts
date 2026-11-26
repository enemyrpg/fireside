import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, InstanceLockedError, lockPath } from './backup/lock.js';
import { migrationsWithExtra } from './backup/testing.js';
import { DATA_DIR_STEPS, openDataDir, type DataDirSteps } from './open-data-dir.js';
import { databasePath, openDatabase, type DatabaseUpgrade } from './db/index.js';

const N = BRANDING.shortName;

describe('openDataDir (server startup)', () => {
  let dir: string;
  /** Mode of `dir`, which nothing may change. */
  let dirMode: string;
  let dataDir: string;
  let backupDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${N}-test-`));
    dirMode = (statSync(dir).mode & 0o777).toString(8);
    dataDir = join(dir, 'data');
    backupDir = join(dir, 'backups');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const tables = (file: string): string[] => {
    const sqlite = new BetterSqlite3(file, { readonly: true });
    try {
      return sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .pluck()
        .all() as string[];
    } finally {
      sqlite.close();
    }
  };

  /** The real steps, recording the order they run in. */
  function recordingSteps(calls: string[], fail?: keyof DataDirSteps): DataDirSteps {
    const wrap =
      <A extends unknown[], R>(name: keyof DataDirSteps, step: (...args: A) => R) =>
      (...args: A): R => {
        calls.push(name);
        if (name === fail) throw new Error(`${name} failed`);
        return step(...args);
      };
    return {
      lock: (dataDirectory) => {
        calls.push('lock');
        const lock = DATA_DIR_STEPS.lock(dataDirectory);
        return {
          release: () => {
            calls.push('release');
            lock.release();
          },
        };
      },
      removeRestoreLeftovers: wrap('removeRestoreLeftovers', DATA_DIR_STEPS.removeRestoreLeftovers),
      makePrivate: wrap('makePrivate', DATA_DIR_STEPS.makePrivate),
      backupBeforeMigrating: wrap('backupBeforeMigrating', DATA_DIR_STEPS.backupBeforeMigrating),
      migrate: wrap('migrate', DATA_DIR_STEPS.migrate),
    };
  }

  const ORDER = [
    'lock',
    'removeRestoreLeftovers',
    'makePrivate',
    'backupBeforeMigrating',
    'migrate',
    'makePrivate',
  ];

  it('runs lock → restore leftovers → private → backup before migrating → migrate → private', () => {
    const calls: string[] = [];
    const opened = openDataDir({ dataDir, backupDir }, recordingSteps(calls));
    expect(calls).toEqual(ORDER);
    opened.database.close();
    opened.lock.release();
  });

  it.each(['backupBeforeMigrating', 'migrate'] as const)(
    'stops when %s fails, and releases the lock',
    (failing) => {
      const calls: string[] = [];
      expect(() => openDataDir({ dataDir, backupDir }, recordingSteps(calls, failing))).toThrow(
        `${failing} failed`,
      );
      expect(calls).toEqual([...ORDER.slice(0, ORDER.indexOf(failing) + 1), 'release']);
      // Released: another process can take it now.
      acquireInstanceLock(dataDir).release();
    },
  );

  it('does nothing at all while another process holds the lock', () => {
    // A database one migration behind.
    const dbFile = databasePath(dataDir);
    openDatabase(dbFile).close();
    const migrationsFolder = migrationsWithExtra(dir);
    const before = readFileSync(dbFile);
    const other = acquireInstanceLock(dataDir);
    try {
      expect(() => openDataDir({ dataDir, backupDir, migrationsFolder })).toThrow(
        InstanceLockedError,
      );
    } finally {
      other.release();
    }
    // Not copied, not migrated.
    expect(readFileSync(dbFile)).toEqual(before);
    expect(tables(dbFile)).not.toContain('future_feature');
    expect(existsSync(backupDir)).toBe(false);
  });

  it('copies the database as the previous version left it, then migrates', () => {
    // An install one migration behind.
    openDatabase(databasePath(dataDir)).close();
    const migrationsFolder = migrationsWithExtra(dir);

    const opened = openDataDir({ dataDir, backupDir, migrationsFolder });
    try {
      expect(opened.dbFile).toBe(databasePath(dataDir));
      // The copy was taken before the migration (no `future_feature`).
      expect(opened.preMigrateBackup).toBeDefined();
      const copy = opened.preMigrateBackup ?? '';
      expect(readdirSync(backupDir)).toEqual([copy.slice(backupDir.length + 1)]);
      expect(copy).toMatch(new RegExp(`${N}-pre-migrate-\\d{8}-\\d{6}Z\\.db$`));
      expect(tables(copy)).not.toContain('future_feature');
      expect(tables(opened.dbFile)).toContain('future_feature');
    } finally {
      opened.database.close();
      opened.lock.release();
    }
  });

  it('removes what an interrupted restore left in DATA_DIR, and nothing else', () => {
    mkdirSync(dataDir);
    const leftovers = [
      `.${N}.db.restore-gunzip-tmp`,
      `.${N}.db.restore-tmp`,
      `.${N}.db.restore-tmp-journal`,
    ];
    for (const name of [...leftovers, 'notes.txt']) writeFileSync(join(dataDir, name), 'x');

    const opened = openDataDir({ dataDir, backupDir });
    try {
      expect(opened.removedRestoreFiles.sort()).toEqual([...leftovers].sort());
      for (const name of leftovers) expect(existsSync(join(dataDir, name))).toBe(false);
      expect(existsSync(join(dataDir, 'notes.txt'))).toBe(true);
    } finally {
      opened.database.close();
      opened.lock.release();
    }
  });

  it('leaves a foreign database file in DATA_DIR alone', () => {
    mkdirSync(dataDir);
    const foreign = join(dataDir, 'other-app.db');
    openDatabase(foreign).close();
    const before = readFileSync(foreign);
    const beforeMode = statSync(foreign).mode;

    const opened = openDataDir({ dataDir, backupDir });
    try {
      // Not renamed, not made private: a new, empty database is used instead.
      expect(readFileSync(foreign)).toEqual(before);
      expect(statSync(foreign).mode).toBe(beforeMode);
      expect(opened.dbFile).toBe(databasePath(dataDir));
      expect(opened.database.sqlite.prepare('SELECT count(*) FROM events').pluck().get()).toBe(0);
    } finally {
      opened.database.close();
      opened.lock.release();
    }
  });

  describe('file permissions', () => {
    const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

    it.skipIf(process.platform === 'win32')(
      'makes an install from before private: folders 700, files 600, also the database and its copy',
      () => {
        // A database one migration behind, with loose modes.
        const dbFile = databasePath(dataDir);
        openDatabase(dbFile).close();
        const migrationsFolder = migrationsWithExtra(dir);
        mkdirSync(backupDir);
        const oldBackup = join(backupDir, `${N}-20260101-030000Z.db`);
        writeFileSync(oldBackup, 'x');
        for (const path of [dbFile, oldBackup]) chmodSync(path, 0o644);
        for (const path of [dataDir, backupDir]) chmodSync(path, 0o755);

        const opened = openDataDir({ dataDir, backupDir, migrationsFolder });
        try {
          expect(mode(dataDir)).toBe('700');
          expect(mode(backupDir)).toBe('700');
          expect(mode(opened.dbFile)).toBe('600');
          expect(mode(`${opened.dbFile}-wal`)).toBe('600');
          expect(mode(`${opened.dbFile}-shm`)).toBe('600');
          expect(mode(lockPath(dataDir))).toBe('600');
          expect(mode(oldBackup)).toBe('600');
          expect(mode(opened.preMigrateBackup ?? '')).toBe('600');
          // The two folders, the database, the lock and the old backup at least.
          expect(opened.permissions.tightened).toBeGreaterThanOrEqual(5);
          expect(opened.permissions.failed).toEqual([]);
        } finally {
          opened.database.close();
          opened.lock.release();
        }

        // The next start finds nothing to change.
        const again = openDataDir({ dataDir, backupDir, migrationsFolder });
        try {
          expect(again.permissions).toEqual({ tightened: 0, failed: [] });
        } finally {
          again.database.close();
          again.lock.release();
        }
      },
    );

    it.skipIf(process.platform === 'win32')('makes a brand-new DATA_DIR private', () => {
      const opened = openDataDir({ dataDir, backupDir });
      try {
        expect(mode(dataDir)).toBe('700');
        expect(mode(opened.dbFile)).toBe('600');
        expect(mode(`${opened.dbFile}-wal`)).toBe('600');
        expect(mode(lockPath(dataDir))).toBe('600');
        // Never the folder above.
        expect(mode(dir)).toBe(dirMode);
      } finally {
        opened.database.close();
        opened.lock.release();
      }
    });
  });
});

describe('openDataDir after a projection rule change', () => {
  let dir: string;
  let dataDir: string;
  let backupDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${N}-test-`));
    dataDir = join(dir, 'data');
    backupDir = join(dir, 'backups');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** An upgrade that is pending until it has run, recording when it runs. */
  function fakeUpgrade(calls: string[]): DatabaseUpgrade {
    let done = false;
    return {
      pending: () => !done,
      run: () => {
        calls.push('upgrade');
        done = true;
        return { projections: ['sessions'], counts: {}, tables: [], columns: {}, durationMs: 0 };
      },
    };
  }

  it('backs up first, then recomputes while migrating, with no migration pending', () => {
    // Up to date, but built with older rules.
    openDatabase(databasePath(dataDir)).close();
    const calls: string[] = [];
    const steps: DataDirSteps = {
      ...DATA_DIR_STEPS,
      backupBeforeMigrating: (options) => {
        calls.push('backupBeforeMigrating');
        return DATA_DIR_STEPS.backupBeforeMigrating(options);
      },
      migrate: (file, options) => {
        calls.push('migrate');
        return DATA_DIR_STEPS.migrate(file, options);
      },
    };
    const opened = openDataDir({ dataDir, backupDir, upgrade: fakeUpgrade(calls) }, steps);
    try {
      expect(calls).toEqual(['backupBeforeMigrating', 'migrate', 'upgrade']);
      expect(opened.preMigrateBackup).toMatch(/pre-migrate/);
      expect(opened.database.upgrade?.projections).toEqual(['sessions']);
    } finally {
      opened.database.close();
      opened.lock.release();
    }
  });

  it('records the current versions, so the next start does nothing', () => {
    openDatabase(databasePath(dataDir)).close();
    const first = openDataDir({ dataDir, backupDir });
    expect(first.database.upgrade?.projections).toEqual(['sessions', 'kc', 'raid-special-loot']);
    expect(first.preMigrateBackup).toBeDefined();
    first.database.close();
    first.lock.release();

    const second = openDataDir({ dataDir, backupDir });
    try {
      expect(second.database.upgrade).toBeUndefined();
      expect(second.preMigrateBackup).toBeUndefined();
    } finally {
      second.database.close();
      second.lock.release();
    }
  });
});
