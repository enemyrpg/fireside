import { BRANDING } from '@fireside/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiKey } from '../auth/api-keys.js';
import { createSecretBox, fileKeyStore, keyFilePath } from '../auth/secret-box.js';
import { databasePath, openDatabase } from '../db/index.js';
import { createBackup, InvalidDatabaseFileError, openCheckedDatabase } from './backup.js';
import { listBackupFolderFiles, listBackups, removeLeftoverTempFiles } from './files.js';
import * as gzip from './gzip.js';
import { pruneBackups, ReferenceClock } from './retention.js';
import { dumpTables, tempDir, unzipBackup, withBackup } from './testing.js';
import { TEST_OWNER } from '../test-utils.js';

const N = BRANDING.shortName;

const KEEP = { daily: 7, weekly: 4, monthly: 6 };
const BATCH = 10;

/**
 * A separate process that inserts events in transactions of `BATCH` rows
 * until it is killed, like ingest in a server while `pnpm cli backup` runs.
 * Prints "ready" after the first transaction.
 */
const WRITER = `
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { timeout: 5000 });
const insert = db.prepare(
  "INSERT INTO events (event_id, user_id, type, account_hash, session_id, occurred_at, received_at, " +
  "api_key_id, schema_version, payload) VALUES (?, 1, 'heartbeat', '1', 's', ?, ?, ?, 1, ?)");
const batch = db.transaction((n) => {
  for (let i = 0; i < ${String(BATCH)}; i++) {
    const t = new Date().toISOString();
    insert.run('w-' + n + '-' + i, t, t, Number(process.argv[2]), JSON.stringify({ n, i, pad: 'x'.repeat(500) }));
  }
});
let n = 0;
batch(n++);
console.log('ready');
const loop = () => { for (let k = 0; k < 20; k++) batch(n++); setImmediate(loop); };
loop();
`;

function startWriter(dbFile: string, apiKeyId: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', WRITER, dbFile, String(apiKeyId)], {
    cwd: join(import.meta.dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error(`Writer exited early with ${String(code)}`));
    });
    child.stdout.once('data', () => {
      resolve(child);
    });
  });
}

describe('createBackup', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function setup() {
    const { dir, remove } = tempDir();
    cleanups.push(remove);
    const dbFile = databasePath(join(dir, 'data'));
    const database = openDatabase(dbFile);
    cleanups.push(() => {
      database.close();
    });
    return { dir, dbFile, database, backupDir: join(dir, 'data', 'backups') };
  }

  it('takes consistent backups while another process writes', { timeout: 30_000 }, async () => {
    const { dbFile, database, backupDir } = setup();
    const { id } = createApiKey(database.db, TEST_OWNER, 'Writer');
    const writer = await startWriter(dbFile, id);
    cleanups.push(() => writer.kill('SIGKILL'));

    const count = () =>
      database.sqlite.prepare('SELECT count(*) FROM events').pluck().get() as number;
    for (let i = 0; i < 5; i++) {
      const before = count();
      const result = await createBackup({
        dbFile,
        dir: backupDir,
        keep: { daily: 0, weekly: 0, monthly: 0 },
        timeZone: 'UTC',
        // A new name every time, so retention keeps only the newest.
        now: () => new Date(Date.UTC(2026, 10, 14, 3, 0, i)),
      });
      const after = count();

      const unzipped = unzipBackup(result.path);
      const backup = openCheckedDatabase(unzipped.file);
      try {
        const inBackup = backup.prepare('SELECT count(*) FROM events').pluck().get() as number;
        expect(inBackup).toBeGreaterThanOrEqual(before);
        expect(inBackup).toBeLessThanOrEqual(after);
        // Never half a transaction.
        expect(inBackup % BATCH).toBe(0);
        expect(backup.pragma('journal_mode', { simple: true })).toBe('delete');
      } finally {
        backup.close();
        unzipped.remove();
      }
    }
    expect(count()).toBeGreaterThan(BATCH);
    // No `-wal` beside it, and no temp file left.
    expect(readdirSync(backupDir)).toEqual([`${N}-20261114-030004Z.db.gz`]);
  });

  it('includes data that is still only in the WAL file', async () => {
    const { dbFile, database, backupDir } = setup();
    createApiKey(database.db, TEST_OWNER, 'Only in WAL');
    expect(statSync(`${dbFile}-wal`).size).toBeGreaterThan(0);

    const result = await createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' });
    withBackup(result.path, (backup) => {
      expect(backup.prepare('SELECT name FROM api_keys').pluck().all()).toEqual(['Only in WAL']);
    });
    expect(result).toMatchObject({ count: 1, deleted: [] });
    expect(result.sizeBytes).toBe(statSync(result.path).size);
    expect(result.totalSizeBytes).toBe(result.sizeBytes);
  });

  it('never copies the 2FA key file next to the database', async () => {
    const { dir, dbFile, database, backupDir } = setup();
    const dataDir = join(dir, 'data');
    const sealed = createSecretBox(fileKeyStore(dataDir)).seal(1, 'JBSWY3DPEHPK3PXP');
    database.sqlite.prepare('UPDATE users SET totp_secret = ? WHERE id = 1').run(sealed);
    expect(existsSync(keyFilePath(dataDir))).toBe(true);

    const result = await createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' });
    expect(readdirSync(backupDir)).toEqual([result.fileName]);
    // The backup holds only the encrypted secret, never the key.
    withBackup(result.path, (backup) => {
      expect(backup.prepare('SELECT totp_secret FROM users').pluck().get()).toBe(sealed);
    });
  });

  it('gives a second backup in the same second its own name', async () => {
    const { dbFile, backupDir } = setup();
    const now = () => new Date('2026-11-14T03:00:00.000Z');
    const options = { dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC', now };
    expect((await createBackup(options)).fileName).toBe(`${N}-20261114-030000Z.db.gz`);
    expect((await createBackup(options)).fileName).toBe(`${N}-20261114-030000Z-2.db.gz`);
    // Both are on the same day: retention keeps the newest one.
    expect(listBackups(backupDir).map((backup) => backup.fileName)).toEqual([
      `${N}-20261114-030000Z-2.db.gz`,
    ]);
  });

  it('never shares a time and copy number with an uncompressed backup', async () => {
    const { dbFile, backupDir } = setup();
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, `${N}-20261114-030000Z.db`), 'an older backup');
    const result = await createBackup({
      dbFile,
      dir: backupDir,
      keep: { daily: 0, weekly: 0, monthly: 0 },
      timeZone: 'UTC',
      now: () => new Date('2026-11-14T03:00:00.000Z'),
    });
    expect(result.fileName).toBe(`${N}-20261114-030000Z-2.db.gz`);
  });

  it('applies retention after each backup', async () => {
    const { dbFile, backupDir } = setup();
    let day = 1;
    const run = () =>
      createBackup({
        dbFile,
        dir: backupDir,
        keep: { daily: 3, weekly: 0, monthly: 0 },
        timeZone: 'UTC',
        now: () => new Date(Date.UTC(2026, 10, day++, 3)),
      });
    for (let i = 0; i < 5; i++) await run();
    expect(listBackups(backupDir).map((backup) => backup.fileName)).toEqual([
      `${N}-20261105-030000Z.db.gz`,
      `${N}-20261104-030000Z.db.gz`,
      `${N}-20261103-030000Z.db.gz`,
    ]);
    expect((await run()).deleted).toEqual([`${N}-20261103-030000Z.db.gz`]);
  });

  it('fails without leaving files when the database is missing', async () => {
    const { dir } = setup();
    const backupDir = join(dir, 'other-backups');
    await expect(
      createBackup({
        dbFile: join(dir, 'missing.db'),
        dir: backupDir,
        keep: KEEP,
        timeZone: 'UTC',
      }),
    ).rejects.toThrow(/Can't open the database/);
    expect(readdirSync(backupDir)).toEqual([]);
  });

  it('writes a gzipped, private file that holds the same rows', async () => {
    const { dbFile, database, backupDir } = setup();
    createApiKey(database.db, TEST_OWNER, 'Laptop');
    const result = await createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' });

    expect(result.fileName).toMatch(new RegExp(`^${N}-\\d{8}-\\d{6}Z\\.db\\.gz$`));
    expect(readFileSync(result.path).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(result.sizeBytes).toBe(statSync(result.path).size);
    expect(result.uncompressedBytes).toBeGreaterThan(result.sizeBytes);
    // Only the backup is left: no uncompressed copy, no temp file.
    expect(readdirSync(backupDir)).toEqual([result.fileName]);

    const live = dumpTables(database.sqlite);
    withBackup(result.path, (backup) => {
      expect(dumpTables(backup)).toEqual(live);
    });
  });

  it('leaves nothing that counts as a backup when compressing fails', async () => {
    const { dbFile, backupDir } = setup();
    const failing = vi.spyOn(gzip, 'gzipFile').mockImplementation((_source, target) => {
      // Half a file, as a crash or a full disk would leave it.
      writeFileSync(target, gzipSync(Buffer.alloc(1 << 16)).subarray(0, 100));
      return Promise.reject(new Error('ENOSPC: no space left on device'));
    });
    try {
      await expect(
        createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' }),
      ).rejects.toThrow(/ENOSPC/);
    } finally {
      failing.mockRestore();
    }
    expect(readdirSync(backupDir)).toEqual([]);
  });

  it('leaves nothing that counts as a backup when the gzip stream fails', async () => {
    const { dbFile, backupDir } = setup();
    // A real stream error: the source can't be read once the target is open.
    const real = gzip.gzipFile;
    const failing = vi
      .spyOn(gzip, 'gzipFile')
      .mockImplementation((_source, target) => real(join(backupDir, 'gone'), target));
    try {
      await expect(
        createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' }),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      failing.mockRestore();
    }
    expect(readdirSync(backupDir)).toEqual([]);
  });

  it('never counts a half-written temp file, and retention removes it after an hour', () => {
    const { backupDir } = setup();
    mkdirSync(backupDir, { recursive: true });
    // What a backup killed while compressing leaves behind.
    const leftovers = [`.${N}-backup-0a1b2c.db.tmp`, `.${N}-backup-0a1b2c.gz.tmp`];
    for (const name of leftovers) writeFileSync(join(backupDir, name), 'half');
    const fresh = `.${N}-backup-3d4e5f.gz.tmp`;
    writeFileSync(join(backupDir, fresh), 'being written');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    for (const name of leftovers) utimesSync(join(backupDir, name), twoHoursAgo, twoHoursAgo);

    expect(listBackups(backupDir)).toEqual([]);
    expect(listBackupFolderFiles(backupDir)).toEqual([]);

    const removed: string[] = [];
    pruneBackups(backupDir, KEEP, 'UTC', {
      nowMs: Date.now(),
      clock: new ReferenceClock(() => 0),
      onLeftoverTempFiles: (names) => removed.push(...names),
    });
    expect(removed.sort()).toEqual([...leftovers].sort());
    expect(readdirSync(backupDir)).toEqual([fresh]);
  });

  it('removes only temp files older than an hour', () => {
    const { backupDir } = setup();
    mkdirSync(backupDir, { recursive: true });
    const old = join(backupDir, `.${N}-backup-old.tmp`);
    const fresh = join(backupDir, `.${N}-backup-new.tmp`);
    const other = join(backupDir, 'notes.txt');
    for (const file of [old, fresh, other]) writeFileSync(file, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    utimesSync(other, twoHoursAgo, twoHoursAgo);

    expect(removeLeftoverTempFiles(backupDir)).toEqual([`.${N}-backup-old.tmp`]);
    expect(readdirSync(backupDir).sort()).toEqual([`.${N}-backup-new.tmp`, 'notes.txt']);
    expect(removeLeftoverTempFiles(join(backupDir, 'missing'))).toEqual([]);
  });
});

describe('openCheckedDatabase', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function file(name: string, content: Buffer | string) {
    const { dir, remove } = tempDir();
    cleanups.push(remove);
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it.each([
    ['empty', ''],
    ['text', 'not a database at all'],
    ['random bytes', Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 7919) % 256))],
    ['header only', Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)])],
  ])('rejects %s', (name, content) => {
    expect(() => openCheckedDatabase(file(`${name}.db`, content))).toThrow(
      InvalidDatabaseFileError,
    );
  });

  it(`rejects an SQLite database that is not ${BRANDING.displayName}`, () => {
    const path = file('other.db', '');
    const other = new BetterSqlite3(path);
    other.exec('CREATE TABLE notes (text TEXT)');
    other.close();
    expect(() => openCheckedDatabase(path)).toThrow(/not a Fireside database/);
  });
});
