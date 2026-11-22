import type { Event } from '@fireside/shared';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { accounts, events, sessions, sessionSummaries } from '../db/schema.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  ownedBy,
  SECOND_USER_ID,
  sessionIdOf,
  snapshotDerived,
  TEST_NOW,
  type TestRun,
} from '../projections/testing.js';
import { FIRST_USER_ID } from '../users/users.js';
import { SESSION_NOT_ALLOWED, storeEvents, type StoreResult } from './store.js';

// eventId and sessionId come from the plugin and are global across users.
// Ingest must never let one user's batch touch another user's rows.

/** Stores `batch` as `userId` would send it, with that user's key. */
function send(run: TestRun, userId: number, batch: readonly Event[]): StoreResult {
  const apiKeyId = run.apiKeyIds?.get(userId);
  if (apiKeyId === undefined) throw new Error('no key');
  return storeEvents(
    run.database.db,
    batch.map((event, index) => ({ index, event, raw: { ...event } })),
    { userId, apiKeyId, receivedAt: TEST_NOW.toISOString() },
  );
}

function storedRows(run: TestRun) {
  return run.database.db.select().from(events).orderBy(asc(events.eventId)).all();
}

describe('storeEvents across users', () => {
  it('stores each event as owned by the key’s user', () => {
    const run = emptyRun();
    const f = eventFactory();
    send(run, FIRST_USER_ID, [f.heartbeat('19:00')]);
    send(run, SECOND_USER_ID, [f.heartbeat('19:00', { sessionId: sessionIdOf(2) })]);
    expect(storedRows(run).map((row) => [row.userId, row.apiKeyId])).toEqual([
      [FIRST_USER_ID, run.apiKeyIds?.get(FIRST_USER_ID)],
      [SECOND_USER_ID, run.apiKeyIds?.get(SECOND_USER_ID)],
    ]);
  });

  describe('an eventId another user already stored', () => {
    it('is a duplicate, and the first user’s row is left exactly as it was', () => {
      const run = emptyRun();
      const f = eventFactory();
      const original = f.kc('19:00', { sessionId: sessionIdOf(1) });
      ingestBatch(run, [original]);
      const before = storedRows(run);
      const derivedBefore = snapshotDerived(run);

      // Same ID, another user, another account and session, other content.
      const replay: Event = {
        ...f.kc('20:00', { accountHash: '-42', sessionId: sessionIdOf(2) }),
        eventId: original.eventId.toUpperCase(),
      };
      const result = send(run, SECOND_USER_ID, [replay]);

      expect(result).toEqual({
        accepted: [],
        duplicates: [replay.eventId],
        foreignDuplicates: 1,
        rejected: [],
        storedIds: [],
      });
      expect(storedRows(run)).toEqual(before);
      expect(snapshotDerived(run)).toEqual(derivedBefore);
      // User 2 got no account from it.
      expect(
        run.database.db.select().from(accounts).where(eq(accounts.userId, SECOND_USER_ID)).all(),
      ).toEqual([]);
    });

    it('answers exactly like an own duplicate, so the sender learns nothing more', () => {
      const run = emptyRun();
      const f = eventFactory();
      const own = f.heartbeat('19:00', { sessionId: sessionIdOf(2) });
      const foreign = f.heartbeat('19:00');
      send(run, SECOND_USER_ID, [own]);
      send(run, FIRST_USER_ID, [foreign]);

      const ownAgain = send(run, SECOND_USER_ID, [own]);
      const foreignAgain = send(run, SECOND_USER_ID, [{ ...foreign, sessionId: sessionIdOf(2) }]);
      const response = (result: StoreResult) => ({
        accepted: result.accepted,
        duplicates: result.duplicates.length,
        rejected: result.rejected,
      });
      expect(response(foreignAgain)).toEqual(response(ownAgain));
      expect(ownAgain.foreignDuplicates).toBe(0);
      expect(foreignAgain.foreignDuplicates).toBe(1);
    });
  });

  it('treats the same eventId twice in one batch of one user as a normal duplicate', () => {
    const run = emptyRun();
    const f = eventFactory();
    const event = f.heartbeat('19:00');
    expect(send(run, FIRST_USER_ID, [event, event])).toMatchObject({
      accepted: [event.eventId],
      duplicates: [event.eventId],
      foreignDuplicates: 0,
      rejected: [],
    });
  });

  describe('a sessionId another user already has', () => {
    it('is rejected, the rest of the batch is stored, and the session is untouched', () => {
      const run = emptyRun();
      const f = eventFactory();
      ingestBatch(run, [
        f.sessionStart('19:00'),
        f.heartbeat('19:01'),
        f.sessionEnd('19:30', { reason: 'logout' }),
      ]);
      const sessionBefore = run.database.db.select().from(sessions).all();
      const summaryBefore = run.database.db.select().from(sessionSummaries).all();
      expect(sessionBefore).toHaveLength(1);
      expect(summaryBefore).toHaveLength(1);

      const intruding = f.heartbeat('19:10');
      const own = f.heartbeat('19:10', { sessionId: sessionIdOf(2) });
      const result = send(run, SECOND_USER_ID, [own, intruding]);

      expect(result.accepted).toEqual([own.eventId]);
      expect(result.rejected).toEqual([
        { index: 1, eventId: intruding.eventId, error: SESSION_NOT_ALLOWED },
      ]);
      expect(SESSION_NOT_ALLOWED).toBe('sessionId: not allowed');
      expect(result.storedIds).toEqual([own.eventId]);
      expect(
        run.database.db.select().from(events).where(eq(events.eventId, intruding.eventId)).all(),
      ).toEqual([]);
      expect(
        run.database.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionIdOf(1)))
          .all(),
      ).toEqual(sessionBefore);
      expect(run.database.db.select().from(sessionSummaries).all()).toEqual(summaryBefore);
    });

    it('is compared in lower case, like the stored ID', () => {
      const run = emptyRun();
      const f = eventFactory();
      send(run, FIRST_USER_ID, [f.heartbeat('19:00')]);
      const upper = f.heartbeat('19:01', { sessionId: sessionIdOf(1).toUpperCase() });
      expect(send(run, SECOND_USER_ID, [upper]).rejected).toHaveLength(1);
    });

    it('counts sessions opened earlier in the same batch', () => {
      const run = emptyRun();
      const f = eventFactory();
      const session = sessionIdOf(7);
      const [start, heartbeat] = [
        f.sessionStart('19:00', { sessionId: session }),
        f.heartbeat('19:01', { sessionId: session }),
      ];
      // User 2 opens a new session and keeps using it: both are its own.
      expect(send(run, SECOND_USER_ID, [start, heartbeat])).toMatchObject({
        accepted: [start.eventId, heartbeat.eventId],
        rejected: [],
      });
      // Now user 1 tries the same session.
      const intruding = f.heartbeat('19:02', { sessionId: session });
      expect(send(run, FIRST_USER_ID, [intruding]).rejected).toEqual([
        { index: 0, eventId: intruding.eventId, error: SESSION_NOT_ALLOWED },
      ]);
      // And in one batch: the first event claims the session for its user.
      const fresh = sessionIdOf(8);
      const first = f.heartbeat('19:03', { sessionId: fresh });
      expect(send(run, FIRST_USER_ID, [first]).accepted).toEqual([first.eventId]);
    });

    it('never rejects a resend of the user’s own event in the user’s own session', () => {
      const run = emptyRun();
      const f = eventFactory();
      const event = f.heartbeat('19:00', { sessionId: sessionIdOf(2) });
      send(run, SECOND_USER_ID, [event]);
      expect(send(run, SECOND_USER_ID, [event])).toMatchObject({
        accepted: [],
        duplicates: [event.eventId],
        rejected: [],
      });
    });

    it('lets a resend of another user’s event be a duplicate, not a rejection', () => {
      // The eventId check comes first: a resend of an event that is stored
      // (in a session of user 1) is a duplicate for anyone.
      const run = emptyRun();
      const f = eventFactory();
      const event = f.heartbeat('19:00');
      send(run, FIRST_USER_ID, [event]);
      expect(send(run, SECOND_USER_ID, ownedBy(SECOND_USER_ID, [event]))).toMatchObject({
        duplicates: [event.eventId],
        rejected: [],
      });
    });
  });
});
