import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { characterCount } from '../text.js';

// Passwords: argon2id from Node's own crypto (OpenSSL 3.2+, built into the
// official Node binaries on amd64 and arm64), so there is no native dependency
// to build. Stored as a PHC string, so the parameters can be raised later
// without breaking old hashes.

export const MIN_PASSWORD_LENGTH = 12;
/** Caps the work one request can ask for. Counted in characters (code points). */
export const MAX_PASSWORD_LENGTH = 256;

export interface Argon2Params {
  /** Memory in KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

/** OWASP's argon2id baseline: 19 MiB, 2 passes, 1 lane. About 20 ms on a desktop. */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1 };

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const ARGON2_VERSION = 19;

/** Thrown for a password that can't be used. The message is safe to show. */
export class InvalidPasswordError extends Error {
  override name = 'InvalidPasswordError';
}

/**
 * NFC-normalises a password, so the same password typed on different
 * systems gives the same bytes. Not trimmed: spaces are part of it.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

/** Checks a new password. Throws `InvalidPasswordError`. Returns it normalised. */
export function checkNewPassword(password: string): string {
  const normalized = normalizePassword(password);
  const length = characterCount(normalized);
  if (length < MIN_PASSWORD_LENGTH) {
    throw new InvalidPasswordError(
      `Use at least ${String(MIN_PASSWORD_LENGTH)} characters. A few words in a row is easy to remember.`,
    );
  }
  if (length > MAX_PASSWORD_LENGTH) {
    throw new InvalidPasswordError(
      `Password is too long (max ${String(MAX_PASSWORD_LENGTH)} characters)`,
    );
  }
  return normalized;
}

function runArgon2(password: string, salt: Buffer, params: Argon2Params, tagLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength,
        memory: params.memory,
        passes: params.passes,
      },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

/** `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>` (PHC string, unpadded base64). */
export async function hashPassword(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await runArgon2(normalizePassword(password), salt, params, TAG_BYTES);
  return `$argon2id$v=${String(ARGON2_VERSION)}$m=${String(params.memory)},t=${String(params.passes)},p=${String(params.parallelism)}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface ParsedHash {
  params: Argon2Params;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | undefined {
  const match = PHC.exec(stored);
  if (!match) return undefined;
  const [, m, t, p, salt, hash] = match;
  const params = { memory: Number(m), passes: Number(t), parallelism: Number(p) };
  const parsed = {
    params,
    salt: Buffer.from(salt ?? '', 'base64'),
    hash: Buffer.from(hash ?? '', 'base64'),
  };
  // Bounds keep a damaged row from asking for absurd work.
  if (
    params.memory < 8 * params.parallelism ||
    params.memory > 1_048_576 ||
    params.passes < 1 ||
    params.passes > 10 ||
    params.parallelism < 1 ||
    params.parallelism > 16 ||
    parsed.salt.length < 8 ||
    parsed.hash.length < 16
  ) {
    return undefined;
  }
  return parsed;
}

/** True if `password` matches `stored`. A malformed hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const derived = await runArgon2(
    normalizePassword(password),
    parsed.salt,
    parsed.params,
    parsed.hash.length,
  );
  return timingSafeEqual(derived, parsed.hash);
}

/** True if `stored` was made with weaker parameters than `params` (rehash on next login). */
export function needsRehash(stored: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return (
    parsed.params.memory < params.memory ||
    parsed.params.passes < params.passes ||
    parsed.params.parallelism !== params.parallelism
  );
}

/**
 * Thrown when too many password operations are already waiting. The request is
 * answered `503` with `Retry-After` (errors.ts); nothing was hashed or checked.
 */
export class HasherBusyError extends Error {
  override name = 'HasherBusyError';

  constructor() {
    super('Too many password operations are waiting');
  }
}

/**
 * Caps how many argon2 operations run at once (each takes `memory` KiB), so
 * a burst of logins can't exhaust memory or the thread pool. Extra callers
 * wait in line, at most `maxWaiting` of them: one more is turned away with
 * `HasherBusyError` at once, so the line (and the time a real login spends in
 * it) stays bounded however many requests arrive.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxWaiting = Infinity,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxWaiting) throw new HasherBusyError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // The slot passes straight to the next caller, so `active` stays the same.
      if (next) next();
      else this.active -= 1;
    }
  }

  /** For tests. */
  get running(): number {
    return this.active;
  }

  /** For tests. */
  get queued(): number {
    return this.waiting.length;
  }
}

/** Hashing for login and password changes. Tests replace it to count calls. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
}

export const MAX_CONCURRENT_HASHES = 4;

/**
 * Most password operations waiting for a slot; one more is refused
 * (`HasherBusyError`, `503`). 64 because the longest a real login then waits is
 * 64 / 4 operations: about 0.2 s at 13 ms each on a desktop, a few seconds on a
 * small ARM board at 100–200 ms each, well inside a browser's patience. And it
 * is far more than this kind of instance ever has waiting by itself (a handful
 * of users), so only a flood sees the `503`. The server makes one hasher and
 * shares it (routes/dashboard.ts), so this is the limit for login, invites,
 * reset links and password changes together.
 */
export const MAX_QUEUED_HASHES = 64;

/** `Retry-After` for a request refused because the queue was full. */
export const HASHER_BUSY_RETRY_AFTER_SECONDS = 2;

export interface PasswordHasherOptions {
  /** Most argon2 operations at once. */
  limit?: number;
  /** Most operations waiting for a slot. */
  maxQueue?: number;
  params?: Argon2Params;
}

/**
 * argon2id with at most `limit` operations at once and at most `maxQueue`
 * waiting; beyond that `hash` and `verify` reject with `HasherBusyError`.
 */
export function createPasswordHasher({
  limit = MAX_CONCURRENT_HASHES,
  maxQueue = MAX_QUEUED_HASHES,
  params = DEFAULT_ARGON2_PARAMS,
}: PasswordHasherOptions = {}): PasswordHasher {
  const semaphore = new Semaphore(limit, maxQueue);
  return {
    hash: (password) => semaphore.run(() => hashPassword(password, params)),
    verify: (password, stored) => semaphore.run(() => verifyPassword(password, stored)),
  };
}
