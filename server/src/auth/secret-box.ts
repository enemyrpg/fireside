import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRANDING } from '@fireside/shared';

// Encryption of TOTP secrets at rest. AES-256-GCM with a 32-byte key in `DATA_DIR/fireside.key`,
// never in the database, so a copy of the database or a backup alone can't make 2FA codes. The
// user's ID is the additional data, so a secret copied into another user's row doesn't decrypt.
// Stored as `v1:<iv>:<tag>:<ciphertext>` (base64url).
//
// The key file is made the first time someone sets up 2FA, mode 0600: the
// key is written to a temporary file and synced to disk, then linked into
// place, which fails if the file exists. A crash part way never leaves a
// short or empty `fireside.key`, and an existing key is never replaced. The
// key is read once and kept in memory.
//
// Recovery codes are hashed with HMAC-SHA-256 under a key derived from this
// one (HKDF, never the key itself), so a copy of the database can't be
// brute-forced for them either. Losing the key file also invalidates them;
// `pnpm cli users reset-2fa` covers that as for the secrets. `pnpm cli backup` copies only the database; the file is copied
// once, separately (README, "Backups"). Without it, users with 2FA can't log
// in until the operator runs `pnpm cli users reset-2fa <name>`.

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

export function keyFilePath(dataDir: string): string {
  return join(dataDir, `${BRANDING.shortName}.key`);
}

/** Thrown when the key is missing or can't open a value. Never holds the secret. */
export class SecretBoxError extends Error {
  override name = 'SecretBoxError';
}

/** Where the key lives. Tests use `memoryKeyStore`, the server the key file. */
export interface KeyStore {
  /** The key, or `undefined` if there is none yet. Throws `SecretBoxError` if unusable. */
  load(): Buffer | undefined;
  /** The key, made now if there is none. */
  loadOrCreate(): Buffer;
  /** Shown in logs and errors. */
  readonly description: string;
}

function checkKey(bytes: Buffer, where: string): Buffer {
  if (bytes.length !== KEY_BYTES) {
    throw new SecretBoxError(`${where} is not a valid key (expected ${String(KEY_BYTES)} bytes)`);
  }
  return bytes;
}

/** Syncs a folder, so a new name in it survives a crash. Best effort. */
function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Not supported everywhere (e.g. some network file systems).
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The key file in `dataDir`. The key is read once and then kept in memory. */
export function fileKeyStore(dataDir: string): KeyStore {
  const path = keyFilePath(dataDir);
  let cached: Buffer | undefined;
  const read = (): Buffer | undefined => {
    if (cached) return cached;
    try {
      cached = checkKey(readFileSync(path), path);
      return cached;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SecretBoxError) throw error;
      throw new SecretBoxError(`Could not read ${path}: ${(error as Error).message}`);
    }
  };
  const create = (): Buffer => {
    const key = randomBytes(KEY_BYTES);
    const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeSync(fd, key);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Fails with EEXIST if a concurrent setup got there first.
      linkSync(temp, path);
      syncDir(dirname(path));
      cached = key;
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const made = read();
        if (made) return made;
      }
      if (error instanceof SecretBoxError) throw error;
      throw new SecretBoxError(`Could not create ${path}: ${(error as Error).message}`);
    } finally {
      rmSync(temp, { force: true });
    }
  };
  return {
    description: path,
    load: read,
    loadOrCreate: () => read() ?? create(),
  };
}

/** A key kept in memory. For tests. */
export function memoryKeyStore(initial?: Buffer): KeyStore & { key: Buffer | undefined } {
  const store = {
    key: initial,
    description: 'memory',
    load: () => store.key,
    loadOrCreate: () => (store.key ??= randomBytes(KEY_BYTES)),
  };
  return store;
}

const b64 = (bytes: Buffer) => bytes.toString('base64url');

function aad(userId: number): Buffer {
  return Buffer.from(`user:${String(userId)}`, 'utf8');
}

const RECOVERY_INFO = Buffer.from(`${BRANDING.shortName} recovery codes v1`, 'utf8');

export interface SecretBox {
  /**
   * The HMAC key for recovery codes: derived from the key (HKDF-SHA-256),
   * never the key itself. With `create`, the key file is made if needed.
   * Throws `SecretBoxError` when the key is missing (verifying).
   */
  recoveryCodeKey(create: boolean): Buffer;
  /** Encrypts `plain` for `userId`, making the key if needed. */
  seal(userId: number, plain: string): string;
  /** Decrypts a value from `seal`. Throws `SecretBoxError`. */
  open(userId: number, sealed: string): string;
  readonly keyStore: KeyStore;
}

export function createSecretBox(keyStore: KeyStore): SecretBox {
  const loadKey = (): Buffer => {
    const key = keyStore.load();
    if (!key) throw new SecretBoxError(`The key file is missing (${keyStore.description})`);
    return key;
  };
  return {
    keyStore,
    recoveryCodeKey(create) {
      const key = create ? keyStore.loadOrCreate() : loadKey();
      return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), RECOVERY_INFO, 32));
    },
    seal(userId, plain) {
      const key = keyStore.loadOrCreate();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad(userId));
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(body)].join(':');
    },
    open(userId, sealed) {
      const key = loadKey();
      const [version, iv, tag, body, ...rest] = sealed.split(':');
      if (
        version !== VERSION ||
        iv === undefined ||
        tag === undefined ||
        body === undefined ||
        rest.length > 0
      ) {
        throw new SecretBoxError('Unknown format of a stored secret');
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(aad(userId));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(body, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new SecretBoxError(
          `A stored secret could not be decrypted with the key (${keyStore.description})`,
        );
      }
    },
  };
}
