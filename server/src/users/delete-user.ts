import { and, eq, gt, inArray, isNull, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { audit, keyTarget, userTarget } from '../audit/audit.js';
import type { Db, Queryable } from '../db/index.js';
import {
  accountClogSources,
  accountIds,
  accountNames,
  accountPets,
  accounts,
  apiKeys,
  auditLog,
  bankSnapshots,
  clogFeedTimes,
  clogReads,
  clogItems,
  clogObtained,
  clogSnapshots,
  diaryCompletions,
  diarySnapshots,
  diaryStates,
  events,
  externalSnapshots,
  invites,
  kcObservations,
  lootEvents,
  pbRecords,
  recoveryCodes,
  petDrops,
  potionStorageSnapshots,
  questCompletions,
  questSnapshots,
  questStates,
  raidDropChoices,
  raidManualDrops,
  raidSpecialLoot,
  raidSplitDefaults,
  sessions,
  trustedDevices,
  users,
  userSessions,
  weeklySummaries,
  xpSnapshots,
} from '../db/schema.js';
import { countActiveAdmins, findUserById } from './users.js';

// Deleting a user with all their data (see
// docs/architecture.md#deleting-a-user). The one agreed exception to "raw
// events are never changed": the user's `events` and `external_snapshots` are
// removed whole, never edited, so rebuilding from what is left gives every
// other user the same derived tables as before.
//
// Everything runs in one IMMEDIATE transaction with foreign keys on. Deletes
// are explicit, table by table, children before parents; cascades only reach
// child rows of tables listed here (e.g. `loot_items` under `loot_events`).
// server/src/users/delete-user.test.ts checks every table in the database,
// so a new table that holds user data fails that test until it is added here.

/** Thrown when the user is the last active admin. */
export class LastAdminError extends Error {
  override name = 'LastAdminError';
  constructor() {
    super('The last admin can’t be deleted, disabled or demoted');
  }
}

/** Thrown when the user doesn't exist. */
export class UserNotFoundError extends Error {
  override name = 'UserNotFoundError';
}

/**
 * Tables with an `account_id`, deleted for the user's accounts in this
 * order. Their own children cascade (sessions → heartbeats, AFK periods, AFK
 * estimates and summaries; xp/loot/bank/potion snapshots → their items). `clog_*` point at
 * `external_snapshots`, so they go first; everything that points at an event
 * goes before `events`.
 */
const ACCOUNT_TABLES: readonly { table: SQLiteTable; accountId: SQLiteColumn }[] = [
  // The user's own choices (not derived, never touched by rebuild).
  { table: raidManualDrops, accountId: raidManualDrops.accountId },
  { table: raidSplitDefaults, accountId: raidSplitDefaults.accountId },
  { table: accountClogSources, accountId: accountClogSources.accountId },
  // Derived from `external_snapshots` and `events`.
  { table: accountPets, accountId: accountPets.accountId },
  { table: clogFeedTimes, accountId: clogFeedTimes.accountId },
  { table: clogObtained, accountId: clogObtained.accountId },
  { table: clogItems, accountId: clogItems.accountId },
  { table: clogSnapshots, accountId: clogSnapshots.accountId },
  { table: petDrops, accountId: petDrops.accountId },
  { table: diaryCompletions, accountId: diaryCompletions.accountId },
  { table: diaryStates, accountId: diaryStates.accountId },
  { table: diarySnapshots, accountId: diarySnapshots.accountId },
  { table: questCompletions, accountId: questCompletions.accountId },
  { table: questStates, accountId: questStates.accountId },
  { table: questSnapshots, accountId: questSnapshots.accountId },
  { table: potionStorageSnapshots, accountId: potionStorageSnapshots.accountId },
  { table: bankSnapshots, accountId: bankSnapshots.accountId },
  { table: weeklySummaries, accountId: weeklySummaries.accountId },
  { table: sessions, accountId: sessions.accountId },
  { table: raidSpecialLoot, accountId: raidSpecialLoot.accountId },
  { table: pbRecords, accountId: pbRecords.accountId },
  { table: kcObservations, accountId: kcObservations.accountId },
  { table: lootEvents, accountId: lootEvents.accountId },
  { table: xpSnapshots, accountId: xpSnapshots.accountId },
  { table: accountNames, accountId: accountNames.accountId },
  { table: accounts, accountId: accounts.id },
  // Raw data from external sources, and when the source was read.
  { table: clogReads, accountId: clogReads.accountId },
  { table: externalSnapshots, accountId: externalSnapshots.accountId },
];

export interface DeleteUserOptions {
  /** Who deletes: an admin's ID, or the user themselves (self-delete). */
  actorUserId: number;
  now: Date;
}

export interface DeleteUserResult {
  username: string;
  accounts: number;
  events: number;
}

function runDelete(tx: Queryable, table: SQLiteTable, where: SQL | undefined): number {
  return tx.delete(table).where(where).run().changes;
}

/**
 * Deletes `userId` and every row that belongs to them. Throws
 * `UserNotFoundError`, or `LastAdminError` for the last active admin (checked
 * inside the transaction, so two admins can't delete each other at once).
 *
 * `audit_log`: rows where the user acted on themselves (logins, password
 * changes) are the user's own activity and are deleted. Other rows stay,
 * with the user's ID as actor set to `null` by the foreign key: admin
 * actions on the user, and the user's admin actions on others. They hold
 * only IDs, actions and times; user IDs are never reused, and usernames are
 * never stored there. Then one `user.delete` (or `user.delete_self`) row is
 * written.
 *
 * `invites`: the user's reset links are deleted. Invites the user made that
 * are still active are revoked; their rows stay with `created_by` set to
 * `null`. The invite the user came from stays, with `used_by` set to `null`
 * and its label (the admin's note on who it was for) cleared.
 */
export function deleteUser(
  db: Db,
  userId: number,
  { actorUserId, now }: DeleteUserOptions,
): DeleteUserResult {
  const self = actorUserId === userId;
  return db.transaction(
    (tx) => {
      const user = findUserById(tx, userId);
      if (!user) throw new UserNotFoundError(`No user with ID ${String(userId)}`);
      if (user.role === 'admin' && user.disabledAt === null && countActiveAdmins(tx) <= 1) {
        throw new LastAdminError();
      }

      const ids = tx
        .select({ id: accountIds.id })
        .from(accountIds)
        .where(eq(accountIds.userId, userId))
        .all()
        .map((row) => row.id);
      const userEvents = tx
        .select({ id: events.eventId })
        .from(events)
        .where(eq(events.userId, userId));

      // Choices keyed by a drop's event, not by account.
      runDelete(tx, raidDropChoices, inArray(raidDropChoices.eventId, userEvents));
      if (ids.length > 0) {
        for (const { table, accountId } of ACCOUNT_TABLES) {
          runDelete(tx, table, inArray(accountId, ids));
        }
      }
      const eventCount = runDelete(tx, events, eq(events.userId, userId));
      runDelete(tx, accountIds, eq(accountIds.userId, userId));
      const ownKeyTargets = tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.userId, userId))
        .all()
        .map((row) => keyTarget(row.id));
      runDelete(tx, apiKeys, eq(apiKeys.userId, userId));
      runDelete(tx, userSessions, eq(userSessions.userId, userId));
      runDelete(tx, trustedDevices, eq(trustedDevices.userId, userId));
      runDelete(tx, recoveryCodes, eq(recoveryCodes.userId, userId));
      runDelete(
        tx,
        invites,
        and(eq(invites.type, 'password_reset'), eq(invites.targetUserId, userId)),
      );
      // The admin's label may name the person.
      tx.update(invites).set({ label: null }).where(eq(invites.usedBy, userId)).run();
      // A link from a removed admin stops working.
      tx.update(invites)
        .set({ revokedAt: now.toISOString(), revokedBy: self ? null : actorUserId })
        .where(
          and(
            eq(invites.createdBy, userId),
            isNull(invites.usedAt),
            isNull(invites.revokedAt),
            gt(invites.expiresAt, now.toISOString()),
          ),
        )
        .run();
      runDelete(
        tx,
        auditLog,
        and(
          eq(auditLog.actorUserId, userId),
          // The user's own activity: on themselves, and on their own keys.
          inArray(auditLog.target, [userTarget(userId), ...ownKeyTargets]),
        ),
      );
      // The foreign keys set `created_by`, `used_by`, `revoked_by` and
      // `audit_log.actor_user_id` (and the key creator/revoker) to null.
      tx.delete(users).where(eq(users.id, userId)).run();

      audit(tx, {
        actorUserId: self ? null : actorUserId,
        action: self ? 'user.delete_self' : 'user.delete',
        target: userTarget(userId),
        now,
      });
      return { username: user.username, accounts: ids.length, events: eventCount };
    },
    { behavior: 'immediate' },
  );
}
