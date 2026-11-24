import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupStatusResponseSchema, BRANDING } from '@fireside/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import * as backupModule from '../backup/backup.js';
import { backupFileName, listBackups, preMigrateFileName } from '../backup/files.js';
import * as gzip from '../backup/gzip.js';
import { tempDir } from '../backup/testing.js';
import { loadConfig, type BackupConfig } from '../config.js';
import { databasePath, openDatabase } from '../db/index.js';
import { testConfig } from '../test-utils.js';
import { backupStatus, nextBackupTime, startBackupJob } from './backup.js';

const N = BRANDING.shortName;

const OSLO = 'Europe/Oslo';
const at = (iso: string) => Date.parse(iso);

describe('nextBackupTime', () => {
  const four = { hour: 4, minute: 0 };

  it.each([
    // Winter: 04:00 in Oslo is 03:00 UTC.
    ['2026-11-14T01:00:00.000Z', '2026-11-14T03:00:00.000Z'],
    ['2026-11-14T03:00:00.000Z', '2026-11-15T03:00:00.000Z'],
    ['2026-11-14T12:00:00.000Z', '2026-11-15T03:00:00.000Z'],
    // Summer: 02:00 UTC.
    ['2026-07-01T12:00:00.000Z', '2026-07-02T02:00:00.000Z'],
    // Across New Year.
    ['2026-12-31T12:00:00.000Z', '2027-01-01T03:00:00.000Z'],
  ])('after %s is %s', (after, expected) => {
    expect(new Date(nextBackupTime(at(after), four, OSLO)).toISOString()).toBe(expected);
  });

  it('runs a time skipped by DST at the first instant after the gap', () => {
    // 29 March 2026: Oslo skips 02:00–03:00.
    const next = nextBackupTime(at('2026-03-28T12:00:00Z'), { hour: 2, minute: 30 }, OSLO);
    expect(new Date(next).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('runs a time that happens twice only the first time', () => {
    // 25 October 2026: 02:30 happens at 00:30 and 01:30 UTC.
    const time = { hour: 2, minute: 30 };
    const first = nextBackupTime(at('2026-10-24T12:00:00Z'), time, OSLO);
    expect(new Date(first).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(new Date(nextBackupTime(first, time, OSLO)).toISOString()).toBe(
      '2026-10-26T01:30:00.000Z',
    );
  });
});

describe('backup job', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function setup(env: Record<string, string> = {}) {
    const { dir, remove } = tempDir();
    cleanups.push(remove);
    const config = loadConfig({ DATA_DIR: dir, TZ: OSLO, ...env });
    const dbFile = databasePath(config.dataDir);
    const database = openDatabase(dbFile);
    cleanups.push(() => {
      database.close();
    });
    const logs: { level: string; msg: string; obj: object }[] = [];
    const log = {
      info: (obj: object, msg: string) => logs.push({ level: 'info', msg, obj }),
      warn: (obj: object, msg: string) => logs.push({ level: 'warn', msg, obj }),
      error: (obj: object, msg: string) => logs.push({ level: 'error', msg, obj }),
    };
    return { config, dbFile, logs, log };
  }

  function start(
    s: ReturnType<typeof setup>,
    clock: { now: Date },
    config: BackupConfig = s.config.backup,
  ) {
    const job = startBackupJob({
      dbFile: s.dbFile,
      config,
      timeZone: OSLO,
      log: s.log,
      now: () => clock.now,
      intervalMs: 60_000,
    });
    cleanups.push(() => {
      job.stop();
    });
    return job;
  }

  const status = (s: ReturnType<typeof setup>, job?: ReturnType<typeof start>) =>
    backupStatusResponseSchema.parse(backupStatus(s.config.backup, OSLO, job?.state()));

  it('backs up at start when there is no backup, then daily at BACKUP_TIME', async () => {
    vi.useFakeTimers();
    const s = setup();
    const clock = { now: new Date('2026-11-14T12:00:00.000Z') };
    const job = start(s, clock);
    await job.idle();
    expect(status(s, job)).toMatchObject({
      enabled: true,
      count: 1,
      latest: { fileName: `${N}-20261114-120000Z.db.gz` },
      nextRunAt: '2026-11-15T03:00:00.000Z',
      lastError: null,
    });
    expect(s.logs).toEqual([
      expect.objectContaining({
        msg: 'Backup done',
        obj: expect.objectContaining({ reason: 'startup' }) as object,
      }),
    ]);

    // Not yet due.
    clock.now = new Date('2026-11-15T02:59:00.000Z');
    vi.advanceTimersByTime(60_000);
    expect(status(s, job).count).toBe(1);

    // The laptop slept past 04:00: the next check takes the backup.
    clock.now = new Date('2026-11-15T07:13:00.000Z');
    vi.advanceTimersByTime(60_000);
    await job.idle();
    expect(status(s, job)).toMatchObject({
      count: 2,
      latest: { fileName: `${N}-20261115-071300Z.db.gz` },
      nextRunAt: '2026-11-16T03:00:00.000Z',
    });
    vi.advanceTimersByTime(60_000);
    expect(status(s, job).count).toBe(2);
  });

  it('skips the startup backup when the newest one is less than 24 hours old', async () => {
    const s = setup();
    mkdirSync(s.config.backup.dir, { recursive: true });
    const recent = backupFileName(at('2026-11-13T13:00:00Z'));
    writeFileSync(join(s.config.backup.dir, recent), 'x');
    await start(s, { now: new Date('2026-11-14T12:00:00.000Z') }).idle();
    expect(status(s).latest?.fileName).toBe(recent);

    // A day and a bit later it is taken.
    await start(s, { now: new Date('2026-11-14T13:00:01.000Z') }).idle();
    expect(status(s)).toMatchObject({
      count: 2,
      latest: { fileName: `${N}-20261114-130001Z.db.gz` },
    });
  });

  it('keeps the last error until a backup succeeds', async () => {
    vi.useFakeTimers();
    const s = setup();
    // A file where the folder should be: every backup fails.
    writeFileSync(s.config.backup.dir, 'not a folder');
    const clock = { now: new Date('2026-11-14T12:00:00.000Z') };
    const job = start(s, clock);
    await job.idle();
    expect(status(s, job).lastError).toMatchObject({ at: '2026-11-14T12:00:00.000Z' });
    expect(status(s, job).lastError?.message).toMatch(/EEXIST|ENOTDIR/);
    expect(s.logs.at(-1)).toMatchObject({ level: 'error', msg: 'Backup failed' });

    // Fixed before the next scheduled run.
    rmSync(s.config.backup.dir);
    clock.now = new Date('2026-11-15T03:00:00.000Z');
    vi.advanceTimersByTime(60_000);
    await job.idle();
    expect(status(s, job)).toMatchObject({ count: 1, lastError: null });
  });

  it('never runs two backups at once: a tick meanwhile waits for the next minute', async () => {
    vi.useFakeTimers();
    const s = setup();
    const real = backupModule.createBackup;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const slow = vi.spyOn(backupModule, 'createBackup').mockImplementation(async (options) => {
      calls.push((options.now ?? (() => new Date()))().toISOString());
      // The startup backup takes long (compressing a large database).
      if (calls.length === 1) await gate;
      return real(options);
    });
    cleanups.push(() => {
      slow.mockRestore();
    });
    const clock = { now: new Date('2026-11-15T02:58:00.000Z') };
    const job = start(s, clock);

    // 04:00 Oslo passes while the startup backup is still running.
    clock.now = new Date('2026-11-15T03:00:30.000Z');
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(1);

    release();
    await job.idle();
    // The next check takes the scheduled backup.
    clock.now = new Date('2026-11-15T03:01:30.000Z');
    vi.advanceTimersByTime(60_000);
    await job.idle();
    expect(calls).toEqual(['2026-11-15T02:58:00.000Z', '2026-11-15T03:01:30.000Z']);
    expect(status(s, job).nextRunAt).toBe('2026-11-16T03:00:00.000Z');
  });

  it('reports an unreadable backup folder instead of failing', () => {
    const s = setup({ BACKUP_ENABLED: 'false' });
    writeFileSync(s.config.backup.dir, 'not a folder');
    expect(status(s)).toMatchObject({
      count: 0,
      latest: null,
      lastError: { message: expect.stringMatching(/^Can't read the backup folder/) as string },
    });
  });

  it('does nothing when automatic backups are off', () => {
    vi.useFakeTimers();
    const s = setup({ BACKUP_ENABLED: 'false' });
    const clock = { now: new Date('2026-11-14T12:00:00.000Z') };
    const job = start(s, clock);
    clock.now = new Date('2026-11-20T12:00:00.000Z');
    vi.advanceTimersByTime(10 * 60_000);
    expect(status(s, job)).toEqual({
      enabled: false,
      latest: null,
      count: 0,
      totalSizeBytes: 0,
      nextRunAt: null,
      lastError: null,
    });
    expect(s.logs).toEqual([]);
  });

  it('removes copies older than the max age at start, also with automatic backups off', () => {
    vi.useFakeTimers();
    const s = setup({ BACKUP_ENABLED: 'false' });
    mkdirSync(s.config.backup.dir, { recursive: true });
    const old = preMigrateFileName(Date.parse('2026-04-01T03:00:00Z'));
    const recent = preMigrateFileName(Date.parse('2026-10-01T03:00:00Z'));
    for (const name of [old, recent, 'keep-me.txt']) {
      writeFileSync(join(s.config.backup.dir, name), 'x');
    }
    start(s, { now: new Date('2026-11-14T12:00:00.000Z') });
    expect(readdirSync(s.config.backup.dir).sort()).toEqual(['keep-me.txt', recent].sort());
    expect(s.logs.map((entry) => entry.msg)).toEqual([
      expect.stringContaining('the max age of backups counts only the time the server has run'),
      'Removed old backups',
    ]);
    expect(s.logs[0]?.obj).toEqual({
      clock: '2026-11-14T12:00:00.000Z',
      reference: '2026-10-02T03:00:00.000Z',
    });
  });

  it('stops', async () => {
    vi.useFakeTimers();
    const s = setup();
    const clock = { now: new Date('2026-11-14T12:00:00.000Z') };
    const job = start(s, clock);
    await job.idle();
    job.stop();
    clock.now = new Date('2026-11-16T12:00:00.000Z');
    vi.advanceTimersByTime(10 * 60_000);
    expect(status(s).count).toBe(1);
  });

  /** A createBackup that waits for `release()` before it does the real work. */
  function gatedBackups() {
    const real = backupModule.createBackup;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const spy = vi.spyOn(backupModule, 'createBackup').mockImplementation(async (options) => {
      started();
      await gate;
      return real(options);
    });
    cleanups.push(() => {
      spy.mockRestore();
    });
    return { release, started: startedPromise };
  }

  it('shutdown waits for a backup that is running, and nothing runs after it', async () => {
    const s = setup();
    const { release, started } = gatedBackups();
    const job = start(s, { now: new Date('2026-11-14T12:00:00.000Z') });
    await started;

    let done = false;
    const shutdown = job.shutdown(60_000).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toBe(false);

    release();
    await shutdown;
    expect(listBackups(s.config.backup.dir).map((b) => b.fileName)).toEqual([
      `${N}-20261114-120000Z.db.gz`,
    ]);
    expect(readdirSync(s.config.backup.dir)).toEqual([`${N}-20261114-120000Z.db.gz`]);
  });

  it('shutdown stops a backup that runs too long, leaving no backup and no temp files', async () => {
    const s = setup();
    // Compressing that never ends by itself, but stops when told to.
    const slow = vi.spyOn(gzip, 'gzipFile').mockImplementation((_source, target, signal) => {
      writeFileSync(target, 'half');
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    });
    cleanups.push(() => {
      slow.mockRestore();
    });
    const job = start(s, { now: new Date('2026-11-14T12:00:00.000Z') });
    await vi.waitFor(() => {
      expect(slow).toHaveBeenCalled();
    });

    await job.shutdown(50);
    expect(readdirSync(s.config.backup.dir)).toEqual([]);
    expect(job.state().lastError).toBeNull();
    expect(s.logs.at(-1)).toMatchObject({
      level: 'warn',
      msg: 'Backup stopped: the server is shutting down',
    });
  });

  it('the server waits for a running backup before it closes (and releases the lock)', async () => {
    const s = setup();
    const { release, started } = gatedBackups();
    const database = openDatabase(s.dbFile);
    const app = buildApp({
      db: database,
      dbFile: s.dbFile,
      config: testConfig({ DATA_DIR: s.config.dataDir, TZ: OSLO }),
      jobs: true,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    // The startup backup (there is none yet).
    await started;

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);

    release();
    await closing;
    // Finished before the server closed: renamed, pruned, no temp files.
    expect(readdirSync(s.config.backup.dir)).toHaveLength(1);
    expect(listBackups(s.config.backup.dir)).toHaveLength(1);
  });
});
