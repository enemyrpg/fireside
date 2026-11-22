import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';

// File modes for DATA_DIR and BACKUP_DIR. The database, its `-wal`, the backups
// and the 2FA key hold every user's password hashes, session hashes and game
// data, so only the user the server runs as may read them: folders `0700`,
// files `0600`. The helpers here have no other imports, so the code that
// creates the files can use them; what is tightened at startup is in
// tighten-data-dir.ts.

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Windows has no such modes: nothing is changed or checked there. */
const HAS_MODES = process.platform !== 'win32';

/**
 * New files and folders of this process are for its user only. For the entry
 * points (the server and the CLI), first thing: it also covers the files
 * SQLite creates itself (`-wal`, `-shm`, the lock file, temp files). Never
 * call it from library code: the umask belongs to the whole process.
 */
export function usePrivateUmask(): void {
  if (HAS_MODES) process.umask(0o077);
}

/** What happened to one path. */
export type ModeResult =
  /** The mode was changed. */
  | { status: 'changed' }
  /** Already right, missing, or not ours to change (a link, not a regular file). */
  | { status: 'unchanged' }
  /** It should have been changed and could not be (not the owner, no modes on this file system). */
  | { status: 'failed'; reason: string };

function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ?? (error instanceof Error ? error.message : String(error));
}

/**
 * Creates `dir` (and missing parents) for this user only, and sets `0700` on
 * `dir` itself if it exists with another mode. Never touches the parents of
 * an existing folder. `dir` is a folder the operator configured, so a link
 * to it is followed. Throws only if the folder can't be created.
 */
export function ensurePrivateDir(dir: string): ModeResult {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  return makePrivateDir(dir);
}

/**
 * Sets `0700` on the folder `dir` if it exists with another mode. Creates
 * nothing and never throws. A link to the folder is followed (see
 * `ensurePrivateDir`).
 */
export function makePrivateDir(dir: string): ModeResult {
  if (!HAS_MODES) return { status: 'unchanged' };
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory() || (stat.mode & 0o777) === PRIVATE_DIR_MODE) {
      return { status: 'unchanged' };
    }
    chmodSync(dir, PRIVATE_DIR_MODE);
    return { status: 'changed' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unchanged' };
    return { status: 'failed', reason: reasonOf(error) };
  }
}

/**
 * Sets `0600` on `path` if it is a regular file with another mode. A missing
 * path and a symbolic link are left alone (`lstat`), so a link in the folder
 * never makes this change a file somewhere else. Never throws.
 *
 * The file is never opened. Closing any handle to a file drops every POSIX
 * lock the process holds on it, and these are files SQLite has open and
 * locked in this process: opening `fireside.lock` here would give up the
 * instance lock, and the database files likewise. So the mode is checked and
 * set by path. Between the two calls only someone who can already write to
 * the folder (its owner) could swap the file for a link.
 */
export function makePrivateFile(path: string): ModeResult {
  if (!HAS_MODES) return { status: 'unchanged' };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o777) === PRIVATE_FILE_MODE) {
      return { status: 'unchanged' };
    }
    chmodSync(path, PRIVATE_FILE_MODE);
    return { status: 'changed' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unchanged' };
    return { status: 'failed', reason: reasonOf(error) };
  }
}

/**
 * Creates `path` as an empty `0600` file if nothing is there, so a file that
 * SQLite then fills (`VACUUM INTO` accepts an empty file) is never readable
 * by others, whatever the umask. Best effort: an existing path is left alone.
 */
export function createPrivateFile(path: string): void {
  try {
    closeSync(openSync(path, 'wx', PRIVATE_FILE_MODE));
  } catch {
    // Exists, or can't be created: the caller's own write reports that.
  }
}
