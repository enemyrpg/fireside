import {
  errorResponseSchema,
  weeklyResponseSchema,
  type Event,
  type WeeklyResponse,
} from '@fireside/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { accounts, weeklySummaries } from '../db/schema.js';
import { PROJECTIONS } from '../projections/index.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';

// Weekly summary. Small hand-built data in Europe/Oslo (UTC+1 in winter) around the
// year boundary, where 2026 has 53 ISO weeks:
// - 2026-W52: Mon 21 Dec – Sun 27 Dec, [2026-12-20T23:00Z, 2026-12-27T23:00Z)
// - 2026-W53: Mon 28 Dec – Sun 3 Jan,  [2026-12-27T23:00Z, 2027-01-03T23:00Z)
// - 2027-W01: Mon 4 Jan – Sun 10 Jan,  [2027-01-03T23:00Z, 2027-01-10T23:00Z)
// Every expected number is worked out by hand in the comments. One heartbeat = 60 s.

const TZ = 'Europe/Oslo';
const HASH_A = '1111111111';
const HASH_B = '2222222222';
/** Wednesday of 2027-W03, so W52–W02 are complete. */
const NOW = new Date('2027-01-20T12:00:00.000Z');

let app: FastifyInstance | undefined;
let run: TestRun | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Builds the app on the run's database. Closing an app closes the database,
 * so a test that needs a second app (another `TZ`) leaves the first open.
 */
function startApp(timeZone = TZ, now = NOW): void {
  app = buildApp({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set by start()
    db: run!.database,
    config: testConfig({ TZ: timeZone }),
    dashboard: { now: () => now },
  });
}

function start(events: readonly Event[], now = NOW): void {
  run = emptyRun();
  ingest(events, now);
  startApp(TZ, now);
}

function ingest(events: readonly Event[], now = NOW): void {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set by start()
  ingestBatch(run!, events, PROJECTIONS, now);
  expect(run?.failed).toEqual([]);
}

async function weekly(account: number | 'all', query = ''): Promise<WeeklyResponse> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set by start()
  const response = await app!.inject({
    method: 'GET',
    url: `/api/v1/accounts/${String(account)}/weekly${query}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return weeklyResponseSchema.parse(response.json());
}

const week = (account: number | 'all', key: string) => weekly(account, `?week=${key}`);

async function getError(url: string, status: number) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set by start()
  const response = await app!.inject({ method: 'GET', url });
  expect(response.statusCode, response.body).toBe(status);
  return errorResponseSchema.parse(response.json()).error;
}

function accountIdOf(hash: string): number {
  const row = run?.database.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.accountHash, hash))
    .get();
  expect(row, hash).toBeDefined();
  return row?.id ?? 0;
}

function storedRow(accountId: number, key: string) {
  return run?.database.db
    .select()
    .from(weeklySummaries)
    .where(and(eq(weeklySummaries.accountId, accountId), eq(weeklySummaries.isoWeek, key)))
    .get();
}

const f = eventFactory();
const A = (n: number) => ({ accountHash: HASH_A, sessionId: sessionIdOf(n) });
const B = (n: number) => ({ accountHash: HASH_B, sessionId: sessionIdOf(n) });
const onWorld = (world: number) => ({
  world,
  worldTypes: [],
  worldLocation: null,
  worldActivity: null,
});
const beats = (
  times: readonly string[],
  options: { accountHash: string; sessionId: string },
  world = 420,
) => times.map((at) => f.heartbeat(at, { ...options, payload: onWorld(world) }));
const minutes = (prefix: string, from: number, to: number) =>
  Array.from(
    { length: to - from + 1 },
    (_, i) => `${prefix}:${String(from + i).padStart(2, '0')}:00.000Z`,
  );
const SNAPSHOT_W52 = {
  SLAYER: { xp: 1000, level: 9 },
  HITPOINTS: { xp: 1154, level: 10 },
  NEWSKILL: 0,
};
const SNAPSHOT_W53 = {
  SLAYER: { xp: 5000, level: 20 },
  ATTACK: { xp: 300, level: 4 },
  HITPOINTS: { xp: 1300, level: 11 },
  MAGIC: { xp: 300, level: 4 },
  // Unknown skill with the biggest gain: never in the totals or top skills.
  NEWSKILL: 9000,
};

const events = [
  // --- A, 2026-W52: 3 minutes on world 420, XP and KC start values.
  f.sessionStart('2026-12-22T17:59:00.000Z', A(1)),
  ...beats(minutes('2026-12-22T18', 0, 2), A(1)),
  f.xpSnapshot('2026-12-22T18:00:00.000Z', SNAPSHOT_W52, A(1)),
  f.kc('2026-12-22T18:01:00.000Z', { killCount: 10, ...A(1) }),

  // --- A, 2026-W53.
  // S2 Wed 30 Dec: 5 heartbeats on 420, AFK 19:01–19:03 → 3 active, 2 AFK.
  f.sessionStart('2026-12-30T18:59:00.000Z', A(2)),
  ...beats(minutes('2026-12-30T19', 0, 4), A(2)),
  f.afk('2026-12-30T19:01:00.000Z', '2026-12-30T19:03:00.000Z', A(2)),
  f.kc('2026-12-30T19:02:00.000Z', { killCount: 12, ...A(2) }),
  // Zulrah first seen this week: KC 5 counts as 0, 5 → 7 gives 2.
  f.kc('2026-12-30T19:03:00.000Z', { killCount: 5, boss: 'Zulrah', ...A(2) }),
  // Three items: 1 × 100, 3 × 1000 = 3000, 1 × 3000 = 3000 (tie: payload order).
  f.loot('2026-12-30T19:03:00.000Z', {
    items: [
      { itemId: 1, name: 'Small', quantity: 1, gePrice: 100, haPrice: 1 },
      { itemId: 2, name: 'Tied first', quantity: 3, gePrice: 1000, haPrice: 2 },
      { itemId: 3, name: 'Tied second', quantity: 1, gePrice: 3000, haPrice: 3 },
    ],
    ...A(2),
  }),
  f.loot('2026-12-30T19:04:00.000Z', { geValue: 5000, ...A(2) }),
  // S3 Thu 31 Dec: 2 heartbeats on world 301.
  f.sessionStart('2026-12-31T19:59:00.000Z', A(3)),
  ...beats(minutes('2026-12-31T20', 0, 1), A(3), 301),
  f.kc('2026-12-31T20:00:00.000Z', { killCount: 15, ...A(3) }),
  f.kc('2026-12-31T20:01:00.000Z', { killCount: 7, boss: 'Zulrah', ...A(3) }),
  f.xpSnapshot('2026-12-31T20:01:00.000Z', SNAPSHOT_W53, A(3)),
  f.loot('2026-12-31T20:00:00.000Z', {
    source: { type: 'PLAYER', name: null },
    items: [{ itemId: 4, name: 'From a player', quantity: 2, gePrice: 1000, haPrice: 0 }],
    ...A(3),
  }),
  f.loot('2026-12-31T20:01:00.000Z', { geValue: 50, ...A(3) }),
  // S4 across the year boundary on world 302: Sun 3 Jan 23:58 and 23:59 local
  // are in W53, Mon 4 Jan 00:00 and 00:01 in 2027-W01.
  f.sessionStart('2027-01-03T22:57:00.000Z', A(4)),
  ...beats(minutes('2027-01-03T22', 58, 59), A(4), 302),
  ...beats(minutes('2027-01-03T23', 0, 1), A(4), 302),
  f.kc('2027-01-03T22:59:00.000Z', { killCount: 16, ...A(4) }),
  f.kc('2027-01-03T23:00:00.000Z', { killCount: 17, ...A(4) }),
  f.xpSnapshot(
    '2027-01-04T00:00:00.000Z',
    { ...SNAPSHOT_W53, SLAYER: { xp: 6000, level: 21 } },
    A(4),
  ),

  // --- B (no session.start, so no name or type), 2026-W53, Tue 29 Dec:
  // 7 heartbeats on world 302, XP 100 → 600 SLAYER (level 1 → 5), Vorkath 1 → 3.
  ...beats(minutes('2026-12-29T10', 0, 6), B(10), 302),
  f.xpSnapshot('2026-12-29T10:00:00.000Z', { SLAYER: { xp: 100, level: 1 } }, B(10)),
  f.xpSnapshot('2026-12-29T10:06:00.000Z', { SLAYER: { xp: 600, level: 5 } }, B(10)),
  f.kc('2026-12-29T10:02:00.000Z', { killCount: 1, ...B(10) }),
  f.kc('2026-12-29T10:05:00.000Z', { killCount: 3, ...B(10) }),
  f.loot('2026-12-29T10:01:00.000Z', { geValue: 4000, ...B(10) }),
];

const W52 = { start: '2026-12-20T23:00:00.000Z', end: '2026-12-27T23:00:00.000Z' };
const W53 = { start: '2026-12-27T23:00:00.000Z', end: '2027-01-03T23:00:00.000Z' };
const W01 = { start: '2027-01-03T23:00:00.000Z', end: '2027-01-10T23:00:00.000Z' };

const drop = (accountId: number, overrides: object) => ({
  accountId,
  source: { type: 'NPC', name: 'Vorkath' },
  ...overrides,
});

describe('weekly summary', () => {
  it('sums one account’s 2026-W53 by hand', async () => {
    start(events);
    const a = accountIdOf(HASH_A);
    const body = await week(a, '2026-W53');
    expect(body).toMatchObject({ week: '2026-W53', ...W53, complete: true });
    expect(body.computedAt).toBe(NOW.toISOString());
    // S2 5 (3 active, 2 AFK), S3 2, S4 2 before midnight: 9 minutes.
    // World 420: 5 min, 301: 2, 302: 2. Previous week (W52): 3 minutes.
    expect(body.playtime).toEqual({
      playedSeconds: 540,
      activeSeconds: 420,
      afkSeconds: 120,
      previousWeekPlayedSeconds: 180,
      mostPlayedWorld: 420,
    });
    // From the W52 snapshot to the last W53 one: SLAYER +4000 (9 → 20),
    // ATTACK +300 (1 → 4), MAGIC +300 (1 → 4), HITPOINTS +146 (10 → 11).
    // NEWSKILL isn't counted. ATTACK before MAGIC on a tie (SKILLS order).
    expect(body.xp).toEqual({
      xpGained: 4746,
      levelsGained: 18,
      topSkills: [
        { skill: 'SLAYER', xpGained: 4000 },
        { skill: 'ATTACK', xpGained: 300 },
        { skill: 'MAGIC', xpGained: 300 },
      ],
    });
    // 100 + 3000 + 3000 + 5000 + 2000 + 50 = 13150. Top 5 drops by value; the
    // two 3000 drops in payload order; PLAYER loot without a name.
    expect(body.loot?.geValue).toBe(13150);
    expect(body.loot?.topDrops.map((d) => [d.name, d.geValue, d.source])).toEqual([
      ['Coins', 5000, { type: 'NPC', name: 'Vorkath' }],
      ['Tied first', 3000, { type: 'NPC', name: 'Vorkath' }],
      ['Tied second', 3000, { type: 'NPC', name: 'Vorkath' }],
      ['From a player', 2000, { type: 'PLAYER', name: null }],
      ['Small', 100, { type: 'NPC', name: 'Vorkath' }],
    ]);
    expect(body.loot?.topDrops[0]).toMatchObject(
      drop(a, {
        sessionId: sessionIdOf(2),
        occurredAt: '2026-12-30T19:04:00.000Z',
        quantity: 5000,
      }),
    );
    // Vorkath: 16 (Sun 23:59) − 10 (last before the week) = 6. Zulrah 7 − 5 = 2.
    expect(body.kc).toEqual({
      bosses: [
        { boss: 'Vorkath', gained: 6 },
        { boss: 'Zulrah', gained: 2 },
      ],
    });
  });

  it('splits the year boundary between 2026-W53 and 2027-W01', async () => {
    start(events);
    const a = accountIdOf(HASH_A);
    const body = await week(a, '2027-W01');
    expect(body).toMatchObject({ week: '2027-W01', ...W01, complete: true });
    // 00:00 and 00:01 Monday; the previous week is 2026-W53 (9 minutes).
    expect(body.playtime).toEqual({
      playedSeconds: 120,
      activeSeconds: 120,
      afkSeconds: 0,
      previousWeekPlayedSeconds: 540,
      mostPlayedWorld: 302,
    });
    // SLAYER 5000 → 6000 (20 → 21) from the last W53 snapshot.
    expect(body.xp).toEqual({
      xpGained: 1000,
      levelsGained: 1,
      topSkills: [{ skill: 'SLAYER', xpGained: 1000 }],
    });
    expect(body.loot).toBeNull();
    // 17 (Mon 00:00) − 16 (Sun 23:59).
    expect(body.kc).toEqual({ bosses: [{ boss: 'Vorkath', gained: 1 }] });
  });

  it('leaves sections without content null', async () => {
    start(events);
    const a = accountIdOf(HASH_A);
    // W52: the first snapshot and first KC are start values, so no gains.
    const w52 = await week(a, '2026-W52');
    expect(w52).toMatchObject({ ...W52, xp: null, loot: null, kc: null });
    expect(w52.playtime).toEqual({
      playedSeconds: 180,
      activeSeconds: 180,
      afkSeconds: 0,
      previousWeekPlayedSeconds: 0,
      mostPlayedWorld: 420,
    });
    // No data at all, long before the account existed. Never stored, so old
    // weeks don't fill the table.
    const empty = await week(a, '2020-W53');
    expect(storedRow(a, '2020-W53')).toBeUndefined();
    expect(storedRow(a, '2026-W52')).toBeDefined();
    expect(empty).toMatchObject({
      week: '2020-W53',
      start: '2020-12-27T23:00:00.000Z',
      end: '2021-01-03T23:00:00.000Z',
      playtime: null,
      xp: null,
      loot: null,
      kc: null,
    });
  });

  it('sums all accounts for `all`, including one without session.start', async () => {
    start(events);
    const a = accountIdOf(HASH_A);
    const b = accountIdOf(HASH_B);
    const bWeek = await week(b, '2026-W53');
    expect(bWeek.playtime).toMatchObject({ playedSeconds: 420, mostPlayedWorld: 302 });
    expect(bWeek.xp).toEqual({
      xpGained: 500,
      levelsGained: 4,
      topSkills: [{ skill: 'SLAYER', xpGained: 500 }],
    });
    expect(bWeek.kc).toEqual({ bosses: [{ boss: 'Vorkath', gained: 2 }] });

    const all = await week('all', '2026-W53');
    // World 302: A 120 + B 420 = 540 beats world 420 (300).
    expect(all.playtime).toEqual({
      playedSeconds: 960,
      activeSeconds: 840,
      afkSeconds: 120,
      previousWeekPlayedSeconds: 180,
      mostPlayedWorld: 302,
    });
    expect(all.xp).toEqual({
      xpGained: 5246,
      levelsGained: 22,
      topSkills: [
        { skill: 'SLAYER', xpGained: 4500 },
        { skill: 'ATTACK', xpGained: 300 },
        { skill: 'MAGIC', xpGained: 300 },
      ],
    });
    expect(all.loot?.geValue).toBe(17150);
    expect(all.loot?.topDrops.map((d) => [d.accountId, d.geValue])).toEqual([
      [a, 5000],
      [b, 4000],
      [a, 3000],
      [a, 3000],
      [a, 2000],
    ]);
    expect(all.kc).toEqual({
      bosses: [
        { boss: 'Vorkath', gained: 8 },
        { boss: 'Zulrah', gained: 2 },
      ],
    });
    // 2027-W01: only A played; the previous week is both accounts.
    expect((await week('all', '2027-W01')).playtime).toMatchObject({
      playedSeconds: 120,
      previousWeekPlayedSeconds: 960,
    });
  });

  it('keeps bosses named like object prototype keys', async () => {
    start([
      f.kc('2026-12-29T10:00:00.000Z', { killCount: 1, boss: '__proto__', ...A(1) }),
      f.kc('2026-12-29T10:01:00.000Z', { killCount: 4, boss: '__proto__', ...A(1) }),
      f.kc('2026-12-29T10:02:00.000Z', { killCount: 2, boss: 'constructor', ...A(1) }),
      f.kc('2026-12-29T10:03:00.000Z', { killCount: 3, boss: 'constructor', ...A(1) }),
      f.kc('2026-12-29T10:04:00.000Z', { killCount: 5, boss: 'constructor', ...B(2) }),
      f.kc('2026-12-29T10:05:00.000Z', { killCount: 7, boss: 'constructor', ...B(2) }),
    ]);
    const a = accountIdOf(HASH_A);
    const bosses = [
      { boss: '__proto__', gained: 3 },
      { boss: 'constructor', gained: 1 },
    ];
    // Computed, then read back from the stored JSON.
    expect((await week(a, '2026-W53')).kc?.bosses).toEqual(bosses);
    expect((await week(a, '2026-W53')).kc?.bosses).toEqual(bosses);
    expect((await week('all', '2026-W53')).kc?.bosses).toEqual([
      { boss: '__proto__', gained: 3 },
      { boss: 'constructor', gained: 3 },
    ]);
  });

  it('gives the most played world with the lowest number on a tie', async () => {
    start([
      ...beats(minutes('2026-12-29T10', 0, 1), A(1), 330),
      ...beats(minutes('2026-12-29T11', 0, 1), A(2), 310),
    ]);
    expect((await week(accountIdOf(HASH_A), '2026-W53')).playtime?.mostPlayedWorld).toBe(310);
  });

  it('computes the current week live and without `week` uses it', async () => {
    // Wednesday 30 Dec 2026, 20:00 UTC: the current week is 2026-W53.
    const now = new Date('2026-12-30T20:00:00.000Z');
    start(events, now);
    const a = accountIdOf(HASH_A);
    const body = await weekly(a);
    expect(body).toMatchObject({ week: '2026-W53', ...W53, complete: false });
    expect(body.computedAt).toBe(now.toISOString());
    expect(storedRow(a, '2026-W53')).toBeUndefined();
    // A later week is allowed and never stored. 2027-W01 already has (future) data.
    expect(await week(a, '2027-W01')).toMatchObject({
      complete: false,
      computedAt: now.toISOString(),
    });
    expect(storedRow(a, '2027-W01')).toBeUndefined();
    const future = await week(a, '2027-W05');
    expect(future).toMatchObject({
      complete: false,
      playtime: null,
      xp: null,
      loot: null,
      kc: null,
    });
    expect(storedRow(a, '2027-W05')).toBeUndefined();
  });

  it('stores a completed week when first read and serves it from the table', async () => {
    start(events);
    const a = accountIdOf(HASH_A);
    const first = await week(a, '2026-W53');
    const row = storedRow(a, '2026-W53');
    expect(row).toMatchObject({ ...W53, computedAt: NOW.toISOString() });

    // Change the stored data: the next read must show it, so it comes from the table.
    const data = JSON.parse(row?.data ?? '{}') as { playtime: { activeSeconds: number } };
    data.playtime.activeSeconds += 60;
    run?.database.db
      .update(weeklySummaries)
      .set({ data: JSON.stringify(data) })
      .where(eq(weeklySummaries.isoWeek, '2026-W53'))
      .run();
    const second = await week(a, '2026-W53');
    expect(second.playtime?.playedSeconds).toBe((first.playtime?.playedSeconds ?? 0) + 60);
  });

  it('recomputes a stored week from an older data version or another time zone', async () => {
    start(events);
    const a = accountIdOf(HASH_A);
    const expected = await week(a, '2026-W53');
    const data = JSON.parse(storedRow(a, '2026-W53')?.data ?? '{}') as Record<string, unknown>;
    run?.database.db
      .update(weeklySummaries)
      .set({ data: JSON.stringify({ ...data, v: 0, kc: {} }) })
      .run();
    expect(await week(a, '2026-W53')).toEqual(expected);

    // TZ changed to UTC: W53 is [28 Dec 00:00Z, 4 Jan 00:00Z), so the
    // Monday 00:00 and 00:01 local heartbeats (23:00Z, 23:01Z) are now in W53.
    startApp('UTC');
    const utc = await week(a, '2026-W53');
    expect(utc).toMatchObject({
      start: '2026-12-28T00:00:00.000Z',
      end: '2027-01-04T00:00:00.000Z',
    });
    expect(utc.playtime?.playedSeconds).toBe(660);
    expect(storedRow(a, '2026-W53')).toMatchObject({ start: '2026-12-28T00:00:00.000Z' });
  });

  it('rejects unknown accounts and bad weeks', async () => {
    start(events);
    const a = accountIdOf(HASH_A);
    expect((await getError('/api/v1/accounts/999/weekly', 404)).code).toBe('NOT_FOUND');
    for (const query of ['week=2026-W54', 'week=2025-W53', 'week=2026-45', 'week=', 'foo=1']) {
      const error = await getError(`/api/v1/accounts/${String(a)}/weekly?${query}`, 400);
      expect(error.code, query).toBe('VALIDATION_ERROR');
    }
    // 2026 and 2020 have a week 53.
    await week(a, '2026-W53');
    await week(a, '2020-W53');
  });
});

describe('late events', () => {
  async function stored() {
    start(events);
    const a = accountIdOf(HASH_A);
    const before = {
      w52: await week(a, '2026-W52'),
      w53: await week(a, '2026-W53'),
      w01: await week(a, '2027-W01'),
    };
    expect(storedRow(a, '2026-W52')).toBeDefined();
    expect(storedRow(a, '2026-W53')).toBeDefined();
    expect(storedRow(a, '2027-W01')).toBeDefined();
    return { a, before };
  }

  it('a late heartbeat changes the completed week and the next one', async () => {
    const { a, before } = await stored();
    ingest(beats(['2026-12-31T20:02:00.000Z'], A(3), 301));
    expect(storedRow(a, '2026-W52')).toBeDefined();
    expect(storedRow(a, '2026-W53')).toBeUndefined();
    expect(storedRow(a, '2027-W01')).toBeUndefined();
    expect((await week(a, '2026-W53')).playtime?.playedSeconds).toBe(600);
    expect((await week(a, '2027-W01')).playtime?.previousWeekPlayedSeconds).toBe(600);
    expect(await week(a, '2026-W52')).toEqual(before.w52);
  });

  it('a late XP snapshot changes its week and the next week’s start', async () => {
    const { a } = await stored();
    // Sat 26 Dec (W52): SLAYER 2000 (level 10).
    ingest([
      f.xpSnapshot(
        '2026-12-26T12:00:00.000Z',
        { ...SNAPSHOT_W52, SLAYER: { xp: 2000, level: 10 } },
        A(1),
      ),
    ]);
    expect(storedRow(a, '2026-W52')).toBeUndefined();
    expect((await week(a, '2026-W52')).xp).toEqual({
      xpGained: 1000,
      levelsGained: 1,
      topSkills: [{ skill: 'SLAYER', xpGained: 1000 }],
    });
    // W53 SLAYER is now 2000 → 5000.
    expect((await week(a, '2026-W53')).xp?.topSkills[0]).toEqual({
      skill: 'SLAYER',
      xpGained: 3000,
    });
  });

  it('a late KC and loot change the completed week only from their own week on', async () => {
    const { a, before } = await stored();
    ingest([
      f.kc('2026-12-31T21:00:00.000Z', { killCount: 30, boss: 'Zulrah', ...A(3) }),
      f.loot('2026-12-31T21:00:00.000Z', { geValue: 9000, ...A(3) }),
    ]);
    const w53 = await week(a, '2026-W53');
    expect(w53.kc?.bosses).toContainEqual({ boss: 'Zulrah', gained: 25 });
    expect(w53.loot?.geValue).toBe(22150);
    expect(w53.loot?.topDrops[0]?.geValue).toBe(9000);
    expect(await week(a, '2026-W52')).toEqual(before.w52);
  });

  it('a late AFK period sent next week changes the week it started in', async () => {
    const { a } = await stored();
    // Sent Mon 00:01 local (W01), covering Sun 23:58 – Mon 00:01.
    ingest([f.afk('2027-01-03T22:58:00.000Z', '2027-01-03T23:01:00.000Z', A(4))]);
    expect(storedRow(a, '2026-W53')).toBeUndefined();
    expect((await week(a, '2026-W53')).playtime).toMatchObject({
      activeSeconds: 300,
      afkSeconds: 240,
    });
    expect((await week(a, '2027-W01')).playtime).toMatchObject({
      activeSeconds: 60,
      afkSeconds: 60,
    });
  });

  it('an event in a later week leaves earlier stored weeks alone', async () => {
    const { a } = await stored();
    const row = storedRow(a, '2026-W53');
    ingest([f.kc('2027-01-05T12:00:00.000Z', { killCount: 20, ...A(5) })]);
    expect(storedRow(a, '2026-W53')).toEqual(row);
    expect(storedRow(a, '2027-W01')).toBeUndefined();
    expect((await week(a, '2027-W01')).kc).toEqual({ bosses: [{ boss: 'Vorkath', gained: 4 }] });
  });

  it('an XP, loot or KC event for another account leaves the account’s weeks alone', async () => {
    const { a } = await stored();
    ingest([
      f.loot('2026-12-30T12:00:00.000Z', { geValue: 10, ...B(10) }),
      f.kc('2026-12-30T12:01:00.000Z', { killCount: 4, ...B(10) }),
      f.xpSnapshot('2026-12-30T12:02:00.000Z', { SLAYER: { xp: 700, level: 5 } }, B(10)),
    ]);
    expect(storedRow(a, '2026-W53')).toBeDefined();
  });

  it('a late session.start that moves a session to another account updates both', async () => {
    const { a } = await stored();
    const b = accountIdOf(HASH_B);
    const allBefore = await week('all', '2026-W53');
    const bBefore = await week(b, '2026-W53');
    // S3's events so far came from A (2 heartbeats on 301, Thu 31 Dec). A
    // session.start for S3 from B now makes S3 B's session, heartbeats included.
    ingest([
      f.sessionStart('2026-12-31T19:58:00.000Z', {
        accountHash: HASH_B,
        sessionId: sessionIdOf(3),
      }),
    ]);
    expect(storedRow(a, '2026-W53')).toBeUndefined();
    expect(storedRow(b, '2026-W53')).toBeUndefined();
    expect((await week(a, '2026-W53')).playtime?.playedSeconds).toBe(540 - 120);
    expect((await week(b, '2026-W53')).playtime?.playedSeconds).toBe(
      (bBefore.playtime?.playedSeconds ?? 0) + 120,
    );
    // Moved, not counted twice.
    expect((await week('all', '2026-W53')).playtime).toEqual(allBefore.playtime);
    // 2027-W01's previous week changed for A too.
    expect((await week(a, '2027-W01')).playtime?.previousWeekPlayedSeconds).toBe(420);
  });

  it('`all` shows a late event in a stored week', async () => {
    start(events);
    const before = await week('all', '2026-W53');
    ingest([f.loot('2026-12-29T11:00:00.000Z', { geValue: 1000, ...B(10) })]);
    expect((await week('all', '2026-W53')).loot?.geValue).toBe((before.loot?.geValue ?? 0) + 1000);
  });
});
