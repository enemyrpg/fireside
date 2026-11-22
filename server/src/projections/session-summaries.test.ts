import type { Event } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { PROJECTIONS } from './index.js';
import { sessionSummaries } from '../db/schema.js';
import {
  capLootValue,
  computeSessionSummary,
  kcGain,
  sessionSummariesProjection,
  xpGains,
} from './session-summaries.js';
import { closeTimedOutSessions, SESSION_TIMEOUT_MS } from './sessions.js';
import {
  emptyRun,
  eventFactory,
  expectOrderIndependent,
  ingestBatch,
  runIncremental,
  runRebuild,
  seededRandom,
  sessionIdOf,
  shuffled,
  snapshotDerived,
  TEST_NOW,
  type TestRun,
} from './testing.js';

const S1 = sessionIdOf(1);
const S2 = sessionIdOf(2);
const S3 = sessionIdOf(3);
const ALT = { accountHash: '-987654321', sessionId: S3 };

interface Summary {
  sessionId: string;
  xpGainedTotal: number;
  xpGainedBySkill: Record<string, number>;
  lootGeValue: number;
  lootCount: number;
  kcGainedByBoss: Record<string, number>;
}

const EMPTY = {
  xpGainedTotal: 0,
  xpGainedBySkill: {},
  lootGeValue: 0,
  lootCount: 0,
  kcGainedByBoss: {},
};

function summariesOf(snapshot: Record<string, unknown>): Summary[] {
  return snapshot['session-summaries'] as Summary[];
}

/** The summary of `sessionId` after an order-independence check of `events`. */
function expectedSummary(events: readonly Event[], sessionId = S1): Summary | undefined {
  return summariesOf(expectOrderIndependent(events, { shuffles: 10 })).find(
    (summary) => summary.sessionId === sessionId,
  );
}

function summaryOf(run: TestRun, sessionId = S1): Summary | undefined {
  return (sessionSummariesProjection.snapshot(run.database.db) as Summary[]).find(
    (summary) => summary.sessionId === sessionId,
  );
}

/** `TEST_NOW` minus `minutes`, as an event time. */
function minutesAgo(minutes: number): string {
  return new Date(TEST_NOW.getTime() - minutes * 60_000).toISOString();
}

describe('xpGains', () => {
  it('subtracts per known skill and sums the gains', () => {
    expect(
      xpGains(
        { SLAYER: 1000, HITPOINTS: 500, ATTACK: 7 },
        { SLAYER: 101_000, HITPOINTS: 20_500, ATTACK: 7 },
      ),
    ).toEqual({ total: 120_000, bySkill: { SLAYER: 100_000, HITPOINTS: 20_000 } });
  });

  it('ignores unknown skills, skills missing at the start and drops', () => {
    expect(xpGains({ NEW_SKILL: 0, ATTACK: 50 }, { NEW_SKILL: 9, ATTACK: 10, SLAYER: 5 })).toEqual({
      total: 0,
      bySkill: {},
    });
  });
});

describe('kcGain', () => {
  it('is the difference, never below 0', () => {
    expect(kcGain(394, 412)).toBe(18);
    expect(kcGain(5, 5)).toBe(0);
    expect(kcGain(10, 5)).toBe(0);
  });
});

describe('capLootValue', () => {
  it('keeps exact values and caps at the largest exact integer', () => {
    expect(capLootValue(1500)).toBe(1500);
    expect(capLootValue(Number.MAX_SAFE_INTEGER + 2)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('session summaries: XP', () => {
  it('is the last snapshot in the session minus the first, per skill and total', () => {
    const f = eventFactory();
    const summary = expectedSummary([
      f.sessionStart('19:00'),
      f.xpSnapshot('19:00', { SLAYER: 1000, HITPOINTS: 500 }, { reason: 'login' }),
      f.xpSnapshot('19:30', { SLAYER: 5000, HITPOINTS: 1500 }),
      f.xpSnapshot('20:00', { SLAYER: 101_000, HITPOINTS: 20_500 }, { reason: 'logout' }),
      f.sessionEnd('20:00'),
      // Another session's snapshot is not part of this one.
      f.xpSnapshot('21:00', { SLAYER: 900_000 }, { sessionId: S2 }),
    ]);
    expect(summary).toMatchObject({
      xpGainedTotal: 120_000,
      xpGainedBySkill: { HITPOINTS: 20_000, SLAYER: 100_000 },
    });
  });

  it('is 0 for a session with no XP change', () => {
    const f = eventFactory();
    const summary = expectedSummary([
      f.sessionStart('19:00'),
      f.xpSnapshot('19:00', { SLAYER: 1000 }, { reason: 'login' }),
      f.xpSnapshot('19:30', { SLAYER: 1000 }, { reason: 'logout' }),
      f.sessionEnd('19:30'),
    ]);
    expect(summary).toEqual({ sessionId: S1, ...EMPTY });
  });

  it('is 0 for a session with only a login snapshot', () => {
    const f = eventFactory();
    const summary = expectedSummary([
      f.sessionStart('19:00'),
      f.xpSnapshot('19:00', { SLAYER: 1000 }, { reason: 'login' }),
      f.sessionEnd('19:30'),
    ]);
    expect(summary).toEqual({ sessionId: S1, ...EMPTY });
  });

  it('is empty for a session with no events but start and end', () => {
    const f = eventFactory();
    expect(expectedSummary([f.sessionStart('19:00'), f.sessionEnd('19:30')])).toEqual({
      sessionId: S1,
      ...EMPTY,
    });
  });

  it('ignores unknown skills', () => {
    const f = eventFactory();
    const summary = expectedSummary([
      f.sessionStart('19:00'),
      f.xpSnapshot('19:00', { NEW_SKILL: 0 }, { reason: 'login' }),
      f.xpSnapshot('19:30', { NEW_SKILL: 500, ATTACK: 100 }, { reason: 'logout' }),
      f.sessionEnd('19:30'),
    ]);
    expect(summary).toMatchObject({ xpGainedTotal: 100, xpGainedBySkill: { ATTACK: 100 } });
  });
});

describe('session summaries: KC', () => {
  it('is the highest KC in the session minus the last KC before it', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent(
      [
        f.sessionStart('19:00'),
        f.kc('19:10', { killCount: 394 }),
        f.sessionEnd('19:30', { reason: 'hop' }),
        f.sessionStart('19:30', { sessionId: S2 }),
        f.kc('19:40', { killCount: 400, sessionId: S2 }),
        f.kc('19:50', { killCount: 412, sessionId: S2 }),
        f.sessionEnd('20:00', { sessionId: S2 }),
      ],
      { shuffles: 10 },
    );
    expect(summariesOf(snapshot).map((s) => [s.sessionId, s.kcGainedByBoss])).toEqual([
      [S1, { Vorkath: 0 }],
      [S2, { Vorkath: 18 }],
    ]);
  });

  it('counts the first-ever observation of a boss as 0', () => {
    const f = eventFactory();
    expect(
      expectedSummary([
        f.sessionStart('19:00'),
        f.kc('19:10', { killCount: 1 }),
        f.sessionEnd('19:30'),
      ])?.kcGainedByBoss,
    ).toEqual({ Vorkath: 0 });
  });

  it('counts kills after the first-ever observation (1 → 10 gives 9)', () => {
    const f = eventFactory();
    const summary = expectedSummary([
      f.sessionStart('19:00'),
      f.kc('19:05', { killCount: 1, boss: 'Zulrah' }),
      f.kc('19:10', { killCount: 10, boss: 'Zulrah' }),
      f.kc('19:12', { killCount: 4, boss: 'Zulrah' }),
      f.sessionEnd('19:30'),
    ]);
    expect(summary?.kcGainedByBoss).toEqual({ Zulrah: 9 });
  });

  it('uses KC from loot events with killCount, under the normalized name', () => {
    const f = eventFactory();
    const summary = expectedSummary([
      f.sessionStart('19:00'),
      f.loot('19:05', { killCount: 5, source: { type: 'NPC', name: 'Vorkath' } }),
      f.kc('19:10', { killCount: 7, boss: 'vorkath' }),
      f.sessionEnd('19:30'),
    ]);
    expect(summary?.kcGainedByBoss).toEqual({ Vorkath: 2 });
  });

  it("never uses another account's KC as the start", () => {
    const f = eventFactory();
    const summary = expectedSummary([
      f.sessionStart('18:00', ALT),
      f.kc('18:10', { killCount: 100, ...ALT }),
      f.sessionEnd('18:30', ALT),
      f.sessionStart('19:00'),
      f.kc('19:10', { killCount: 3 }),
      f.kc('19:20', { killCount: 5 }),
      f.sessionEnd('19:30'),
    ]);
    expect(summary?.kcGainedByBoss).toEqual({ Vorkath: 2 });
  });

  it('updates a closed session when a late KC arrives for an earlier session', () => {
    const f = eventFactory();
    const lateKc = f.kc('19:10', { killCount: 394 });
    const earlier = [f.sessionStart('19:00'), f.sessionEnd('19:30')];
    const later = [
      f.sessionStart('20:00', { sessionId: S2 }),
      f.kc('20:10', { killCount: 400, sessionId: S2 }),
      f.kc('20:20', { killCount: 412, sessionId: S2 }),
      f.sessionEnd('20:30', { sessionId: S2 }),
    ];
    const run = emptyRun();
    ingestBatch(run, [...later, ...earlier]);
    expect(summaryOf(run, S2)?.kcGainedByBoss).toEqual({ Vorkath: 12 });

    ingestBatch(run, [lateKc]);
    expect(run.failed).toEqual([]);
    expect(summaryOf(run, S2)?.kcGainedByBoss).toEqual({ Vorkath: 18 });
    expect(summaryOf(run, S1)?.kcGainedByBoss).toEqual({ Vorkath: 0 });
    expect(snapshotDerived(run)).toEqual(
      snapshotDerived(runRebuild([...earlier, lateKc, ...later])),
    );
  });
});

describe('session summaries: loot', () => {
  it('sums GE value and counts loot events with the session ID, PLAYER loot included', () => {
    const f = eventFactory();
    const summary = expectedSummary([
      f.sessionStart('19:00'),
      f.loot('19:10', { geValue: 1000 }),
      f.loot('19:20', { geValue: 500, source: { type: 'PLAYER', name: null } }),
      f.loot('19:25', { geValue: 7, sessionId: S2 }),
      f.sessionEnd('19:30'),
    ]);
    expect(summary).toMatchObject({ lootGeValue: 1500, lootCount: 2 });
  });

  it('is updated by a late loot event after the session closed', () => {
    const f = eventFactory();
    const start = f.sessionStart('19:00');
    const loot = f.loot('19:10', { geValue: 1000 });
    const end = f.sessionEnd('19:30');
    const late = f.loot('19:20', { geValue: 250 });

    const run = emptyRun();
    ingestBatch(run, [start, loot, end]);
    expect(summaryOf(run)).toMatchObject({ lootGeValue: 1000, lootCount: 1 });
    ingestBatch(run, [late]);
    expect(run.failed).toEqual([]);
    expect(summaryOf(run)).toMatchObject({ lootGeValue: 1250, lootCount: 2 });
    expect(expectedSummary([start, loot, end, late])).toEqual(summaryOf(run));
  });
});

describe('session summaries: lifecycle', () => {
  it('has no summary while the session is open', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(run, [
      f.sessionStart(minutesAgo(30)),
      f.xpSnapshot(minutesAgo(30), { SLAYER: 0 }, { reason: 'login' }),
      f.loot(minutesAgo(20)),
      f.heartbeat(minutesAgo(1)),
    ]);
    expect(run.failed).toEqual([]);
    expect(summaryOf(run)).toBeUndefined();
  });

  it('is built when the timeout job closes the session, same as a rebuild then', () => {
    const f = eventFactory();
    const events = [
      f.sessionStart(minutesAgo(30)),
      f.xpSnapshot(minutesAgo(30), { SLAYER: 0 }, { reason: 'login' }),
      f.xpSnapshot(minutesAgo(5), { SLAYER: 300 }),
      f.loot(minutesAgo(20), { geValue: 40 }),
      f.heartbeat(minutesAgo(1)),
    ];
    const run = emptyRun();
    ingestBatch(run, events);
    const later = new Date(TEST_NOW.getTime() + SESSION_TIMEOUT_MS);
    expect(closeTimedOutSessions(run.database.db, later)).toBe(1);
    expect(summaryOf(run)).toEqual({
      sessionId: S1,
      ...EMPTY,
      xpGainedTotal: 300,
      xpGainedBySkill: { SLAYER: 300 },
      lootGeValue: 40,
      lootCount: 1,
    });
    expect(snapshotDerived(run)).toEqual(snapshotDerived(runRebuild(events, PROJECTIONS, later)));
  });

  it('is removed when a late heartbeat reopens the session', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(run, [f.sessionStart(minutesAgo(40)), f.heartbeat(minutesAgo(30))]);
    expect(summaryOf(run)).toEqual({ sessionId: S1, ...EMPTY });

    ingestBatch(run, [f.heartbeat(minutesAgo(2))]);
    expect(summaryOf(run)).toBeUndefined();
  });

  it('keeps its content when a real end replaces a timeout', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(run, [
      f.sessionStart('19:00'),
      f.loot('19:10', { geValue: 5 }),
      f.heartbeat('19:20'),
    ]);
    const before = summaryOf(run);
    expect(before).toMatchObject({ lootGeValue: 5, lootCount: 1 });

    ingestBatch(run, [f.sessionEnd('19:25')]);
    expect(summaryOf(run)).toEqual(before);
  });

  it('is not created by XP, loot or KC events without a session row', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(run, [f.xpSnapshot('19:00'), f.loot('19:10', { geValue: 9 }), f.kc('19:20')]);
    expect(summaryOf(run)).toBeUndefined();

    // The session row arrives later (and is closed): the summary includes them.
    ingestBatch(run, [f.sessionEnd('19:30')]);
    expect(summaryOf(run)).toMatchObject({
      lootGeValue: 9,
      lootCount: 1,
      kcGainedByBoss: { Vorkath: 0 },
    });
  });
});

/** Two accounts, three sessions: a hop, a timeout with late loot, PLAYER loot. */
function mixedScenario(): Event[] {
  const f = eventFactory();
  return [
    // Account 1, session 1: logout.
    f.sessionStart('18:00'),
    f.xpSnapshot('18:00', { SLAYER: 1000, RANGED: 50 }, { reason: 'login' }),
    f.heartbeat('18:05'),
    f.kc('18:10', { killCount: 10 }),
    f.loot('18:10', { geValue: 2000, killCount: 10 }),
    f.afk('18:20', '18:25'),
    f.kc('18:30', { killCount: 12, boss: 'Zulrah' }),
    f.xpSnapshot('18:40', { SLAYER: 9000, RANGED: 50 }, { reason: 'logout' }),
    f.sessionEnd('18:40', { reason: 'hop' }),
    // Account 1, session 2: times out, with a loot event after its last heartbeat.
    f.sessionStart('18:41', { sessionId: S2 }),
    f.xpSnapshot('18:41', { SLAYER: 9000, RANGED: 50 }, { reason: 'login', sessionId: S2 }),
    f.kc('18:50', { killCount: 15, sessionId: S2 }),
    f.heartbeat('19:00', { sessionId: S2 }),
    f.loot('19:05', { geValue: 300, sessionId: S2 }),
    // Account 2: only a login snapshot and PLAYER loot.
    f.sessionStart('18:30', ALT),
    f.xpSnapshot('18:30', { ATTACK: 10 }, { reason: 'login', ...ALT }),
    f.loot('18:35', { geValue: 70, source: { type: 'PLAYER', name: null }, ...ALT }),
    f.kc('18:36', { killCount: 3, ...ALT }),
    f.sessionEnd('18:45', ALT),
  ];
}

describe('session summaries in any order', () => {
  it('give the same result for a mixed scenario with two accounts, with failures', () => {
    const events = mixedScenario();
    const snapshot = expectOrderIndependent(events);
    expect(summariesOf(snapshot)).toEqual([
      {
        sessionId: S1,
        xpGainedTotal: 8000,
        xpGainedBySkill: { SLAYER: 8000 },
        lootGeValue: 2000,
        lootCount: 1,
        kcGainedByBoss: { Vorkath: 0, Zulrah: 0 },
      },
      {
        sessionId: S2,
        ...EMPTY,
        lootGeValue: 300,
        lootCount: 1,
        kcGainedByBoss: { Vorkath: 5 },
      },
      {
        sessionId: S3,
        ...EMPTY,
        lootGeValue: 70,
        lootCount: 1,
        kcGainedByBoss: { Vorkath: 0 },
      },
    ]);
  });
  it('updates step by step to the same summary as a full recompute', () => {
    const events = mixedScenario();
    const random = seededRandom(7);
    for (let round = 0; round < 15; round++) {
      const order = shuffled(events, random);
      const sizes = order.map(() => 1 + Math.floor(random() * 4));
      const run = runIncremental(order, { batchSizes: sizes });
      expect(run.failed).toEqual([]);
      const { db } = run.database;
      const stored = db.select().from(sessionSummaries).all();
      expect(stored.length, `round ${String(round)}`).toBe(3);
      for (const { sessionId, ...content } of stored) {
        expect(content, `round ${String(round)}, ${sessionId}`).toEqual(
          computeSessionSummary(db, sessionId),
        );
      }
    }
  });
});
