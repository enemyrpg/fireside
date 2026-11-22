import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyFilePath } from './auth/secret-box.js';
import {
  backupFileName,
  preMigrateFileName,
  preRestoreFileName,
  TEMP_PREFIX,
  TEMP_SUFFIX,
} from './backup/files.js';
import { acquireInstanceLock, lockPath } from './backup/lock.js';
import { databasePath } from './db/index.js';
import {
  createPrivateFile,
  ensurePrivateDir,
  makePrivateDir,
  makePrivateFile,
} from './fs-modes.js';
import {
  describeTightenResult,
  mergeTightenResults,
  tightenDataDir,
  tightenWarnings,
} from './tighten-data-dir.js';

// File modes in DATA_DIR and BACKUP_DIR.

const N = BRANDING.shortName;
const T = Date.parse('2026-11-19T03:00:00.000Z');
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

describe.skipIf(process.platform === 'win32')('private files', () => {
  /** The folder above DATA_DIR: nothing in it, and not the folder itself, may change. */
  let parent: string;
  let dataDir: string;
  let backupDir: string;
  /** A folder that has nothing to do with the server. */
  let outside: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), `${N}-modes-`));
    chmodSync(parent, 0o755);
    dataDir = join(parent, 'data');
    backupDir = join(dataDir, 'backups');
    outside = join(parent, 'outside');
    for (const dir of [dataDir, backupDir, outside]) {
      mkdirSync(dir);
      chmodSync(dir, 0o755);
    }
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  /** A file with the mode a default umask gives. */
  function loose(path: string): string {
    writeFileSync(path, 'x');
    chmodSync(path, 0o644);
    return path;
  }

  it('makes the two folders 700 and every file of ours 600', () => {
    const db = databasePath(dataDir);
    const ours = [
      db,
      `${db}-wal`,
      `${db}-shm`,
      lockPath(dataDir),
      keyFilePath(dataDir),
      join(backupDir, backupFileName(T)),
      join(backupDir, backupFileName(T, 2)),
      join(backupDir, preMigrateFileName(T)),
      join(backupDir, preRestoreFileName(T)),
      join(backupDir, `${preRestoreFileName(T)}-wal`),
      join(backupDir, `${TEMP_PREFIX}abc123${TEMP_SUFFIX}`),
    ].map(loose);

    const result = tightenDataDir({ dataDir, backupDir });
    expect(result).toEqual({ tightened: ours.length + 2, failed: [] });
    expect(mode(dataDir)).toBe('700');
    expect(mode(backupDir)).toBe('700');
    for (const file of ours)
      expect({ file: basename(file), mode: mode(file) }).toMatchObject({ mode: '600' });

    // Nothing left to do the second time.
    expect(tightenDataDir({ dataDir, backupDir })).toEqual({ tightened: 0, failed: [] });
  });

  it('leaves files that are not ours, subfolders, and everything outside the two folders', () => {
    const notes = loose(join(dataDir, 'notes.txt'));
    const otherDb = loose(join(dataDir, 'other.db'));
    const inBackups = loose(join(backupDir, 'my-own-copy.db'));
    const sub = join(dataDir, 'exports');
    mkdirSync(sub);
    chmodSync(sub, 0o755);
    const inSub = loose(join(sub, backupFileName(T)));
    const sibling = loose(join(parent, `${N}.db`));
    const elsewhere = loose(join(outside, `${N}.db`));
    loose(databasePath(dataDir));

    expect(tightenDataDir({ dataDir, backupDir }).tightened).toBe(3);
    for (const file of [notes, otherDb, inBackups, inSub, sibling, elsewhere]) {
      expect({ file, mode: mode(file) }).toEqual({ file, mode: '644' });
    }
    expect(mode(sub)).toBe('755');
    expect(mode(outside)).toBe('755');
    // Never the folder above DATA_DIR.
    expect(mode(parent)).toBe('755');
  });

  it('never follows a symbolic link in DATA_DIR or BACKUP_DIR: the target keeps its mode', () => {
    // Links with our own file names, pointing at files and a folder outside.
    const targets = {
      key: loose(join(outside, 'someone-elses.key')),
      wal: loose(join(outside, 'someone-elses-wal')),
      db: loose(join(outside, 'someone-elses.db')),
      backup: loose(join(outside, 'someone-elses-backup.db')),
    };
    const db = databasePath(dataDir);
    symlinkSync(targets.key, keyFilePath(dataDir));
    symlinkSync(targets.wal, `${db}-wal`);
    symlinkSync(targets.db, db);
    symlinkSync(targets.backup, join(backupDir, backupFileName(T)));
    // A link to a folder, under a name of ours.
    symlinkSync(outside, lockPath(dataDir));
    // And a real file of ours next to them.
    const real = loose(join(backupDir, preMigrateFileName(T)));

    const result = tightenDataDir({ dataDir, backupDir });
    for (const target of Object.values(targets)) {
      expect({ target, mode: mode(target) }).toEqual({ target, mode: '644' });
    }
    expect(mode(outside)).toBe('755');
    expect(mode(parent)).toBe('755');
    // Only the two folders and the real file changed, and a link is no failure.
    expect(result).toEqual({ tightened: 3, failed: [] });
    expect(mode(real)).toBe('600');
  });

  it('follows DATA_DIR and BACKUP_DIR themselves when they are links (the operator chose them)', () => {
    const realBackups = join(outside, 'backups-on-another-disk');
    mkdirSync(realBackups);
    chmodSync(realBackups, 0o755);
    const linked = join(parent, 'backups-link');
    symlinkSync(realBackups, linked);
    const backup = loose(join(realBackups, backupFileName(T)));

    expect(tightenDataDir({ dataDir, backupDir: linked }).failed).toEqual([]);
    expect(mode(realBackups)).toBe('700');
    expect(mode(backup)).toBe('600');
    // Its parent is not ours.
    expect(mode(outside)).toBe('755');
  });

  it('is fine with missing folders and files, and creates nothing', () => {
    const missing = join(parent, 'nowhere');
    expect(tightenDataDir({ dataDir: missing, backupDir: join(missing, 'backups') })).toEqual({
      tightened: 0,
      failed: [],
    });
    expect(() => statSync(missing)).toThrow();
  });

  it('turns what it can not change into one warning per path', () => {
    const key = keyFilePath(dataDir);
    expect(tightenWarnings({ tightened: 2, failed: [{ path: key, reason: 'EPERM' }] })).toEqual([
      expect.stringContaining(`${key} private (EPERM)`),
    ]);
    expect(tightenWarnings({ tightened: 2, failed: [] })).toEqual([]);
  });

  it('never opens a file, so the locks SQLite holds in this process survive', () => {
    // Closing any handle to a file drops the process's POSIX locks on it.
    const lock = acquireInstanceLock(dataDir);
    try {
      chmodSync(lockPath(dataDir), 0o644);
      expect(tightenDataDir({ dataDir, backupDir }).tightened).toBeGreaterThanOrEqual(1);
      expect(mode(lockPath(dataDir))).toBe('600');
      // Another process still finds DATA_DIR taken.
      const code = `
        const Database = require('better-sqlite3');
        const db = new Database(process.argv[1], { timeout: 0 });
        try {
          db.pragma('locking_mode = EXCLUSIVE');
          db.exec('BEGIN EXCLUSIVE; COMMIT');
          console.log('free');
        } catch (error) {
          console.log(error.code);
        }`;
      const child = spawnSync(process.execPath, ['-e', code, lockPath(dataDir)], {
        cwd: import.meta.dirname,
        encoding: 'utf8',
      });
      expect(child.stdout.trim()).toBe('SQLITE_BUSY');
    } finally {
      lock.release();
    }
  });

  it('describes the result in one line with a count and no paths', () => {
    loose(databasePath(dataDir));
    const result = tightenDataDir({ dataDir, backupDir });
    const line = describeTightenResult(result);
    expect(line).toContain('made 3 paths');
    expect(line).not.toContain(parent);
    expect(describeTightenResult({ tightened: 1, failed: [] })).toContain('made 1 path ');
    expect(describeTightenResult({ tightened: 0, failed: [] })).toContain('already private');
  });

  it('adds up two runs, with each failed path once', () => {
    const failed = [{ path: '/x', reason: 'EPERM' }];
    expect(mergeTightenResults({ tightened: 2, failed }, { tightened: 1, failed })).toEqual({
      tightened: 3,
      failed,
    });
  });

  describe('helpers', () => {
    it('ensurePrivateDir creates a 700 folder and fixes an existing one, never its parent', () => {
      const made = join(parent, 'a', 'b');
      expect(ensurePrivateDir(made)).toEqual({ status: 'unchanged' });
      expect(mode(made)).toBe('700');
      chmodSync(made, 0o755);
      expect(ensurePrivateDir(made)).toEqual({ status: 'changed' });
      expect(mode(made)).toBe('700');
      expect(mode(parent)).toBe('755');
      expect(makePrivateDir(join(parent, 'missing'))).toEqual({ status: 'unchanged' });
    });

    it('makePrivateFile changes a regular file only', () => {
      const file = loose(join(parent, 'f'));
      expect(makePrivateFile(file)).toEqual({ status: 'changed' });
      expect(makePrivateFile(file)).toEqual({ status: 'unchanged' });
      expect(makePrivateFile(join(parent, 'missing'))).toEqual({ status: 'unchanged' });
      expect(makePrivateFile(outside)).toEqual({ status: 'unchanged' });
      expect(mode(outside)).toBe('755');
      const target = loose(join(outside, 't'));
      const link = join(parent, 'link');
      symlinkSync(target, link);
      expect(makePrivateFile(link)).toEqual({ status: 'unchanged' });
      expect(mode(target)).toBe('644');
    });

    it('createPrivateFile makes an empty 600 file and leaves an existing one', () => {
      const file = join(parent, 'new');
      createPrivateFile(file);
      expect(mode(file)).toBe('600');
      expect(statSync(file).size).toBe(0);
      const existing = loose(join(parent, 'old'));
      createPrivateFile(existing);
      expect(mode(existing)).toBe('644');
      expect(statSync(existing).size).toBe(1);
    });
  });
});
