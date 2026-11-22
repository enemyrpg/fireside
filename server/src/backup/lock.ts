import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import BetterSqlite3 from 'better-sqlite3';
import { PRIVATE_DIR_MODE } from '../fs-modes.js';

// One server per DATA_DIR. The server holds an exclusive OS lock (fcntl) on
// `DATA_DIR/fireside.lock` while it runs, and `restore` takes the same lock.
//
// The lock file is a tiny SQLite database: in `locking_mode=EXCLUSIVE`, SQLite
// keeps its exclusive lock after the first write transaction until the
// connection closes. The OS drops the lock when the process ends, also after
// a crash or `kill -9`, so there is never a stale lock to clean up. It works
// across processes that don't share PIDs (a server in Docker and a CLI on the
// host see the same lock through the bind mount) and doesn't depend on the port.
//
// The database itself can't be used for this: with WAL, another connection
// can take an exclusive lock on it while the server has it open.

/**
 * Exit code of the server when another process holds the lock (EX_TEMPFAIL).
 * The systemd unit doesn't restart on it, so it never fights a Docker
 * container or a `pnpm dev` server over the database.
 */
export const EXIT_INSTANCE_LOCKED = 75;

/** Exit code of the server for an invalid `.env` (EX_CONFIG). Not restarted either. */
export const EXIT_CONFIG = 78;

/** Where another server on the same DATA_DIR may be running. */
export const OTHER_SERVER_HINT = `Is it running in Docker (docker compose ps), as a systemd service
(systemctl --user status ${BRANDING.shortName}) or in a terminal (pnpm dev / pnpm start)?`;

/** Path of the lock file in `dataDir`. */
export function lockPath(dataDir: string): string {
  return join(dataDir, `${BRANDING.shortName}.lock`);
}

/** Thrown when another process (a running server or a restore) holds the lock. */
export class InstanceLockedError extends Error {
  override name = 'InstanceLockedError';
}

export interface InstanceLock {
  /** Releases the lock. Safe to call more than once. */
  release(): void;
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
  );
}

/** Takes the lock for `dataDir` without waiting. Throws `InstanceLockedError` if it is held. */
export function acquireInstanceLock(dataDir: string): InstanceLock {
  // A new folder is for this user only. An existing one is made private, and
  // counted for the log, by tighten-data-dir.ts.
  mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const path = lockPath(dataDir);
  const sqlite = new BetterSqlite3(path, { timeout: 0 });
  try {
    sqlite.pragma('locking_mode = EXCLUSIVE');
    sqlite.exec('BEGIN EXCLUSIVE; COMMIT');
  } catch (error) {
    sqlite.close();
    if (isBusy(error)) {
      throw new InstanceLockedError(
        `${BRANDING.displayName} is already running on ${dataDir} ` +
          '(a server, or a restore in progress).',
      );
    }
    throw error;
  }
  return {
    release: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}
