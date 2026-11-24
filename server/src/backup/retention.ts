import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, DAY_MS, fromLocal, periodKey, toLocal } from '@fireside/shared';
import type { RetentionConfig } from '../config.js';
import {
  filesWrittenThisRun,
  listBackupFolderFiles,
  newestFirst,
  parseBackupFolderName,
  removeLeftoverTempFiles,
  type BackupEntry,
  type BackupFile,
} from './files.js';

// Grandfather-father-son retention, in local time (`TZ`): keep the newest
// backup of each of the last N days, ISO weeks and months that have one.
// The newest backup overall is always kept, whatever the settings.
//
// On top of that, a max age: no file in the backup folder is kept longer than
// the longest level reaches (`BACKUP_KEEP_MONTHLY` months by default, 6), so
// data a user deleted is gone from every backup after that. It covers the
// copies taken before migrations and restores too. With every level at 0, those
// copies go once a newer regular backup exists.
//
// The max age is counted from a reference time, not the wall clock: the
// newest file that was there before this process started, plus a day, plus
// how long this process has run (monotonic clock), and never later than the
// wall clock. A clock that jumps ahead (or a wrong date at boot) therefore
// can't wipe the folder, and the time the server was stopped doesn't count:
// retention only runs while the server runs (after each backup and at
// start). The daily, weekly and monthly levels still use the file times.
//
// Temp files left by an interrupted backup (files.ts) are removed too, once
// they are an hour old, so a backup another process is writing is left alone.
//
// Never deleted: the newest backup, a copy this process took that is younger
// than the max age by the monotonic clock (with every level at 0: never in
// this process), and any file that isn't a backup or such a copy (files.ts).

/** Units of the retention levels. */
export type RetentionUnit = 'day' | 'week' | 'month';

const LEVELS: readonly [keyof RetentionConfig, RetentionUnit][] = [
  ['daily', 'day'],
  ['weekly', 'week'],
  ['monthly', 'month'],
];

/** File names to keep. `backups` can be in any order. */
export function backupsToKeep(
  backups: readonly Pick<BackupEntry, 'fileName' | 'createdAtMs'>[],
  keep: RetentionConfig,
  timeZone: string,
): Set<string> {
  const sorted = [...backups].sort(newestFirst);
  const kept = new Set<string>();
  const newest = sorted[0];
  if (newest) kept.add(newest.fileName);

  for (const [level, unit] of LEVELS) {
    const periods = new Set<string>();
    for (const backup of sorted) {
      if (periods.size >= keep[level]) break;
      const key = periodKey(backup.createdAtMs, unit, timeZone);
      if (periods.has(key)) continue;
      // The first one seen in a period is its newest.
      periods.add(key);
      kept.add(backup.fileName);
    }
  }
  return kept;
}

/** How far back the longest level reaches: e.g. 6 months. */
export interface RetentionHorizon {
  count: number;
  unit: RetentionUnit;
}

/** Rough length of a unit in days, only to compare levels. */
const UNIT_DAYS: Record<RetentionUnit, number> = { day: 1, week: 7, month: 31 };

/** Shortest length of a unit in days, for the monotonic protection of new copies. */
const MIN_UNIT_DAYS: Record<RetentionUnit, number> = { day: 1, week: 7, month: 28 };

/**
 * The longest level that is on (`null` when every level is 0, so only the
 * newest backup is kept). This is the max age of every file in the folder.
 */
export function retentionHorizon(keep: RetentionConfig): RetentionHorizon | null {
  let longest: RetentionHorizon | null = null;
  for (const [level, unit] of LEVELS) {
    const count = keep[level];
    if (count <= 0) continue;
    if (!longest || count * UNIT_DAYS[unit] > longest.count * UNIT_DAYS[longest.unit]) {
      longest = { count, unit };
    }
  }
  return longest;
}

/**
 * The oldest time (UTC ms) a file may have: `referenceMs` minus the horizon,
 * in local time. A month back on the 31st is the last day of the shorter
 * month. `null` when every level is 0 (see `filesToDelete`).
 */
export function maxAgeCutoff(
  referenceMs: number,
  keep: RetentionConfig,
  timeZone: string,
): number | null {
  const horizon = retentionHorizon(keep);
  if (!horizon) return null;
  const local = toLocal(referenceMs, timeZone);
  let date: { year: number; month: number; day: number };
  if (horizon.unit === 'month') {
    const months = local.year * 12 + (local.month - 1) - horizon.count;
    const year = Math.floor(months / 12);
    const month = (months % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    date = { year, month, day: Math.min(local.day, lastDay) };
  } else {
    date = addDays(local, -horizon.count * (horizon.unit === 'week' ? 7 : 1));
  }
  return fromLocal(date, local.hour, local.minute, timeZone);
}

/** Called when the wall clock is more than a day ahead of the reference time. */
export type ClockAheadHandler = (wallClockMs: number, referenceMs: number) => void;

/**
 * The reference time for the max age, per backup folder. The base (the
 * newest file time from before this process started) is read on first use
 * and kept for the life of the process.
 */
export class ReferenceClock {
  private readonly bases = new Map<string, number | null>();
  private warned = false;

  /** `monotonic`: ms since this process started. */
  constructor(private readonly monotonic: () => number = () => performance.now()) {}

  /**
   * min(wall clock, base + 1 day + time this process has run), or the wall
   * clock when the folder had no files before this process. Calls
   * `onClockAhead` once per process when the wall clock is more than a day
   * ahead of it.
   */
  referenceMs(
    dir: string,
    files: readonly BackupFile[],
    nowMs: number,
    written: ReadonlySet<string>,
    onClockAhead?: ClockAheadHandler,
  ): number {
    let base = this.bases.get(dir);
    if (base === undefined) {
      const before = files.filter((file) => !written.has(file.fileName));
      base = before.length > 0 ? Math.max(...before.map((file) => file.createdAtMs)) : null;
      this.bases.set(dir, base);
    }
    if (base === null) return nowMs;
    const referenceMs = Math.min(nowMs, base + DAY_MS + this.monotonic());
    if (nowMs - referenceMs > DAY_MS && !this.warned) {
      this.warned = true;
      onClockAhead?.(nowMs, referenceMs);
    }
    return referenceMs;
  }
}

/** The reference clock of this process. */
const processClock = new ReferenceClock();

export interface DeleteOptions {
  /** Time the max age is counted from (see `ReferenceClock`). */
  referenceMs: number;
  /** Never deleted. Default: copies this process took that are still protected. */
  protect?: ReadonlySet<string>;
}

/**
 * Copies (before a migration or restore) this process took that retention
 * must not delete yet: younger than the max age by the monotonic clock, or
 * all of them when every level is 0.
 */
function protectedCopies(keep: RetentionConfig): ReadonlySet<string> {
  const horizon = retentionHorizon(keep);
  const maxAgeMs = horizon ? horizon.count * MIN_UNIT_DAYS[horizon.unit] * DAY_MS : Infinity;
  const now = performance.now();
  const names = new Set<string>();
  for (const [fileName, at] of filesWrittenThisRun()) {
    const kind = parseBackupFolderName(fileName)?.kind;
    if (kind !== undefined && kind !== 'backup' && now - at < maxAgeMs) names.add(fileName);
  }
  return names;
}

/** Names of the files retention deletes, from `files` (any order). */
export function filesToDelete(
  files: readonly BackupFile[],
  keep: RetentionConfig,
  timeZone: string,
  { referenceMs, protect = protectedCopies(keep) }: DeleteOptions,
): string[] {
  const backups = files.filter((file) => file.kind === 'backup');
  const kept = backupsToKeep(backups, keep, timeZone);
  const newest = [...backups].sort(newestFirst)[0];
  // Every level at 0: only the newest backup is kept, and a copy taken
  // before a migration or restore goes once a newer backup exists.
  const cutoff = maxAgeCutoff(referenceMs, keep, timeZone) ?? newest?.createdAtMs ?? -Infinity;
  return files
    .filter((file) => {
      if (protect.has(file.fileName) || file.fileName === newest?.fileName) return false;
      if (file.createdAtMs < cutoff) return true;
      return file.kind === 'backup' && !kept.has(file.fileName);
    })
    .map((file) => file.fileName);
}

export interface PruneOptions {
  /** The wall clock. */
  nowMs: number;
  /** Never deleted. Default: copies this process took that are still protected. */
  protect?: ReadonlySet<string>;
  /** Default: the clock of this process. Tests pass their own. */
  clock?: ReferenceClock;
  /** Logs once when the wall clock is more than a day ahead of the backups. */
  onClockAhead?: ClockAheadHandler;
  /** Called with the temp files of interrupted backups that were removed, if any. */
  onLeftoverTempFiles?: (fileNames: string[]) => void;
}

/**
 * Deletes backups in `dir` that retention doesn't keep, every backup or copy
 * older than the max age, and temp files left by interrupted backups. Returns
 * the deleted backups and copies.
 */
export function pruneBackups(
  dir: string,
  keep: RetentionConfig,
  timeZone: string,
  { nowMs, protect, clock = processClock, onClockAhead, onLeftoverTempFiles }: PruneOptions,
): string[] {
  // By the real clock, not `nowMs`: it is compared with the files' mtime.
  const leftovers = removeLeftoverTempFiles(dir);
  if (leftovers.length > 0) onLeftoverTempFiles?.(leftovers);
  const files = listBackupFolderFiles(dir);
  const written = new Set(filesWrittenThisRun().keys());
  const referenceMs = clock.referenceMs(dir, files, nowMs, written, onClockAhead);
  const deleted = filesToDelete(files, keep, timeZone, {
    referenceMs,
    ...(protect ? { protect } : {}),
  });
  // `force` ignores a file another process deleted first.
  for (const fileName of deleted) rmSync(join(dir, fileName), { force: true });
  return deleted;
}
