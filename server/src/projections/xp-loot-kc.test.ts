import { describe, expect, it } from 'vitest';
import { kcObservationOf } from './kc.js';
import { eventFactory, expectOrderIndependent, validFixtureFiles } from './testing.js';

const OTHER = {
  accountHash: '-987654321',
  sessionId: '01933c40-8a2b-7c3d-9e4f-000000000002',
};

describe('xp, loot and kc projections together', () => {
  it('give the same result for all fixtures in any order, with failures', () => {
    const f = eventFactory();
    const files = [
      ...validFixtureFiles('xp.snapshot'),
      ...validFixtureFiles('loot'),
      ...validFixtureFiles('kc'),
    ];
    // Session events arrive in the middle, so most events come before their
    // session.start and some after its session.end.
    const events = [
      ...files.map((file, i) => f.fromFixture(file, `19:${String(10 + i).padStart(2, '0')}`)),
      ...files.map((file, i) =>
        f.fromFixture(file, `20:${String(10 + i).padStart(2, '0')}`, OTHER),
      ),
      f.sessionStart('19:30'),
      f.sessionEnd('19:40'),
      f.sessionStart('20:00', { ...OTHER, displayName: 'Alt' }),
    ];

    const snapshot = expectOrderIndependent(events) as {
      xp: { snapshots: unknown[] };
      loot: { lootEvents: unknown[] };
      kc: unknown[];
    };
    const ofType = (type: string) => events.filter((event) => event.type === type);
    expect(snapshot.xp.snapshots).toHaveLength(ofType('xp.snapshot').length);
    expect(snapshot.loot.lootEvents).toHaveLength(ofType('loot').length);
    // Every kc event, plus each named loot event with killCount.
    const withKc = events.filter((event) => kcObservationOf(event) !== undefined);
    expect(withKc.length).toBeGreaterThan(ofType('kc').length);
    expect(snapshot.kc).toHaveLength(withKc.length);
  });
});
