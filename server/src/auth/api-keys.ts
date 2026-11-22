import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BRANDING } from '@fireside/shared';
import type { KeyRevokedBy } from '@fireside/shared';
import { and, asc, count, eq, getTableColumns, gt, isNull, lt, or } from 'drizzle-orm';
import { audit, keyTarget } from '../audit/audit.js';
import type { Db, Queryable } from '../db/index.js';
import { apiKeys, users, type ApiKeyRow } from '../db/schema.js';
import { characterCount, UNSAFE_TEXT_CHARS } from '../text.js';

// API keys for the plugin. A key is `<prefix><body>`: the body is 32 random
// bytes as base62, always 43 characters. Only the SHA-256 hash and a short
// display prefix are stored.

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_BYTES = 32;
/** Characters needed for 32 bytes in base62 (62^43 > 2^256). */
export const KEY_BODY_LENGTH = 43;
/** Body characters kept in the display prefix, e.g. `fs_a1b2`. */
const DISPLAY_BODY_CHARS = 4;
/** `last_used_at` is written at most this often per key. */
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Big-endian base62, left-padded with `0` to `length`. */
export function encodeBase62(bytes: Uint8Array, length = KEY_BODY_LENGTH): string {
  let value = bytes.length === 0 ? 0n : BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (value > 0n) {
    out = BASE62.charAt(Number(value % 62n)) + out;
    value /= 62n;
  }
  if (out.length > length) throw new RangeError(`Value needs more than ${String(length)} digits`);
  return out.padStart(length, '0');
}

/** Prefixes a key may start with: only the current one. */
export function acceptedKeyPrefixes(): readonly string[] {
  return [BRANDING.apiKeyPrefix];
}

/** SHA-256 (hex) of the full key, prefix included. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function displayPrefix(key: string, prefixes = acceptedKeyPrefixes()): string {
  const prefix = prefixes.find((candidate) => key.startsWith(candidate)) ?? '';
  return key.slice(0, prefix.length + DISPLAY_BODY_CHARS);
}

const BODY_PATTERN = new RegExp(`^[0-9A-Za-z]{${String(KEY_BODY_LENGTH)}}$`);

/** True if `key` has an accepted prefix and a well-formed body. Says nothing about whether it exists. */
export function isWellFormedApiKey(key: string, prefixes = acceptedKeyPrefixes()): boolean {
  return prefixes.some(
    (prefix) => key.startsWith(prefix) && BODY_PATTERN.test(key.slice(prefix.length)),
  );
}

export interface GeneratedApiKey {
  /** The full key. Show it once, never store it. */
  key: string;
  hash: string;
  displayPrefix: string;
}

/** A new key with the current branding prefix. */
export function generateApiKey(): GeneratedApiKey {
  const key = BRANDING.apiKeyPrefix + encodeBase62(randomBytes(KEY_BYTES));
  return { key, hash: hashApiKey(key), displayPrefix: displayPrefix(key) };
}

export const MAX_KEY_NAME_LENGTH = 100;

/** Thrown by `createApiKey` for a name that can't be stored. The message is safe to show. */
export class InvalidKeyNameError extends Error {
  override name = 'InvalidKeyNameError';
}

/** Trims and checks a key name. Throws `InvalidKeyNameError`. */
export function normalizeKeyName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new InvalidKeyNameError('Give the key a name, e.g. the PC it is for');
  if (characterCount(trimmed) > MAX_KEY_NAME_LENGTH) {
    throw new InvalidKeyNameError(
      `Name is too long (max ${String(MAX_KEY_NAME_LENGTH)} characters)`,
    );
  }
  if (UNSAFE_TEXT_CHARS.test(trimmed)) {
    throw new InvalidKeyNameError('Name must not contain control characters or line breaks');
  }
  return trimmed;
}

export interface CreatedApiKey {
  id: number;
  name: string;
  /** The full key. This is the only time it is available. */
  key: string;
  prefix: string;
  createdAt: string;
}

/** Who a key belongs to, and who made it (an admin can make one for a user). */
export interface KeyOwner {
  userId: number;
  /** `null` for the CLI on the server itself. Also the actor in `audit_log`. */
  createdByUserId: number | null;
}

/** Active (not revoked) keys a user may have at once, also counting keys an admin made. */
export const MAX_ACTIVE_KEYS_PER_USER = 10;

/** Thrown by `createApiKey` when the owner already has the maximum. The message is safe to show. */
export class KeyLimitError extends Error {
  override name = 'KeyLimitError';
  constructor(readonly self: boolean) {
    super(
      self
        ? `You already have ${String(MAX_ACTIVE_KEYS_PER_USER)} active API keys. Revoke one you no longer use first.`
        : `This user already has ${String(MAX_ACTIVE_KEYS_PER_USER)} active API keys. Revoke one first.`,
    );
  }
}

/** Number of the user's keys that aren't revoked. */
export function countActiveKeys(db: Queryable, userId: number): number {
  return (
    db
      .select({ n: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .get()?.n ?? 0
  );
}

/** Active key count per user ID (users without one are missing). */
export function activeKeyCounts(db: Queryable): Map<number, number> {
  return new Map(
    db
      .select({ userId: apiKeys.userId, n: count() })
      .from(apiKeys)
      .where(isNull(apiKeys.revokedAt))
      .groupBy(apiKeys.userId)
      .all()
      .map((row) => [row.userId, row.n]),
  );
}

/** A key owned and made by the same user. */
export function ownKey(userId: number): KeyOwner {
  return { userId, createdByUserId: userId };
}

/**
 * Creates a key for `owner.userId`: events sent with it belong to that user.
 * The name is normalized with `normalizeKeyName` (which may throw). At most
 * `MAX_ACTIVE_KEYS_PER_USER` active keys per owner (`KeyLimitError`), checked
 * and inserted in one transaction. Writes `key.create` to `audit_log` with
 * the creator as actor; never the key, its hash or its name.
 */
export function createApiKey(
  db: Db,
  owner: KeyOwner,
  rawName: string,
  now: Date = new Date(),
): CreatedApiKey {
  const name = normalizeKeyName(rawName);
  const generated = generateApiKey();
  const createdAt = now.toISOString();
  const row = db.transaction(
    (tx) => {
      if (countActiveKeys(tx, owner.userId) >= MAX_ACTIVE_KEYS_PER_USER) {
        throw new KeyLimitError(owner.createdByUserId === owner.userId);
      }
      const inserted = tx
        .insert(apiKeys)
        .values({
          userId: owner.userId,
          createdByUserId: owner.createdByUserId,
          name,
          keyHash: generated.hash,
          prefix: generated.displayPrefix,
          createdAt,
        })
        .returning({ id: apiKeys.id })
        .get();
      audit(tx, {
        actorUserId: owner.createdByUserId,
        action: 'key.create',
        target: keyTarget(inserted.id),
        now,
      });
      return inserted;
    },
    { behavior: 'immediate' },
  );
  return { id: row.id, name, key: generated.key, prefix: generated.displayPrefix, createdAt };
}

/** Who revoked a key, as the owner sees it: themselves, or anyone else (`admin`). */
export function keyRevokedBy(
  row: Pick<ApiKeyRow, 'userId' | 'revokedAt' | 'revokedByUserId'>,
): KeyRevokedBy | null {
  if (row.revokedAt === null) return null;
  return row.revokedByUserId === row.userId ? 'owner' : 'admin';
}

/** `true` when someone other than the owner made the key (an admin, or the CLI). */
export function keyCreatedByAdmin(row: Pick<ApiKeyRow, 'userId' | 'createdByUserId'>): boolean {
  return row.createdByUserId !== row.userId;
}

/** Key metadata without the hash. */
export type ApiKeyInfo = Omit<ApiKeyRow, 'keyHash'>;

// Every column except the hash, so new columns are listed automatically.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- keyHash is only split off to leave it out
const { keyHash, ...infoColumns } = getTableColumns(apiKeys);

/** Keys of one user, or of every user without `userId` (the CLI). Oldest first. */
export function listApiKeys(db: Queryable, userId?: number): ApiKeyInfo[] {
  return db
    .select(infoColumns)
    .from(apiKeys)
    .where(userId === undefined ? undefined : eq(apiKeys.userId, userId))
    .orderBy(asc(apiKeys.id))
    .all();
}

export type RevokeResult = 'revoked' | 'already-revoked' | 'not-found';

export interface RevokeOptions {
  /** Who revokes it. Stored in `revoked_by_user_id`, and the actor in `audit_log`. `null`: the CLI. */
  byUserId: number | null;
  /** Only a key of this user counts; any other is `not-found`. Leave out for any key (the CLI). */
  ownerId?: number | undefined;
  now?: Date;
}

/**
 * Marks a key as revoked. Keys are never deleted: events point at them. The
 * one path for every revocation (owner, admin, blocking a user, CLI): writes
 * `key.revoke` to `audit_log` when it revoked something. The next ingest
 * request with the key gets `401` (`findApiKey` reads the row every time).
 */
export function revokeApiKey(
  db: Queryable,
  id: number,
  { byUserId, ownerId, now = new Date() }: RevokeOptions,
): RevokeResult {
  const ofKey = and(
    eq(apiKeys.id, id),
    ownerId === undefined ? undefined : eq(apiKeys.userId, ownerId),
  );
  const updated = db
    .update(apiKeys)
    .set({ revokedAt: now.toISOString(), revokedByUserId: byUserId })
    .where(and(ofKey, isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id })
    .all();
  if (updated.length > 0) {
    audit(db, { actorUserId: byUserId, action: 'key.revoke', target: keyTarget(id), now });
    return 'revoked';
  }
  const exists = db.select({ id: apiKeys.id }).from(apiKeys).where(ofKey).get();
  return exists ? 'already-revoked' : 'not-found';
}

/** Revokes every active key of `userId` through `revokeApiKey`. Returns how many. */
export function revokeActiveKeys(
  db: Queryable,
  userId: number,
  options: { byUserId: number | null; now: Date },
): number {
  const active = db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(asc(apiKeys.id))
    .all();
  let revoked = 0;
  for (const { id } of active) {
    if (revokeApiKey(db, id, { ...options, ownerId: userId }) === 'revoked') revoked += 1;
  }
  return revoked;
}

export type ApiKeyLookup =
  | { status: 'malformed' }
  | { status: 'unknown' }
  | { status: 'revoked'; row: ApiKeyRow }
  /** The key is active, but its owner is disabled: refused like a revoked key. */
  | { status: 'user_disabled'; row: ApiKeyRow }
  | { status: 'active'; row: ApiKeyRow };

/** Finds the key by its hash. Malformed keys are rejected without a query. */
export function findApiKey(db: Db, key: string, prefixes = acceptedKeyPrefixes()): ApiKeyLookup {
  if (!isWellFormedApiKey(key, prefixes)) return { status: 'malformed' };

  const hash = hashApiKey(key);
  const found = db
    .select({ key: apiKeys, disabledAt: users.disabledAt })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, hash))
    .get();
  const row = found?.key;
  // The query matched on the hash already; compare again in constant time so
  // the decision never rests on a short-circuiting string comparison.
  if (!row || !sameHash(row.keyHash, hash)) return { status: 'unknown' };
  if (row.revokedAt !== null) return { status: 'revoked', row };
  return found.disabledAt === null ? { status: 'active', row } : { status: 'user_disabled', row };
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Sets `last_used_at` to `now` unless it was set less than the throttle window
 * ago. A value in the future (the clock moved back) is always replaced, so it
 * can't freeze until real time catches up.
 */
export function touchLastUsed(db: Db, row: ApiKeyRow, now: Date): void {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - LAST_USED_THROTTLE_MS).toISOString();
  const last = row.lastUsedAt;
  if (last !== null && last >= staleBefore && last <= nowIso) return;
  // Repeat the check in SQL, in case another request updated it meanwhile.
  db.update(apiKeys)
    .set({ lastUsedAt: nowIso })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(
          isNull(apiKeys.lastUsedAt),
          lt(apiKeys.lastUsedAt, staleBefore),
          gt(apiKeys.lastUsedAt, nowIso),
        ),
      ),
    )
    .run();
}
