import { and, eq, lte, ne, or } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { users, userSessions, type UserRow } from '../db/schema.js';
import { hashToken, isWellFormedToken, newToken } from './tokens.js';

// Login sessions. The token lives only in the cookie; `user_sessions.id` is its
// SHA-256. API keys are never sessions: they live in another table, have
// another format, and this module never reads the Authorization header.

/** A session ends this long after it was last used (rolling). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A session never lasts longer than this from when it was made, however often
 * it is used: a stolen cookie that is kept in use ends too. A login or a
 * password change starts a new session.
 */
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** A session's expiry moves forward at most this often (one write per hour). */
export const SESSION_REFRESH_MS = 60 * 60 * 1000;

const MAX_USER_AGENT_LENGTH = 200;

export function hashSessionToken(token: string): string {
  return hashToken(token);
}

export interface NewSession {
  /** Goes in the cookie only. Never store or log it. */
  token: string;
  id: string;
  expiresAt: Date;
}

/** Starts a session for `userId`. Always a new token (no fixation). */
export function createSession(
  db: Queryable,
  userId: number,
  { now, userAgent }: { now: Date; userAgent?: string | undefined },
): NewSession {
  const token = newToken();
  const id = hashSessionToken(token);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(userSessions)
    .values({
      id,
      userId,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    })
    .run();
  return { token, id, expiresAt };
}

export type SessionLookup =
  | { status: 'none' }
  | {
      status: 'valid';
      id: string;
      user: UserRow;
      /** Set when the expiry moved forward: send the cookie again. */
      refreshedUntil: Date | undefined;
    };

/** When a session made at `createdAt` and used at `now` ends: rolling, within the absolute limit. */
function expiryOf(createdAt: Date, now: Date): Date {
  return new Date(
    Math.min(now.getTime() + SESSION_TTL_MS, createdAt.getTime() + SESSION_MAX_AGE_MS),
  );
}

/**
 * The session behind `token`, or `none` for a malformed, unknown or expired
 * token, or a user that is disabled. Expired rows are deleted. A session
 * not seen for an hour gets a new 30-day expiry (rolling), never later than
 * 90 days after it was made; at that age it ends, whatever `expires_at` says
 * (rows from before the limit existed).
 */
export function lookupSession(db: Queryable, token: string, now: Date): SessionLookup {
  if (!isWellFormedToken(token)) return { status: 'none' };
  const id = hashSessionToken(token);
  const row = db
    .select({ session: userSessions, user: users })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(eq(userSessions.id, id))
    .get();
  if (!row) return { status: 'none' };
  const createdAt = new Date(row.session.createdAt);
  if (
    new Date(row.session.expiresAt).getTime() <= now.getTime() ||
    createdAt.getTime() + SESSION_MAX_AGE_MS <= now.getTime()
  ) {
    db.delete(userSessions).where(eq(userSessions.id, id)).run();
    return { status: 'none' };
  }
  // Disabling also deletes the sessions; this keeps a disabled user out even if
  // a row is left over.
  if (row.user.disabledAt !== null || row.user.passwordHash === null) return { status: 'none' };

  let refreshedUntil: Date | undefined;
  const lastSeen = new Date(row.session.lastSeenAt).getTime();
  // A last_seen in the future (clock set back) also refreshes.
  if (now.getTime() - lastSeen >= SESSION_REFRESH_MS || lastSeen > now.getTime()) {
    refreshedUntil = expiryOf(createdAt, now);
    db.update(userSessions)
      .set({ lastSeenAt: now.toISOString(), expiresAt: refreshedUntil.toISOString() })
      .where(eq(userSessions.id, id))
      .run();
  }
  return { status: 'valid', id, user: row.user, refreshedUntil };
}

/** Logout: deletes the session behind `token`, if any. */
export function deleteSessionByToken(db: Queryable, token: string): void {
  if (!isWellFormedToken(token)) return;
  db.delete(userSessions)
    .where(eq(userSessions.id, hashSessionToken(token)))
    .run();
}

/** Ends every session of a user, except `keepId` if given. */
export function deleteUserSessions(db: Queryable, userId: number, keepId?: string): void {
  db.delete(userSessions)
    .where(
      and(
        eq(userSessions.userId, userId),
        keepId === undefined ? undefined : ne(userSessions.id, keepId),
      ),
    )
    .run();
}

/** Deletes sessions past their expiry or the absolute limit. */
export function deleteExpiredSessions(db: Queryable, now: Date): void {
  const oldest = new Date(now.getTime() - SESSION_MAX_AGE_MS).toISOString();
  db.delete(userSessions)
    .where(or(lte(userSessions.expiresAt, now.toISOString()), lte(userSessions.createdAt, oldest)))
    .run();
}
