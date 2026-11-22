import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import { userSessions } from '../db/schema.js';
import { testDatabase } from '../test-utils.js';
import { FIRST_USER_ID, setPasswordHash } from '../users/users.js';
import {
  createSession,
  deleteExpiredSessions,
  lookupSession,
  SESSION_MAX_AGE_MS,
  SESSION_REFRESH_MS,
  SESSION_TTL_MS,
} from './sessions.js';

// Session lifetime: rolling 30 days, and at most 90 days in all. The routes are
// tested in routes/auth.test.ts.

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-11-19T12:00:00.000Z');

describe('session lifetime', () => {
  let database: Database;
  beforeEach(() => {
    database = testDatabase();
    // A user without a password has no valid session.
    setPasswordHash(database.db, FIRST_USER_ID, 'not a real hash');
  });
  afterEach(() => {
    database.close();
  });

  const at = (ms: number) => new Date(START + ms);
  const rows = () => database.db.select().from(userSessions).all();
  const start = () => createSession(database.db, FIRST_USER_ID, { now: at(0) });
  const lookup = (token: string, ms: number) => lookupSession(database.db, token, at(ms));

  it('is 30 days rolling and 90 days in all', () => {
    expect(SESSION_TTL_MS).toBe(30 * DAY_MS);
    expect(SESSION_MAX_AGE_MS).toBe(90 * DAY_MS);
  });

  it('ends 30 days after it was last used, as before', () => {
    const { token } = start();
    expect(lookup(token, 10 * DAY_MS).status).toBe('valid');
    expect(lookup(token, 40 * DAY_MS - 1).status).toBe('valid');
    expect(lookup(token, 70 * DAY_MS).status).toBe('none');
    expect(rows()).toEqual([]);
  });

  it('ends 90 days after it was made, however often it is used', () => {
    const { token, id } = start();
    // Used every day: the expiry rolls, but never past day 90.
    for (let day = 1; day < 90; day++) {
      const found = lookup(token, day * DAY_MS);
      expect(found.status, `day ${String(day)}`).toBe('valid');
      const expiresAt = Date.parse(rows()[0]?.expiresAt ?? '');
      expect(expiresAt).toBe(START + Math.min((day + 30) * DAY_MS, SESSION_MAX_AGE_MS));
      if (found.status === 'valid') {
        expect(found.refreshedUntil?.getTime()).toBe(expiresAt);
      }
    }
    expect(lookup(token, SESSION_MAX_AGE_MS - 1).status).toBe('valid');
    expect(lookup(token, SESSION_MAX_AGE_MS).status).toBe('none');
    expect(database.db.select().from(userSessions).where(eq(userSessions.id, id)).all()).toEqual(
      [],
    );
  });

  it('ends a row from before the limit, whose expiry is later than day 90', () => {
    const { token, id } = start();
    database.db
      .update(userSessions)
      .set({
        lastSeenAt: at(89 * DAY_MS).toISOString(),
        expiresAt: at(119 * DAY_MS).toISOString(),
      })
      .where(eq(userSessions.id, id))
      .run();
    expect(lookup(token, 89 * DAY_MS + SESSION_REFRESH_MS).status).toBe('valid');
    // The refresh pulled the expiry back to the limit.
    expect(rows()[0]?.expiresAt).toBe(at(SESSION_MAX_AGE_MS).toISOString());
    expect(lookup(token, 90 * DAY_MS).status).toBe('none');
    expect(rows()).toEqual([]);
  });

  it('gives a new login 90 new days', () => {
    const first = start();
    const second = createSession(database.db, FIRST_USER_ID, { now: at(80 * DAY_MS) });
    expect(lookup(first.token, 91 * DAY_MS).status).toBe('none');
    expect(lookup(second.token, 91 * DAY_MS).status).toBe('valid');
  });

  it('cleans up rows past the expiry or the limit', () => {
    const old = start();
    database.db
      .update(userSessions)
      .set({ expiresAt: at(200 * DAY_MS).toISOString() })
      .where(eq(userSessions.id, old.id))
      .run();
    const idle = createSession(database.db, FIRST_USER_ID, { now: at(50 * DAY_MS) });
    const fresh = createSession(database.db, FIRST_USER_ID, { now: at(85 * DAY_MS) });
    deleteExpiredSessions(database.db, at(90 * DAY_MS));
    expect(rows().map((row) => row.id)).toEqual([fresh.id]);
    expect(idle.id).not.toBe(fresh.id);
  });
});
