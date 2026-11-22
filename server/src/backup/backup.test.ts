import { BRANDING } from '@fireside/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiKey } from '../auth/api-keys.js';
import { createSecretBox, fileKeyStore, keyFilePath } from '../auth/secret-box.js';
import { databasePath, openDatabase } from '../db/index.js';
import {
  createBackup,
  InvalidDatabaseFileError,
  openCheckedDatabase,
  removeLeftoverTempFiles,
} from './backup.js';
import { listBackups } from './files.js';
import { tempDir } from './testing.js';
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
      const result = createBackup({
        dbFile,
        dir: backupDir,
        keep: { daily: 0, weekly: 0, monthly: 0 },
        timeZone: 'UTC',
        // A new name every time, so retention keeps only the newest.
        now: () => new Date(Date.UTC(2026, 10, 14, 3, 0, i)),
      });
      const after = count();

      const backup = openCheckedDatabase(result.path);
      try {
        const inBackup = backup.prepare('SELECT count(*) FROM events').pluck().get() as number;
        expect(inBackup).toBeGreaterThanOrEqual(before);
        expect(inBackup).toBeLessThanOrEqual(after);
        // Never half a transaction.
        expect(inBackup % BATCH).toBe(0);
        expect(backup.pragma('journal_mode', { simple: true })).toBe('delete');
      } finally {
        backup.close();
      }
      expect(existsSync(`${result.path}-wal`)).toBe(false);
    }
    expect(count()).toBeGreaterThan(BATCH);
    expect(readdirSync(backupDir)).toEqual([`${N}-20261114-030004Z.db`]);
  });

  it('includes data that is still only in the WAL file', () => {
    const { dbFile, database, backupDir } = setup();
    createApiKey(database.db, TEST_OWNER, 'Only in WAL');
    expect(statSync(`${dbFile}-wal`).size).toBeGreaterThan(0);

    const result = createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' });
    const backup = new BetterSqlite3(result.path, { readonly: true });
    try {
      expect(backup.prepare('SELECT name FROM api_keys').pluck().all()).toEqual(['Only in WAL']);
    } finally {
      backup.close();
    }
    expect(result).toMatchObject({ count: 1, deleted: [] });
    expect(result.sizeBytes).toBe(statSync(result.path).size);
    expect(result.totalSizeBytes).toBe(result.sizeBytes);
  });

  it('never copies the 2FA key file next to the database', () => {
    const { dir, dbFile, database, backupDir } = setup();
    const dataDir = join(dir, 'data');
    const sealed = createSecretBox(fileKeyStore(dataDir)).seal(1, 'JBSWY3DPEHPK3PXP');
    database.sqlite.prepare('UPDATE users SET totp_secret = ? WHERE id = 1').run(sealed);
    expect(existsSync(keyFilePath(dataDir))).toBe(true);

    const result = createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' });
    expect(readdirSync(backupDir)).toEqual([result.fileName]);
    // The backup holds only the encrypted secret, never the key.
    const backup = new BetterSqlite3(result.path, { readonly: true });
    try {
      expect(backup.prepare('SELECT totp_secret FROM users').pluck().get()).toBe(sealed);
    } finally {
      backup.close();
    }
  });

  it('gives a second backup in the same second its own name', () => {
    const { dbFile, backupDir } = setup();
    const now = () => new Date('2026-11-14T03:00:00.000Z');
    const options = { dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC', now };
    expect(createBackup(options).fileName).toBe(`${N}-20261114-030000Z.db`);
    expect(createBackup(options).fileName).toBe(`${N}-20261114-030000Z-2.db`);
    // Both are on the same day: retention keeps the newest one.
    expect(listBackups(backupDir).map((backup) => backup.fileName)).toEqual([
      `${N}-20261114-030000Z-2.db`,
    ]);
  });

  it('applies retention after each backup', () => {
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
    for (let i = 0; i < 5; i++) run();
    expect(listBackups(backupDir).map((backup) => backup.fileName)).toEqual([
      `${N}-20261105-030000Z.db`,
      `${N}-20261104-030000Z.db`,
      `${N}-20261103-030000Z.db`,
    ]);
    expect(run().deleted).toEqual([`${N}-20261103-030000Z.db`]);
  });

  it('fails without leaving files when the database is missing', () => {
    const { dir } = setup();
    const backupDir = join(dir, 'other-backups');
    expect(() =>
      createBackup({
        dbFile: join(dir, 'missing.db'),
        dir: backupDir,
        keep: KEEP,
        timeZone: 'UTC',
      }),
    ).toThrow(/Can't open the database/);
    expect(readdirSync(backupDir)).toEqual([]);
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
