import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { keyFilePath } from './auth/secret-box.js';
import { parseBackupFolderName, TEMP_PREFIX, TEMP_SUFFIX } from './backup/files.js';
import { lockPath } from './backup/lock.js';
import { databasePath } from './db/index.js';
import { makePrivateDir, makePrivateFile, type ModeResult } from './fs-modes.js';

// Makes what is already in DATA_DIR and BACKUP_DIR private: the two folders
// `0700`, our own files in them `0600`. Run at startup, so an install from
// before this gets the right modes without the operator doing anything. New
// files get them where they are made (fs-modes.ts, and the umask set by the
// entry points).
//
// What it never does:
// - touch anything outside the two folders: not their parents, and not the
//   target of a symbolic link inside them (links are skipped). The two
//   folders themselves are the operator's choice, so a link to one of them
//   is followed;
// - open a file: that would drop SQLite's locks on it (see `makePrivateFile`);
// - touch a file in them that isn't ours (only the names below);
// - go into subfolders, or create anything;
// - fail: what can't be changed is reported, and the server starts anyway.

/** SQLite's files next to a database. */
const SIDE_SUFFIXES = ['', '-wal', '-shm', '-journal'];

export interface TightenOptions {
  dataDir: string;
  /** `BACKUP_DIR`. May be inside `dataDir` or anywhere else. */
  backupDir: string;
}

export interface TightenResult {
  /** How many folders and files got a stricter mode. */
  tightened: number;
  /** Paths that should have been changed and could not be, with why. */
  failed: { path: string; reason: string }[];
}

/** The files in `dataDir` that are ours: the database, lock and key, with SQLite's side files. */
function dataDirFiles(dataDir: string): string[] {
  const databases = [databasePath(dataDir), lockPath(dataDir)];
  return [
    ...databases.flatMap((file) => SIDE_SUFFIXES.map((suffix) => file + suffix)),
    keyFilePath(dataDir),
  ];
}

/** The files in `backupDir` that are ours: backups, copies before a migration or restore, temp files. */
function backupDirFiles(backupDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  return names
    .filter(
      (name) =>
        parseBackupFolderName(name) !== undefined ||
        (name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX)),
    )
    .map((name) => join(backupDir, name));
}

/** Sets `0700` on the two folders and `0600` on our files in them. Never throws. */
export function tightenDataDir({ dataDir, backupDir }: TightenOptions): TightenResult {
  const result: TightenResult = { tightened: 0, failed: [] };
  const record = (path: string, outcome: ModeResult) => {
    if (outcome.status === 'changed') result.tightened++;
    if (outcome.status === 'failed') result.failed.push({ path, reason: outcome.reason });
  };
  // Only folders that exist: a missing one is created private by whoever
  // first writes to it (`ensurePrivateDir`).
  for (const dir of new Set([dataDir, backupDir])) record(dir, makePrivateDir(dir));
  for (const file of [...dataDirFiles(dataDir), ...backupDirFiles(backupDir)]) {
    record(file, makePrivateFile(file));
  }
  return result;
}

/** Adds up the results of several runs. */
export function mergeTightenResults(...results: TightenResult[]): TightenResult {
  return {
    tightened: results.reduce((sum, result) => sum + result.tightened, 0),
    // The same path can fail in each run: once is enough.
    failed: [...new Map(results.flatMap((r) => r.failed).map((f) => [f.path, f])).values()],
  };
}

/** The log line for a result: always one line, with counts only. */
export function describeTightenResult(result: TightenResult): string {
  const n = result.tightened;
  return n === 0
    ? 'File permissions: the data and backup folders were already private'
    : `File permissions: made ${String(n)} ${n === 1 ? 'path' : 'paths'} in the data and backup folders private (folders 0700, files 0600)`;
}

/** One warning per path that could not be changed. */
export function tightenWarnings(result: TightenResult): string[] {
  return result.failed.map(
    ({ path, reason }) =>
      `Could not make ${path} private (${reason}). Other users on this machine may be able to read it: ` +
      'check its owner and mode.',
  );
}
