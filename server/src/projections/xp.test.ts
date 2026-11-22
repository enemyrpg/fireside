import { describe, expect, it } from 'vitest';
import { xpSnapshots } from '../db/schema.js';
import {
  eventFactory,
  expectOrderIndependent,
  runIncremental,
  TEST_ACCOUNT_HASH,
} from './testing.js';
import { FIRST_USER_ID } from '../users/users.js';

const SESSION = '01933c40-8a2b-7c3d-9e4f-000000000001';

function at(time: string): string {
  return `2026-11-08T${time}:00.000Z`;
}

describe('xp projection', () => {
  it('stores xp-snapshot.json with totals computed on the server', () => {
    const f = eventFactory();
    const event = f.fromFixture('xp-snapshot.json', '19:00');
    const snapshot = expectOrderIndependent([event]);
    const xp = snapshot.xp as { snapshots: unknown[]; skills: unknown[] };

    // Hand-summed from the fixture.
    expect(xp.snapshots).toEqual([
      {
        userId: FIRST_USER_ID,
        accountHash: TEST_ACCOUNT_HASH,
        eventId: event.eventId,
        sessionId: SESSION,
        takenAt: at('19:00'),
        reason: 'interval',
        totalXp: 152_492_255,
        totalLevel: 2132,
      },
    ]);
    expect(xp.skills).toHaveLength(24);
    expect(xp.skills).toContainEqual({
      eventId: event.eventId,
      skill: 'ATTACK',
      xp: 13_034_431,
      level: 99,
    });
  });

  it('stores unknown extra skills but leaves them out of the totals', () => {
    const f = eventFactory();
    const event = f.fromFixture('xp-snapshot-unknown-extra-skill.json', '19:00', {
      payload: {
        skills: {
          ...(
            f.fromFixture('xp-snapshot-unknown-extra-skill.json', '19:00').payload as {
              skills: object;
            }
          ).skills,
          NEW_SKILL: { xp: 5000, level: 20 },
        },
      },
    });
    const xp = expectOrderIndependent([event]).xp as {
      snapshots: { totalXp: number; totalLevel: number }[];
      skills: { skill: string; xp: number }[];
    };

    expect(xp.snapshots[0]).toMatchObject({ totalXp: 1154, totalLevel: 33 });
    expect(xp.skills).toHaveLength(25);
    expect(xp.skills).toContainEqual(expect.objectContaining({ skill: 'NEW_SKILL', xp: 5000 }));
  });

  it('keeps one snapshot per event for several snapshots and accounts, in any order', () => {
    const f = eventFactory();
    const other = { accountHash: '-987654321', sessionId: '01933c40-8a2b-7c3d-9e4f-000000000002' };
    const events = [
      f.fromFixture('xp-snapshot.json', '19:00', { payload: { reason: 'login' } }),
      f.fromFixture('xp-snapshot.json', '19:05'),
      f.fromFixture('xp-snapshot.json', '19:05'),
      f.fromFixture('xp-snapshot.json', '20:00', { payload: { reason: 'logout' } }),
      f.fromFixture('xp-snapshot-unknown-extra-skill.json', '19:30', other),
    ];
    const xp = expectOrderIndependent(events).xp as { snapshots: unknown[] };
    expect(xp.snapshots).toHaveLength(5);
  });

  it('projects a snapshot whose session has no session.start yet', () => {
    const f = eventFactory();
    const run = runIncremental([f.fromFixture('xp-snapshot.json', '19:00')]);
    expect(run.failed).toEqual([]);
    expect(run.database.db.select().from(xpSnapshots).all()).toEqual([
      expect.objectContaining({ sessionId: SESSION }),
    ]);
  });
});
