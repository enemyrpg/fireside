import { addDays, DAY_MS, fromLocal, toLocal, type BackupStatusResponse } from '@fireside/shared';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { createBackup, errorMessage, removeLeftoverTempFiles } from '../backup/backup.js';
import { listBackups, type BackupEntry } from '../backup/files.js';
import { pruneBackups } from '../backup/retention.js';
import type { BackupConfig } from '../config.js';
import type { JobLogger, RunningJob } from './session-timeout.js';

/** How often the job checks whether a backup is due. */
export const BACKUP_CHECK_INTERVAL_MS = 60_000;

/** A startup backup is taken when the newest one is older than this. */
export const STARTUP_BACKUP_AGE_MS = DAY_MS;

/**
 * The first time after `afterMs` (UTC ms) when the local clock in `timeZone`
 * shows `time`. A time skipped by a DST change runs at the first instant after
 * the gap; a time that happens twice runs the first time.
 */
export function nextBackupTime(
  afterMs: number,
  time: BackupConfig['time'],
  timeZone: string,
): number {
  const today = toLocal(afterMs, timeZone);
  for (let days = 0; days <= 2; days++) {
    const at = fromLocal(addDays(today, days), time.hour, time.minute, timeZone);
    if (at > afterMs) return at;
  }
  // Unreachable: some day within two days always has the time.
  throw new Error('No next backup time');
}

export interface BackupJobOptions {
  dbFile: string;
  config: BackupConfig;
  timeZone: string;
  log: JobLogger;
  now?: Clock;
  intervalMs?: number;
}

/** What the status endpoint needs from the job. */
export interface BackupJobState {
  nextRunAt: Date | null;
  lastError: { at: Date; message: string } | null;
}

export interface BackupJob extends RunningJob {
  state(): BackupJobState;
}

/**
 * Daily backup while the server runs: retention at start (max age, see
 * backup/retention.ts), a backup at start if the newest backup is
 * older than 24 hours (or there is none), then every day at `BACKUP_TIME` in
 * `TZ`. Checks once a minute whether the time has passed, so sleep, clock
 * changes and DST don't skip a day. Errors are logged and kept for the status
 * endpoint; the next run tries again.
 */
export function startBackupJob({
  dbFile,
  config,
  timeZone,
  log,
  now = systemClock,
  intervalMs = BACKUP_CHECK_INTERVAL_MS,
}: BackupJobOptions): BackupJob {
  let stopped = false;
  let lastError: BackupJobState['lastError'] = null;
  let nextRunAt = nextBackupTime(now().getTime(), config.time, timeZone);

  // Once per process (retention.ts): after a long stop, with automatic
  // backups off, or with a clock that jumped ahead.
  const onClockAhead = (wallClockMs: number, referenceMs: number) => {
    log.warn(
      {
        clock: new Date(wallClockMs).toISOString(),
        reference: new Date(referenceMs).toISOString(),
      },
      'The clock is more than a day past the newest backup from before this start (a long stop, or a wrong clock): the max age of backups counts only the time the server has run',
    );
  };

  const runBackup = (reason: 'startup' | 'scheduled') => {
    try {
      const result = createBackup({
        dbFile,
        dir: config.dir,
        keep: config.keep,
        timeZone,
        now,
        onClockAhead,
      });
      lastError = null;
      log.info(
        {
          reason,
          file: result.fileName,
          sizeBytes: result.sizeBytes,
          durationMs: result.durationMs,
          kept: result.count,
          deleted: result.deleted.length,
        },
        'Backup done',
      );
    } catch (error) {
      lastError = { at: now(), message: errorMessage(error) };
      log.error({ err: error, reason }, 'Backup failed');
    }
  };

  const tick = () => {
    if (stopped) return;
    const nowMs = now().getTime();
    if (nowMs < nextRunAt) return;
    nextRunAt = nextBackupTime(nowMs, config.time, timeZone);
    runBackup('scheduled');
  };

  // Max age at start too, also with automatic backups off: the copy taken
  // before a migration may be the only file written for weeks.
  try {
    const deleted = pruneBackups(config.dir, config.keep, timeZone, {
      nowMs: now().getTime(),
      onClockAhead,
    });
    if (deleted.length > 0) log.info({ deleted: deleted.length }, 'Removed old backups');
  } catch (error) {
    log.error({ err: error }, 'Removing old backups failed');
  }

  if (config.enabled) {
    try {
      const removed = removeLeftoverTempFiles(config.dir, now);
      if (removed.length > 0) log.warn({ removed }, 'Removed unfinished backup files');
      const newest = listBackups(config.dir)[0];
      if (!newest || now().getTime() - newest.createdAtMs > STARTUP_BACKUP_AGE_MS) {
        runBackup('startup');
      }
    } catch (error) {
      lastError = { at: now(), message: errorMessage(error) };
      log.error({ err: error }, 'Backup failed');
    }
  }

  const timer = config.enabled ? setInterval(tick, intervalMs) : undefined;
  // Never keeps the process alive on its own.
  timer?.unref();

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    state: () => ({
      nextRunAt: config.enabled ? new Date(nextRunAt) : null,
      lastError,
    }),
  };
}

/**
 * Status for `GET /admin/backups`, from the folder and the job's state.
 * Without a job (tests, or before the server listens) the next run is computed.
 */
export function backupStatus(
  config: BackupConfig,
  timeZone: string,
  state: BackupJobState | undefined,
  now: Clock = systemClock,
): BackupStatusResponse {
  const nextRunAt = config.enabled
    ? (state?.nextRunAt ?? new Date(nextBackupTime(now().getTime(), config.time, timeZone)))
    : null;
  let backups: BackupEntry[] = [];
  let listError: BackupJobState['lastError'] = null;
  try {
    backups = listBackups(config.dir);
  } catch (error) {
    listError = { at: now(), message: `Can't read the backup folder: ${errorMessage(error)}` };
  }
  const lastError = state?.lastError ?? listError;
  const latest = backups[0];
  return {
    enabled: config.enabled,
    latest: latest
      ? {
          fileName: latest.fileName,
          createdAt: new Date(latest.createdAtMs).toISOString(),
          sizeBytes: latest.sizeBytes,
        }
      : null,
    count: backups.length,
    totalSizeBytes: backups.reduce((sum, backup) => sum + backup.sizeBytes, 0),
    nextRunAt: nextRunAt?.toISOString() ?? null,
    lastError: lastError ? { at: lastError.at.toISOString(), message: lastError.message } : null,
  };
}
