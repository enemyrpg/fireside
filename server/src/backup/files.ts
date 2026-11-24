import { closeSync, existsSync, fsyncSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';

// Backup file names and listing. A backup is named after the time it was
// taken, in UTC, so names sort by time and never repeat at DST changes:
//   fireside-20261114-030000Z.db.gz   (a second one in the same second: …Z-2.db.gz)
// Backups are gzipped (backup.ts). Older ones, from before backups were
// compressed, end in `.db`: they count as backups the same way, and `restore`
// reads both. Only names that match count as backups. Copies kept by `restore`
// (`fireside-pre-restore-….db`, and `….db-wal` when the database was copied
// raw) and taken before migrations (`fireside-pre-migrate-….db`) are not
// backups: the status and `restore` ignore them, and the daily, weekly and
// monthly levels never keep them. Retention deletes them after the max age
// (retention.ts). No other file in the folder is ever deleted.

const NAME = BRANDING.shortName;
const BACKUP_NAME = new RegExp(`^${NAME}-(\\d{8})-(\\d{6})Z(?:-(\\d+))?\\.db(?:\\.gz)?$`);
const PRE_MIGRATE_NAME = new RegExp(`^${NAME}-pre-migrate-(\\d{8})-(\\d{6})Z(?:-(\\d+))?\\.db$`);
const PRE_RESTORE_NAME = new RegExp(`^${NAME}-pre-restore-(\\d{8})-(\\d{6})Z\\.db(?:-wal)?$`);

/**
 * Files this process wrote to the backup folder, with when on the monotonic
 * clock. Retention uses it twice: copies taken before a migration or restore
 * are protected for a while whatever the time in their name says, and the
 * reference time for the max age (retention.ts) only counts files that were
 * there before this process started.
 */
const writtenThisRun = new Map<string, number>();

/** Marks a file in the backup folder as written by this process. */
export function markWrittenThisRun(fileName: string): void {
  writtenThisRun.set(fileName, performance.now());
}

/** Files this process wrote, with when (`performance.now()`). */
export function filesWrittenThisRun(): ReadonlyMap<string, number> {
  return writtenThisRun;
}

/**
 * Prefix of temporary files while a backup is written (`….db.tmp` from
 * `VACUUM INTO`, `….gz.tmp` while it is compressed). They never match a
 * backup name, so a backup interrupted halfway never counts. Retention
 * removes them when they are left behind (`removeLeftoverTempFiles`).
 */
export const TEMP_PREFIX = `.${NAME}-backup-`;
export const TEMP_SUFFIX = '.tmp';

export interface BackupEntry {
  fileName: string;
  /** When the backup was taken (from the name), UTC milliseconds. */
  createdAtMs: number;
  sizeBytes: number;
}

function stamp(ms: number): string {
  // 2026-11-14T03:00:00.000Z → 20261114-030000Z
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}Z`;
}

/** Name of a backup taken at `ms`. `copy` > 1 for a second backup in the same second. */
export function backupFileName(ms: number, copy = 1): string {
  return `${NAME}-${stamp(ms)}${copy > 1 ? `-${String(copy)}` : ''}.db.gz`;
}

/**
 * Whether a backup with this time and copy number is already in `dir`,
 * compressed or not: a new backup must not share its time and copy number
 * with an older uncompressed one.
 */
export function isBackupNameTaken(dir: string, ms: number, copy: number): boolean {
  const name = backupFileName(ms, copy);
  const plain = name.slice(0, -'.gz'.length);
  return existsSync(join(dir, name)) || existsSync(join(dir, plain));
}

/** UTC ms from the date and time groups of a name, or `undefined` if they aren't a real time. */
function stampToMs(date: string, time: string): number | undefined {
  const ms = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  );
  // Rejects dates like 20261340 that Date.UTC would roll over.
  return Number.isNaN(ms) || stamp(ms) !== `${date}-${time}Z` ? undefined : ms;
}

/** Name of the copy of the current database that `restore` keeps. */
export function preRestoreFileName(ms: number): string {
  return `${NAME}-pre-restore-${stamp(ms)}.db`;
}

/**
 * Name of the copy taken before migrations (backup/pre-migrate.ts). `copy` > 1
 * for a second one in the same second.
 */
export function preMigrateFileName(ms: number, copy = 1): string {
  return `${NAME}-pre-migrate-${stamp(ms)}${copy > 1 ? `-${String(copy)}` : ''}.db`;
}

/** The time in a backup name (UTC ms), or `undefined` if it isn't a backup name. */
export function parseBackupFileName(fileName: string): number | undefined {
  const match = BACKUP_NAME.exec(fileName);
  if (!match) return undefined;
  return stampToMs(match[1] ?? '', match[2] ?? '');
}

/** Kinds of files retention may delete. */
export type BackupFileKind = 'backup' | 'pre-migrate' | 'pre-restore';

/** A file retention may delete, with the time in its name. */
export interface BackupFile {
  fileName: string;
  kind: BackupFileKind;
  createdAtMs: number;
}

/**
 * Kind and time of a file in the backup folder, or `undefined` for any other
 * file. Only these names are ever deleted by retention.
 */
export function parseBackupFolderName(fileName: string): BackupFile | undefined {
  const kinds: [BackupFileKind, RegExp][] = [
    ['backup', BACKUP_NAME],
    ['pre-migrate', PRE_MIGRATE_NAME],
    ['pre-restore', PRE_RESTORE_NAME],
  ];
  for (const [kind, pattern] of kinds) {
    const match = pattern.exec(fileName);
    if (!match) continue;
    const createdAtMs = stampToMs(match[1] ?? '', match[2] ?? '');
    return createdAtMs === undefined ? undefined : { fileName, kind, createdAtMs };
  }
  return undefined;
}

/**
 * Backups and the copies kept before migrations and restores in `dir`, in
 * any order. Folders and other files are left out. Empty if `dir` doesn't exist.
 */
export function listBackupFolderFiles(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const files: BackupFile[] = [];
  for (const name of names) {
    const file = parseBackupFolderName(name);
    if (!file) continue;
    try {
      if (statSync(join(dir, name)).isFile()) files.push(file);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return files;
}

function copyNumber(fileName: string): number {
  return Number(BACKUP_NAME.exec(fileName)?.[3] ?? 1);
}

const isCompressed = (fileName: string) => (fileName.endsWith('.gz') ? 1 : 0);

/**
 * Sort order for backups: newest first; in the same second, the higher copy
 * number first; with the same name apart from `.gz` (a backup unpacked in
 * place with `gunzip -k`), the compressed one first, so retention keeps the
 * backup the server wrote.
 */
export function newestFirst(
  a: Pick<BackupEntry, 'fileName' | 'createdAtMs'>,
  b: Pick<BackupEntry, 'fileName' | 'createdAtMs'>,
): number {
  return (
    b.createdAtMs - a.createdAtMs ||
    copyNumber(b.fileName) - copyNumber(a.fileName) ||
    isCompressed(b.fileName) - isCompressed(a.fileName)
  );
}

/** Backups in `dir`, newest first. An empty list if the folder doesn't exist. */
export function listBackups(dir: string): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const entries: BackupEntry[] = [];
  for (const fileName of names) {
    const createdAtMs = parseBackupFileName(fileName);
    if (createdAtMs === undefined) continue;
    try {
      const stats = statSync(join(dir, fileName));
      if (stats.isFile()) entries.push({ fileName, createdAtMs, sizeBytes: stats.size });
    } catch (error) {
      // Deleted by retention in another process meanwhile.
      if (!isNotFound(error)) throw error;
    }
  }
  return entries.sort(newestFirst);
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Flushes a file or folder to disk, so a rename survives a power loss. */
export function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A temp file older than this is left over from an interrupted backup. */
const STALE_TEMP_MS = 60 * 60_000;

/**
 * Removes temp files left by a backup that was interrupted (crash, power
 * loss, a full disk). Files younger than an hour are left alone: a
 * `pnpm cli backup` may be writing one right now. Returns the removed names.
 */
export function removeLeftoverTempFiles(dir: string, nowMs: number = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue;
    const path = join(dir, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile() || nowMs - stats.mtimeMs < STALE_TEMP_MS) continue;
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    rmSync(path, { force: true });
    removed.push(name);
  }
  return removed;
}
