import { and, asc, count, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { trustedDevices, users, userSessions, type UserRow } from '../db/schema.js';

// Users. Without any password the server runs in local mode: no login,
// localhost only, and the dashboard acts as `localUserId`; in login mode it
// acts as the session's user. Invitations are in users/invites.ts, deletion in
// users/delete-user.ts.

/**
 * The admin the migration to users created. Everything from before there were
 * several users belongs to it.
 */
export const FIRST_USER_ID = 1;

export type UserRole = 'admin' | 'member';

/** Thrown when there is no user to act as. Only a broken database gets here. */
export class NoLocalUserError extends Error {
  override name = 'NoLocalUserError';
}

/**
 * The user that local mode acts as: the oldest active admin. On most
 * installs this is user 1; the last active admin can never be deleted or
 * disabled, so there always is one.
 */
export function localUserId(db: Queryable): number {
  const row = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
    .orderBy(asc(users.id))
    .limit(1)
    .get();
  if (!row) throw new NoLocalUserError('The database has no active admin user');
  return row.id;
}

/** Thrown when a username is already used. */
export class UsernameTakenError extends Error {
  override name = 'UsernameTakenError';
  constructor() {
    super('That username is taken');
  }
}

/**
 * better-sqlite3's unique violation, also when Drizzle wraps it (`cause`).
 * With `column` (`table.column`), only a violation on that column.
 */
export function isUniqueViolation(error: unknown, column?: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  // A primary key clash has its own code.
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return column === undefined || error.message.includes(column);
  }
  return error.cause !== undefined && isUniqueViolation(error.cause, column);
}

export interface CreateUserOptions {
  role?: UserRole;
  /** argon2id PHC string from `hashPassword`. Left out: no password. */
  passwordHash?: string | null;
  /** Default `true`. Invites set it. */
  canCreateApiKeys?: boolean;
  now?: Date;
}

/**
 * Adds a user. `username` must already be normalised (`normalizeUsername`).
 * Throws `UsernameTakenError`. The CLI only does this in login mode (see
 * `pnpm cli users create`); tests also make users without a password.
 */
export function createUser(
  db: Queryable,
  username: string,
  {
    role = 'member',
    passwordHash = null,
    canCreateApiKeys = true,
    now = new Date(),
  }: CreateUserOptions = {},
): number {
  try {
    return db
      .insert(users)
      .values({
        username,
        role,
        passwordHash,
        canCreateApiKeys,
        createdAt: now.toISOString(),
      })
      .returning({ id: users.id })
      .get().id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new UsernameTakenError();
    throw error;
  }
}

export function findUserById(db: Queryable, id: number): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** Looks up by the lower-cased, trimmed name. */
export function findUserByUsername(db: Queryable, username: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.username, username.trim().toLowerCase())).get();
}

/** All users, oldest first. */
export function listUsers(db: Queryable): UserRow[] {
  return db.select().from(users).orderBy(asc(users.id)).all();
}

/** Admins that are not disabled. The last one can't be deleted, disabled or demoted. */
export function countActiveAdmins(db: Queryable): number {
  return (
    db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
      .get()?.n ?? 0
  );
}

export function countUsers(db: Queryable): number {
  return db.select({ n: count() }).from(users).get()?.n ?? 0;
}

/** True if any user has a password: the server is in login mode. */
export function anyPasswordSet(db: Queryable): boolean {
  return (
    db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1).get() !==
    undefined
  );
}

/**
 * Sets or clears a password, ends every session of the user and forgets
 * their devices: a reset link, a password change and the CLI all come through
 * here.
 */
export function setPasswordHash(db: Queryable, userId: number, passwordHash: string | null): void {
  db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
  db.delete(userSessions).where(eq(userSessions.userId, userId)).run();
  db.delete(trustedDevices).where(eq(trustedDevices.userId, userId)).run();
}

/** `newName` must already be normalised. Throws `UsernameTakenError`. */
export function renameUser(db: Queryable, userId: number, newName: string): void {
  try {
    db.update(users).set({ username: newName }).where(eq(users.id, userId)).run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new UsernameTakenError();
    throw error;
  }
}

/** Thrown at startup when more than one user exists and none has a password. */
export class NoPasswordWithUsersError extends Error {
  override name = 'NoPasswordWithUsersError';
}

/**
 * Fail-closed backstop for the server: local mode is for one user. With several
 * users and no password, the server would act as user 1 for everyone with no
 * login, so it refuses to start instead. The CLI does not run this, so
 * `pnpm cli users set-password` can still fix it.
 */
export function assertLoginPossible(db: Queryable): void {
  const userCount = countUsers(db);
  if (userCount <= 1 || anyPasswordSet(db)) return;
  const owner = listUsers(db).find((user) => user.id === localUserId(db));
  throw new NoPasswordWithUsersError(
    `There are ${String(userCount)} users but none has a password, so login can't be required. ` +
      `Refusing to start. Set a password first: pnpm cli users set-password ${owner?.username ?? 'admin'}`,
  );
}
