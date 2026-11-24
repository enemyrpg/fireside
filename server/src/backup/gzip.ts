import { closeSync, createReadStream, createWriteStream, openSync, readSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { makePrivateFile } from '../fs-modes.js';
import { fsyncPath } from './files.js';

// Streamed gzip for backups: the file is never held in memory, and zlib works
// on libuv's thread pool, so the server keeps answering while a backup is
// compressed. `node:zlib` only, no extra dependency.

/** Level 6 (gzip's default): close to the best ratio for SQLite pages at a fraction of the time of 9. */
const GZIP_LEVEL = 6;

const GZIP_MAGIC = [0x1f, 0x8b] as const;

/**
 * Writes `source` through `transform` to `target`, a new file that is `0600`
 * from the start (`wx` fails if it exists), then flushes it to disk. The
 * caller removes `target` on failure.
 */
async function streamInto(
  source: string,
  target: string,
  transform: NodeJS.ReadWriteStream,
): Promise<void> {
  await pipeline(
    createReadStream(source),
    transform,
    createWriteStream(target, { flags: 'wx', mode: 0o600 }),
  );
  makePrivateFile(target);
  fsyncPath(target);
}

/** Compresses `source` into the new file `target`. */
export function gzipFile(source: string, target: string): Promise<void> {
  return streamInto(source, target, createGzip({ level: GZIP_LEVEL }));
}

/** Decompresses `source` into the new file `target`. A truncated or damaged file rejects. */
export function gunzipFile(source: string, target: string): Promise<void> {
  return streamInto(source, target, createGunzip());
}

/** Whether the file starts with the gzip magic bytes (whatever its name). */
export function isGzipFile(path: string): boolean {
  const buffer = Buffer.alloc(GZIP_MAGIC.length);
  const fd = openSync(path, 'r');
  try {
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return read === buffer.length && GZIP_MAGIC.every((byte, i) => buffer[i] === byte);
  } finally {
    closeSync(fd);
  }
}
