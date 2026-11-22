import { and, asc, eq, gt, inArray, lte, ne } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { trustedDevices } from '../db/schema.js';
import { hashToken, isWellFormedToken, newToken } from './tokens.js';

// Device cookies. A browser that fully logged in (password, plus 2FA when on)
// gets a random token in `__Host-fireside_device`; only its SHA-256 is stored.
// A valid token for the user whose name was typed skips the per-username login
// limit (`login:user`), so someone guessing that user's password from many IPs
// never holds up the owner on a known browser. It never skips the per-IP limit
// or 2FA, and is never a login by itself.
//
// Deleted on a password change or reset (`setPasswordHash`), "log out
// everywhere", deactivation, an admin turning off 2FA, and with the user.
// A normal logout keeps it.

export const DEVICE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** Most devices per user; the least recently used goes first. */
export const MAX_DEVICES_PER_USER = 20;

export interface DeviceLookup {
  id: number;
  userId: number;
}

/** The device behind `token`, or `undefined` if malformed, unknown or expired. */
export function lookupDevice(
  db: Queryable,
  token: string | undefined,
  now: Date,
): DeviceLookup | undefined {
  if (!isWellFormedToken(token)) return undefined;
  return db
    .select({ id: trustedDevices.id, userId: trustedDevices.userId })
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.tokenHash, hashToken(token)),
        gt(trustedDevices.expiresAt, now.toISOString()),
      ),
    )
    .get();
}

/** True if `token` is a valid device cookie of `userId`. */
export function isKnownDevice(
  db: Queryable,
  token: string | undefined,
  userId: number | undefined,
  now: Date,
): boolean {
  if (userId === undefined) return false;
  return lookupDevice(db, token, now)?.userId === userId;
}

/**
 * After a full login of `userId`: touches the device behind `token` if it is
 * theirs, else makes a new one. Returns the token to set in the cookie (a new
 * expiry either way). Keeps at most `MAX_DEVICES_PER_USER`.
 */
export function rememberDevice(
  db: Queryable,
  userId: number,
  token: string | undefined,
  now: Date,
): string {
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + DEVICE_TTL_MS).toISOString();
  const known = lookupDevice(db, token, now);
  if (token !== undefined && known?.userId === userId) {
    db.update(trustedDevices)
      .set({ lastUsedAt: at, expiresAt })
      .where(eq(trustedDevices.id, known.id))
      .run();
    return token;
  }
  db.delete(trustedDevices).where(lte(trustedDevices.expiresAt, at)).run();
  const fresh = newToken();
  const id = db
    .insert(trustedDevices)
    .values({
      userId,
      tokenHash: hashToken(fresh),
      createdAt: at,
      lastUsedAt: at,
      expiresAt,
    })
    .returning({ id: trustedDevices.id })
    .get().id;
  const extra = db
    .select({ id: trustedDevices.id })
    .from(trustedDevices)
    .where(and(eq(trustedDevices.userId, userId), ne(trustedDevices.id, id)))
    .orderBy(asc(trustedDevices.lastUsedAt), asc(trustedDevices.id))
    .all()
    .map((row) => row.id);
  const over = extra.length + 1 - MAX_DEVICES_PER_USER;
  if (over > 0) {
    db.delete(trustedDevices)
      .where(inArray(trustedDevices.id, extra.slice(0, over)))
      .run();
  }
  return fresh;
}

/** Forgets every device of a user (they all hit the username limit again). */
export function deleteUserDevices(db: Queryable, userId: number): void {
  db.delete(trustedDevices).where(eq(trustedDevices.userId, userId)).run();
}
