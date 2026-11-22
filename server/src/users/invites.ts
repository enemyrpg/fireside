import { randomInt } from 'node:crypto';
import { hashToken, isWellFormedToken, newToken } from '../auth/tokens.js';
import type { Invite, InviteStatus, InviteType, UserRole } from '@fireside/shared';
import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Db, Queryable } from '../db/index.js';
import { invites, users, type InviteRow } from '../db/schema.js';
import { countUsers, isUniqueViolation } from './users.js';

// Invite links and password reset links. One table, two types. The link is
// `<origin>/invite#<token>` or `<origin>/reset-password#<token>`: the token is in the
// fragment, which browsers never send, so it never reaches a request line, an access
// log or a `Referer`. The page posts it in a JSON body. Only the token's SHA-256 is
// stored, so a link can't be shown again. Never log or audit the token or the link.

/** At most this many invites (type `invite`) may be active at once. */
export const MAX_ACTIVE_INVITES = 20;
/** A password reset link works this long and can't be extended. */
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Crockford base32: no I, L, O or U. */
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_LENGTH = 8;
/** New IDs tried when a random ID is already taken. */
const ID_ATTEMPTS = 5;

export const INVITE_PATHS: Record<InviteType, string> = {
  invite: '/invite',
  password_reset: '/reset-password',
};

/** A label longer than this is refused. */
export const MAX_LABEL_LENGTH = 100;

/** Thrown for a label that can't be used. The message is safe to show. */
export class InvalidLabelError extends Error {
  override name = 'InvalidLabelError';
}

/** Trims a label. Empty means none. Throws `InvalidLabelError`. */
export function normalizeLabel(label: string | undefined): string | null {
  const trimmed = (label ?? '').trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidLabelError(`Label must be at most ${String(MAX_LABEL_LENGTH)} characters`);
  }
  // Control, format (invisible) and line/paragraph separator characters.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) {
    throw new InvalidLabelError('Label must not contain control or invisible characters');
  }
  return trimmed;
}

/** A visible, non-secret ID. Random, so it says nothing about how many exist. */
export function generateInviteId(): string {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i += 1) id += ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length));
  return id;
}

export function hashInviteToken(token: string): string {
  return hashToken(token);
}

export function isWellFormedInviteToken(token: string): boolean {
  return isWellFormedToken(token);
}

/** The full link. `origin` has no trailing slash. */
export function inviteUrl(origin: string, type: InviteType, token: string): string {
  return `${origin}${INVITE_PATHS[type]}#${token}`;
}

/** Worked out from the row: revoked, then used, then expired, else active. */
export function inviteStatus(row: InviteRow, now: Date): InviteStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.usedAt !== null) return 'used';
  if (row.expiresAt <= now.toISOString()) return 'expired';
  return 'active';
}

/** Thrown when `MAX_ACTIVE_INVITES` invites are already active. */
export class TooManyInvitesError extends Error {
  override name = 'TooManyInvitesError';
  constructor() {
    super(
      `There are already ${String(MAX_ACTIVE_INVITES)} active invites. Revoke one or wait until one expires.`,
    );
  }
}

/** Thrown when `MAX_USERS` users exist. The message is safe to show. */
export class UserLimitError extends Error {
  override name = 'UserLimitError';
  constructor() {
    super('This server has no room for more users');
  }
}

/** Thrown when every ID tried was taken. Should never happen. */
export class InviteIdCollisionError extends Error {
  override name = 'InviteIdCollisionError';
}

export interface IdSource {
  /** Replaced in tests to force a collision. */
  generateId?: () => string;
}

/** Throws `UserLimitError` when `maxUsers` users already exist. */
export function assertRoomForUser(db: Queryable, maxUsers: number | null): void {
  if (maxUsers !== null && countUsers(db) >= maxUsers) throw new UserLimitError();
}

type NewInvite = Omit<typeof invites.$inferInsert, 'id' | 'tokenHash'>;

/**
 * Inserts a row with a new random ID and token. A taken ID (a collision of
 * 40 random bits) is retried with a new one instead of failing.
 */
function insertInvite(
  tx: Queryable,
  values: NewInvite,
  { generateId = generateInviteId }: IdSource,
): { row: InviteRow; token: string } {
  const token = newToken();
  const tokenHash = hashInviteToken(token);
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
    try {
      const row = tx
        .insert(invites)
        .values({ ...values, id: generateId(), tokenHash })
        .returning()
        .get();
      return { row, token };
    } catch (error) {
      if (!isUniqueViolation(error, 'invites.id')) throw error;
    }
  }
  throw new InviteIdCollisionError(`No free invite ID after ${String(ID_ATTEMPTS)} attempts`);
}

function activeInviteCount(db: Queryable, now: Date): number {
  return (
    db
      .select({ n: count() })
      .from(invites)
      .where(
        and(
          eq(invites.type, 'invite'),
          isNull(invites.usedAt),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, now.toISOString()),
        ),
      )
      .get()?.n ?? 0
  );
}

export interface CreateInviteOptions extends IdSource {
  createdBy: number;
  label: string | null;
  role: UserRole;
  canCreateApiKeys: boolean;
  days: number;
  maxUsers: number | null;
  now: Date;
}

/**
 * Creates an invite. Throws `TooManyInvitesError` or `UserLimitError`. The
 * token is returned once and never stored.
 */
export function createInvite(
  db: Db,
  { createdBy, label, role, canCreateApiKeys, days, maxUsers, now, ...ids }: CreateInviteOptions,
): { row: InviteRow; token: string } {
  return db.transaction(
    (tx) => {
      if (activeInviteCount(tx, now) >= MAX_ACTIVE_INVITES) throw new TooManyInvitesError();
      assertRoomForUser(tx, maxUsers);
      return insertInvite(
        tx,
        {
          type: 'invite',
          label,
          createdBy,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
          role,
          canCreateApiKeys,
        },
        ids,
      );
    },
    { behavior: 'immediate' },
  );
}

/** Revokes the user's active reset links. Returns the IDs revoked. */
export function revokeResetLinks(
  db: Queryable,
  targetUserId: number,
  revokedBy: number | null,
  now: Date,
): string[] {
  return db
    .update(invites)
    .set({ revokedAt: now.toISOString(), revokedBy })
    .where(
      and(
        eq(invites.type, 'password_reset'),
        eq(invites.targetUserId, targetUserId),
        isNull(invites.usedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, now.toISOString()),
      ),
    )
    .returning({ id: invites.id })
    .all()
    .map((row) => row.id);
}

/**
 * Creates a password reset link for `targetUserId`, valid for 24 hours. Any
 * earlier active link for that user is revoked in the same transaction.
 */
export function createPasswordReset(
  db: Db,
  {
    createdBy,
    targetUserId,
    now,
    ...ids
  }: IdSource & {
    createdBy: number;
    targetUserId: number;
    now: Date;
  },
): { row: InviteRow; token: string; revoked: string[] } {
  return db.transaction(
    (tx) => {
      const revoked = revokeResetLinks(tx, targetUserId, createdBy, now);
      const created = insertInvite(
        tx,
        {
          type: 'password_reset',
          createdBy,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + RESET_TTL_MS).toISOString(),
          targetUserId,
        },
        ids,
      );
      return { ...created, revoked };
    },
    { behavior: 'immediate' },
  );
}

export type RevokeResult =
  { status: 'not_found' } | { status: 'revoked' | 'unchanged'; row: InviteRow };

/**
 * Revokes an invite or reset link. Idempotent: a link that is already
 * revoked, used or expired is left as it is (`unchanged`). The row is kept.
 */
export function revokeInvite(
  db: Queryable,
  id: string,
  revokedBy: number,
  now: Date,
): RevokeResult {
  const row = db.select().from(invites).where(eq(invites.id, id)).get();
  if (!row) return { status: 'not_found' };
  if (inviteStatus(row, now) !== 'active') return { status: 'unchanged', row };
  // Empty when another process revoked or used it in the meantime.
  const [updated] = db
    .update(invites)
    .set({ revokedAt: now.toISOString(), revokedBy })
    .where(and(eq(invites.id, id), isNull(invites.revokedAt), isNull(invites.usedAt)))
    .returning()
    .all();
  return updated ? { status: 'revoked', row: updated } : { status: 'unchanged', row };
}

/**
 * The active link behind `token`, of `type`, or `undefined`. A reset link
 * for a disabled user doesn't count. Reads only.
 */
export function findActiveInvite(
  db: Queryable,
  token: string,
  type: InviteType | undefined,
  now: Date,
): InviteRow | undefined {
  if (!isWellFormedInviteToken(token)) return undefined;
  const row = db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashInviteToken(token)))
    .get();
  if (!row || (type !== undefined && row.type !== type)) return undefined;
  if (inviteStatus(row, now) !== 'active') return undefined;
  if (row.type === 'password_reset') {
    const target = db
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, row.targetUserId ?? 0))
      .get();
    if (target?.disabledAt !== null) return undefined;
  }
  return row;
}

/**
 * Marks the active link behind `token` used, in one conditional UPDATE, and
 * returns it; `undefined` when it isn't active (used, expired, revoked,
 * unknown or another type). Call inside the transaction that creates the
 * user or sets the password: two concurrent attempts can't both get a row.
 */
export function consumeInvite(
  tx: Queryable,
  token: string,
  type: InviteType,
  now: Date,
): InviteRow | undefined {
  if (!isWellFormedInviteToken(token)) return undefined;
  return tx
    .update(invites)
    .set({ usedAt: now.toISOString() })
    .where(
      and(
        eq(invites.tokenHash, hashInviteToken(token)),
        eq(invites.type, type),
        isNull(invites.usedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, now.toISOString()),
      ),
    )
    .returning()
    .get();
}

/** Every invite and reset link as listed, newest first. Never the token, hash or link. */
export function listInvites(db: Queryable, now: Date): Invite[] {
  const rows = db.select().from(invites).orderBy(desc(invites.createdAt), desc(invites.id)).all();
  const names = usernamesById(db);
  return rows.map((row) => toApiInvite(row, names, now));
}

/** One row for the API. `names` maps user IDs to usernames; a missing ID is a deleted user. */
export function toApiInvite(row: InviteRow, names: ReadonlyMap<number, string>, now: Date): Invite {
  const ref = (id: number | null) => {
    if (id === null) return null;
    const username = names.get(id);
    return username === undefined ? null : { id, username };
  };
  const common = {
    id: row.id,
    createdBy: ref(row.createdBy),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: inviteStatus(row, now),
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
  };
  if (row.type === 'password_reset') {
    const target = ref(row.targetUserId);
    // The target cascades with its user, so it is always there.
    if (target === null) throw new Error(`Reset link ${row.id} has no target user`);
    return { ...common, type: 'password_reset', targetUser: target };
  }
  return {
    ...common,
    type: 'invite',
    label: row.label,
    role: row.role ?? 'member',
    canCreateApiKeys: row.canCreateApiKeys ?? false,
    usedBy: ref(row.usedBy),
  };
}

/** Usernames by ID, for `toApiInvite`. */
export function usernamesById(db: Queryable): Map<number, string> {
  return new Map(
    db
      .select({ id: users.id, username: users.username })
      .from(users)
      .all()
      .map((user) => [user.id, user.username]),
  );
}
