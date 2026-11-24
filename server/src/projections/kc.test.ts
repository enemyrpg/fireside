import { describe, expect, it } from 'vitest';
import { kcObservations } from '../db/schema.js';
import { latestKc } from '../read/kc.js';
import { FIRST_USER_ID } from '../users/users.js';
import { PROJECTIONS, type Projection } from './index.js';
import { kcProjection } from './kc.js';
import { kcObservationOf } from './kc-observation.js';
import { accountIdOf } from './lookup.js';
import {
  eventFactory,
  expectOrderIndependent,
  runIncremental,
  runRebuild,
  sessionIdOf,
  snapshotDerived,
  TEST_ACCOUNT_HASH,
  TEST_NOW,
} from './testing.js';
import { outdatedProjections, recomputeOutdated, recordCurrentVersions } from './versions.js';

const SESSION = '01933c40-8a2b-7c3d-9e4f-000000000001';

function at(time: string): string {
  return `2026-11-08T${time}:00.000Z`;
}

describe('kc projection', () => {
  it('stores kc.json', () => {
    const f = eventFactory();
    const event = f.fromFixture('kc.json', '19:00');
    expect(expectOrderIndependent([event]).kc).toEqual([
      {
        userId: FIRST_USER_ID,
        accountHash: TEST_ACCOUNT_HASH,
        eventId: event.eventId,
        sessionId: SESSION,
        observedAt: at('19:00'),
        boss: 'Vorkath',
        killCount: 412,
        timeSeconds: 74.4,
        personalBest: false,
        personalBestSeconds: 63,
        teamSize: null,
      },
    ]);
  });

  it('stores an unknown boss by name, without optional fields (kc-minimal.json)', () => {
    const f = eventFactory();
    expect(expectOrderIndependent([f.fromFixture('kc-minimal.json', '19:00')]).kc).toEqual([
      expect.objectContaining({
        boss: 'Some New Boss',
        killCount: 1,
        timeSeconds: null,
        personalBest: false,
        personalBestSeconds: null,
      }),
    ]);
  });

  it('stores teamSize for a raid mode (kc-raid.json)', () => {
    const f = eventFactory();
    expect(expectOrderIndependent([f.fromFixture('kc-raid.json', '19:00')]).kc).toEqual([
      expect.objectContaining({
        boss: 'Tombs of Amascut: Expert Mode',
        killCount: 140,
        timeSeconds: 1520.4,
        teamSize: 3,
      }),
    ]);
  });

  it('stores personalBestSeconds for a raid mode (kc-raid-personal-best.json)', () => {
    const f = eventFactory();
    const event = f.fromFixture('kc-raid-personal-best.json', '19:00');
    expect(expectOrderIndependent([event]).kc).toEqual([
      expect.objectContaining({ timeSeconds: 1520.4, personalBestSeconds: 1388.4, teamSize: 3 }),
    ]);
  });

  it('normalizes boss aliases, case and whitespace', () => {
    const f = eventFactory();
    const kc = expectOrderIndependent([
      f.fromFixture('kc.json', '19:00', { payload: { boss: '  kril   tsutsaroth ' } }),
      f.fromFixture('kc.json', '19:01', { payload: { boss: 'Barrows' } }),
      f.fromFixture('kc.json', '19:02', { payload: { boss: 'Jad', personalBest: true } }),
    ]).kc as { boss: string; personalBest: boolean }[];
    expect(kc.map((row) => row.boss)).toEqual(["K'ril Tsutsaroth", 'Barrows Chests', 'TzTok-Jad']);
    expect(kc[2]?.personalBest).toBe(true);
  });
});

describe('kc projection: one observation per kill', () => {
  interface Row {
    eventId: string;
    personalBest: boolean;
    killCount: number;
    timeSeconds: number | null;
    boss: string;
  }

  /** A kill as the plugin sends it: a `kc` event and its loot in the same tick. */
  function kill(f: ReturnType<typeof eventFactory>, time: string, killCount: number) {
    return {
      kc: f.kc(time, { killCount, timeSeconds: 60 + killCount }),
      loot: f.fromFixture('loot-npc.json', time, { payload: { killCount } }),
    };
  }

  function kcRows(run: ReturnType<typeof runIncremental>): Row[] {
    return kcProjection.snapshot(run.database.db) as Row[];
  }

  it('keeps the kc row, with its time, whether the loot comes before or after', () => {
    const f = eventFactory();
    const { kc, loot } = kill(f, '19:00', 412);
    for (const order of [
      [kc, loot],
      [loot, kc],
    ]) {
      expect(kcRows(runIncremental(order))).toEqual([
        expect.objectContaining({ eventId: kc.eventId, killCount: 412, timeSeconds: 472 }),
      ]);
    }
    expect(expectOrderIndependent([kc, loot]).kc).toEqual([
      expect.objectContaining({ eventId: kc.eventId, timeSeconds: 472 }),
    ]);
  });

  it('keeps loot with no matching kc (a chest with another count message)', () => {
    const f = eventFactory();
    const loot = f.fromFixture('loot-npc.json', '19:00', {
      payload: { source: { type: 'EVENT', name: 'Barrows' }, killCount: 900 },
    });
    // A kc for another kill count of the same boss does not replace it.
    const other = f.kc('19:05', { boss: 'Barrows Chests', killCount: 901 });
    expect(expectOrderIndependent([loot, other]).kc).toEqual([
      expect.objectContaining({ eventId: loot.eventId, boss: 'Barrows Chests', killCount: 900 }),
      expect.objectContaining({ eventId: other.eventId, killCount: 901 }),
    ]);
  });

  it('matches kc and loot by normalized boss name', () => {
    const f = eventFactory();
    const kc = f.kc('19:00', { boss: 'Dusk', killCount: 50, timeSeconds: 200 });
    const loot = f.fromFixture('loot-npc.json', '19:00', {
      payload: { source: { type: 'NPC', name: 'Grotesque Guardians' }, killCount: 50 },
    });
    expect(expectOrderIndependent([loot, kc]).kc).toEqual([
      expect.objectContaining({ eventId: kc.eventId, boss: 'Grotesque Guardians' }),
    ]);
  });

  it('keeps one row per kill for two kills in a row', () => {
    const f = eventFactory();
    const first = kill(f, '19:00', 412);
    const second = kill(f, '19:03', 413);
    const rows = expectOrderIndependent([first.loot, first.kc, second.kc, second.loot]).kc as Row[];
    expect(
      rows.map(({ eventId, killCount, timeSeconds }) => [eventId, killCount, timeSeconds]),
    ).toEqual([
      [first.kc.eventId, 412, 472],
      [second.kc.eventId, 413, 473],
    ]);
  });

  it('prefers the kc event with a time when two kc events report the same kill', () => {
    const f = eventFactory();
    const untimed = f.kc('19:00', { killCount: 412 });
    const timed = f.kc('19:00', { killCount: 412, timeSeconds: 70 });
    for (const order of [
      [untimed, timed],
      [timed, untimed],
    ]) {
      expect(kcRows(runIncremental(order))).toEqual([
        expect.objectContaining({ eventId: timed.eventId, timeSeconds: 70 }),
      ]);
    }
    expect(expectOrderIndependent([untimed, timed]).kc).toEqual([
      expect.objectContaining({ eventId: timed.eventId }),
    ]);
  });

  it('prefers the kc event with the PB flag, even without seconds', () => {
    const f = eventFactory();
    const plain = f.fromFixture('kc-minimal.json', '19:00', {
      payload: { boss: 'Vorkath', killCount: 412 },
    });
    const flagged = f.fromFixture('kc-minimal.json', '19:00', {
      payload: { boss: 'Vorkath', killCount: 412, personalBest: true },
    });
    for (const order of [
      [plain, flagged],
      [flagged, plain],
    ]) {
      expect(kcRows(runIncremental(order))).toEqual([
        expect.objectContaining({ eventId: flagged.eventId, personalBest: true }),
      ]);
    }
    expect(expectOrderIndependent([plain, flagged]).kc).toEqual([
      expect.objectContaining({ eventId: flagged.eventId, personalBest: true }),
    ]);
  });

  it('keeps the earliest of two equal observations', () => {
    const f = eventFactory();
    const first = f.fromFixture('loot-npc.json', '19:00', { payload: { killCount: 7 } });
    const second = f.fromFixture('loot-npc.json', '19:01', { payload: { killCount: 7 } });
    expect(expectOrderIndependent([second, first]).kc).toEqual([
      expect.objectContaining({ eventId: first.eventId }),
    ]);
  });

  it('updates the session summaries when the loot of a kill is in another session', () => {
    const f = eventFactory();
    const one = { sessionId: sessionIdOf(1) };
    const two = { sessionId: sessionIdOf(2) };
    const events = [
      f.sessionStart('18:00', one),
      f.kc('18:30', { killCount: 10, timeSeconds: 80, ...one }),
      // The loot of kill 11 is the last event of session 1, its kc the first of session 2.
      f.fromFixture('loot-npc.json', '18:59', { payload: { killCount: 11 }, ...one }),
      f.sessionEnd('18:59', one),
      f.sessionStart('19:00', two),
      f.kc('19:00', { killCount: 11, timeSeconds: 81, ...two }),
      f.kc('19:10', { killCount: 12, timeSeconds: 82, ...two }),
      f.sessionEnd('19:20', two),
    ];
    const snapshot = expectOrderIndependent(events);
    expect((snapshot.kc as Row[]).map((row) => row.killCount)).toEqual([10, 11, 12]);
    expect(snapshot['session-summaries']).toEqual([
      expect.objectContaining({ sessionId: sessionIdOf(1), kcGainedByBoss: { Vorkath: 0 } }),
      expect.objectContaining({ sessionId: sessionIdOf(2), kcGainedByBoss: { Vorkath: 2 } }),
    ]);
  });

  it('gives the same totals and latest KC as before, and the newest row has its time', () => {
    const f = eventFactory();
    const kills = [kill(f, '19:00', 412), kill(f, '19:03', 413), kill(f, '19:06', 414)];
    const events = kills.flatMap(({ kc, loot }) => [kc, loot]);
    const windowStart = '2026-11-01T00:00:00.000Z';

    const before = runRebuild(events, withLegacyKc());
    const after = runRebuild(events);
    expect(kcRows(before)).toHaveLength(6);
    expect(kcRows(after)).toHaveLength(3);
    const [old] = latestKc(before.database.db, [1], windowStart);
    const [now] = latestKc(after.database.db, [1], windowStart);
    expect(now).toEqual(old);
    expect(now).toMatchObject({ boss: 'Vorkath', killCount: 414, bestTimeSeconds: 472 });

    const newest = kcRows(after).at(-1);
    expect(newest).toMatchObject({ eventId: kills[2]?.kc.eventId, timeSeconds: 474 });
    const newestBefore = kcRows(before).at(-1);
    // Before the fix, the newest row was the loot, without a time.
    expect(newestBefore?.timeSeconds).toBeNull();
  });

  it('recomputes rows built with the old rules to the same rows as a rebuild', () => {
    const f = eventFactory();
    const one = { sessionId: sessionIdOf(1) };
    const two = { sessionId: sessionIdOf(2) };
    const untimed = f.kc('19:30', { killCount: 3, ...two });
    const timed = f.kc('19:30', { killCount: 3, timeSeconds: 99, ...two });
    const events = [
      f.sessionStart('18:00', one),
      ...Object.values(kill(f, '18:30', 1)),
      f.fromFixture('loot-npc.json', '18:59', { payload: { killCount: 2 }, ...one }),
      f.sessionEnd('18:59', one),
      f.sessionStart('19:00', two),
      f.kc('19:00', { killCount: 2, timeSeconds: 62, ...two }),
      untimed,
      timed,
      f.fromFixture('loot-npc.json', '19:30', { payload: { killCount: 3 }, ...two }),
      f.fromFixture('loot-npc.json', '19:40', { payload: { killCount: 4 }, ...two }),
      f.sessionEnd('19:50', two),
    ];

    const old = runRebuild(events, withLegacyKc());
    recordCurrentVersions(old.database.db);
    old.database.sqlite.exec(`UPDATE projection_versions SET version = 1 WHERE name = 'kc'`);
    const outdated = outdatedProjections(old.database.sqlite);
    expect(outdated.map((p) => p.name)).toEqual(['kc']);
    const report = recomputeOutdated(old.database.db, outdated, { now: () => TEST_NOW });
    expect(report.tables).toEqual([
      'kc_observations',
      'projection_versions',
      'session_summaries',
      'weekly_summaries',
    ]);
    expect(report.counts).toMatchObject({ kcObservationsRemoved: 4 });

    const rebuilt = runRebuild(events);
    expect(snapshotDerived(old)).toEqual(snapshotDerived(rebuilt));
    expect((snapshotDerived(rebuilt).kc as Row[]).map((row) => row.eventId)).toContain(
      timed.eventId,
    );
  });
});

/** The projections with the kc rules before one observation per kill: a row per event. */
function withLegacyKc(): Projection[] {
  const legacy: Projection = {
    ...kcProjection,
    version: 1,
    apply(tx, event) {
      const observation = kcObservationOf(event);
      if (!observation) return;
      tx.insert(kcObservations)
        .values({
          accountId: accountIdOf(tx, event),
          sessionId: event.sessionId,
          eventId: event.eventId,
          observedAt: event.occurredAt,
          ...observation,
        })
        .run();
    },
  };
  return PROJECTIONS.map((p) => (p.name === 'kc' ? legacy : p));
}
