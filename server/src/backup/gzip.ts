import { closeSync, createReadStream, createWriteStream, openSync, readSync } from 'node:fs';
import { Writable } from 'node:stream';
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
  signal?: AbortSignal,
): Promise<void> {
  await pipeline(
    createReadStream(source),
    transform,
    createWriteStream(target, { flags: 'wx', mode: 0o600 }),
    ...(signal ? [{ signal }] : []),
  );
  makePrivateFile(target);
  fsyncPath(target);
}

/** Compresses `source` into the new file `target`. `signal` stops it (the caller removes `target`). */
export function gzipFile(source: string, target: string, signal?: AbortSignal): Promise<void> {
  return streamInto(source, target, createGzip({ level: GZIP_LEVEL }), signal);
}

/** Decompresses `source` into the new file `target`. A truncated or damaged file rejects. */
export function gunzipFile(source: string, target: string): Promise<void> {
  return streamInto(source, target, createGunzip());
}

/**
 * Reads a gzip file back and throws unless it decompresses completely to
 * `expectedBytes` bytes. Gunzip checks the CRC-32 and the length in the gzip
 * trailer itself; the byte count also catches a file that holds less than it
 * should. Nothing is written: the data goes to a sink that drops it.
 */
export async function verifyGzipFile(
  path: string,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  let bytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done();
    },
  });
  try {
    await pipeline(createReadStream(path), createGunzip(), sink, ...(signal ? [{ signal }] : []));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      `The compressed backup failed its check: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (bytes !== expectedBytes) {
    throw new Error(
      `The compressed backup failed its check: it holds ${String(bytes)} bytes, not ${String(expectedBytes)}`,
    );
  }
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
