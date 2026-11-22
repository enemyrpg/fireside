import {
  accountDetailResponseSchema,
  calendarResponseSchema,
  errorResponseSchema,
  screentimeHeatmapResponseSchema,
  screentimeResponseSchema,
  screentimeWorldsResponseSchema,
  type Event,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { accounts } from '../db/schema.js';
import { PROJECTIONS } from '../projections/index.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  TEST_NOW,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';

// Screen time, worlds and heatmap. Small hand-built data in Europe/Oslo (UTC+1
// in winter, UTC+2 in summer); every expected number is worked out by hand in
// the comments. One heartbeat = 60 s.

const TZ = 'Europe/Oslo';
const HASH_A = '1111111111';
const HASH_B = '2222222222';
const NOW = new Date('2026-11-10T12:00:00.000Z');

let app: FastifyInstance | undefined;
let run: TestRun | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function start(events: readonly Event[], now = NOW): void {
  run = emptyRun();
  ingestBatch(run, events, PROJECTIONS, TEST_NOW);
  expect(run.failed).toEqual([]);
  app = buildApp({ db: run.database, config: testConfig({ TZ }), dashboard: { now: () => now } });
}

async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
  expect(response.statusCode, response.body).toBe(200);
  return schema.parse(response.json());
}

async function getError(url: string, status: number) {
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
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

const url = (account: number | 'all', path: string, query: string) =>
  `/api/v1/accounts/${String(account)}/screentime${path}?${query}`;

/** Totals of `active` and `afk` heartbeats. */
const time = (active: number, afk = 0) => ({
  playedSeconds: (active + afk) * 60,
  activeSeconds: active * 60,
  afkSeconds: afk * 60,
});

const f = eventFactory();
const A = (n: number) => ({ accountHash: HASH_A, sessionId: sessionIdOf(n) });
const B = (n: number) => ({ accountHash: HASH_B, sessionId: sessionIdOf(n) });
interface World {
  world: number;
  worldTypes: string[];
  worldLocation: string | null;
  worldActivity: string | null;
}
const W420: World = {
  world: 420,
  worldTypes: ['MEMBERS'],
  worldLocation: 'GERMANY',
  worldActivity: 'Trade - Members',
};
const heartbeats = (
  times: readonly string[],
  options: { accountHash: string; sessionId: string },
  world: World = W420,
) => times.map((at) => f.heartbeat(at, { ...options, payload: world }));

// --- Week 2026-W45: Mon 2 Nov – Sun 8 Nov, [1 Nov 23:00Z, 8 Nov 23:00Z) ------

const W45 = 'from=2026-11-01T23:00:00.000Z&to=2026-11-08T23:00:00.000Z';
const weekEvents = [
  // A, S1, Mon 2 Nov 20:00–20:06 local (19:00Z…). AFK 19:02–19:04Z: 19:02 and
  // 19:03 are AFK, 19:04 active (end exclusive). The 19:06 heartbeat comes
  // after session.end and still counts. 6 heartbeats: 4 active, 2 AFK.
  f.sessionStart('2026-11-02T18:59:00.000Z', A(1)),
  ...heartbeats(
    [
      '2026-11-02T19:00:00.000Z',
      '2026-11-02T19:01:00.000Z',
      '2026-11-02T19:02:00.000Z',
      '2026-11-02T19:03:00.000Z',
      '2026-11-02T19:04:00.000Z',
    ],
    A(1),
  ),
  f.afk('2026-11-02T19:02:00.000Z', '2026-11-02T19:04:00.000Z', A(1)),
  f.sessionEnd('2026-11-02T19:05:00.000Z', A(1)),
  ...heartbeats(['2026-11-02T19:06:00.000Z'], A(1)),

  // A, S2, F2P world 301 across midnight: Wed 23:58, 23:59, Thu 00:00 local.
  // The world list is loaded only for the first heartbeat.
  f.sessionStart('2026-11-04T22:57:00.000Z', A(2)),
  ...heartbeats(['2026-11-04T22:58:00.000Z'], A(2), {
    world: 301,
    worldTypes: [],
    worldLocation: 'UNITED_KINGDOM',
    worldActivity: 'Trade - Free',
  }),
  ...heartbeats(['2026-11-04T22:59:00.000Z', '2026-11-04T23:00:00.000Z'], A(2), {
    world: 301,
    worldTypes: [],
    worldLocation: null,
    worldActivity: null,
  }),
  f.sessionEnd('2026-11-04T23:01:00.000Z', A(2)),

  // A, S3, Sat 7 Nov 19:00–19:02 local: two minutes on PvP world 330, then
  // one on world 420 with new types (latest types win for 420).
  f.sessionStart('2026-11-07T17:59:00.000Z', A(3)),
  ...heartbeats(['2026-11-07T18:00:00.000Z', '2026-11-07T18:01:00.000Z'], A(3), {
    world: 330,
    worldTypes: ['MEMBERS', 'PVP'],
    worldLocation: 'AUSTRALIA',
    worldActivity: 'PvP',
  }),
  ...heartbeats(['2026-11-07T18:02:00.000Z'], A(3), {
    world: 420,
    worldTypes: ['MEMBERS', 'SKILL_TOTAL'],
    worldLocation: 'GERMANY',
    worldActivity: '2200 skill total',
  }),
  f.sessionEnd('2026-11-07T18:03:00.000Z', A(3)),

  // A, S4, previous week (Fri 30 Oct): 3 active heartbeats.
  f.sessionStart('2026-10-30T11:59:00.000Z', A(4)),
  ...heartbeats(
    ['2026-10-30T12:00:00.000Z', '2026-10-30T12:01:00.000Z', '2026-10-30T12:02:00.000Z'],
    A(4),
  ),
  f.sessionEnd('2026-10-30T12:03:00.000Z', A(4)),

  // B never sends session.start (no display name). S10: Sun 8 Nov 11:00 and
  // 11:01 local. Its AFK period covers A's S3 minutes, but only AFK periods
  // of the same session count.
  f.afk('2026-11-07T18:00:00.000Z', '2026-11-07T18:03:00.000Z', B(10)),
  ...heartbeats(['2026-11-08T10:00:00.000Z', '2026-11-08T10:01:00.000Z'], B(10)),
];

/** A day bucket in W45 (local midnight = 23:00Z the day before). */
const day = (date: number, active: number, afk = 0) => ({
  period: `2026-11-0${String(date)}`,
  start: `2026-11-0${String(date - 1)}T23:00:00.000Z`,
  activeSeconds: active * 60,
  afkSeconds: afk * 60,
});

describe('GET /accounts/:accountId/screentime', () => {
  it('gives every day of the week, totals, previous week and stats', async () => {
    start(weekEvents);
    const a = accountIdOf(HASH_A);
    expect(await get(url(a, '', W45), screentimeResponseSchema)).toEqual({
      from: '2026-11-01T23:00:00.000Z',
      to: '2026-11-08T23:00:00.000Z',
      bucket: 'day',
      // S1 on Mon (4 + 2 AFK), S2 on Wed (2) and Thu (1), S3 on Sat (3).
      buckets: [day(2, 4, 2), day(3, 0), day(4, 2), day(5, 1), day(6, 0), day(7, 3), day(8, 0)],
      totals: time(10, 2),
      previous: time(3),
      stats: {
        sessionCount: 3,
        averagePerDaySeconds: 102, // 720 / 7 = 102.86
        averageSessionSeconds: 240, // 720 / 3
        longestSessionSeconds: 360, // S1
        afkShare: 0.1667, // 120 / 720
      },
    });
  });

  it('sums all accounts for `all`', async () => {
    start(weekEvents);
    const all = await get(url('all', '', W45), screentimeResponseSchema);
    expect(all.buckets.at(-1)).toEqual(day(8, 2));
    expect(all.totals).toEqual(time(12, 2));
    expect(all.previous).toEqual(time(3));
    expect(all.stats).toEqual({
      sessionCount: 4,
      averagePerDaySeconds: 120, // 840 / 7
      averageSessionSeconds: 210, // 840 / 4
      longestSessionSeconds: 360,
      afkShare: 0.1429, // 120 / 840
    });
  });

  it('handles an account without session.start', async () => {
    start(weekEvents);
    const b = accountIdOf(HASH_B);
    const detail = await get(`/api/v1/accounts/${String(b)}`, accountDetailResponseSchema);
    expect(detail.displayName).toBeNull();
    const response = await get(url(b, '', W45), screentimeResponseSchema);
    expect(response.totals).toEqual(time(2));
    expect(response.previous).toBeNull();
    expect(response.stats).toMatchObject({ sessionCount: 1, longestSessionSeconds: 120 });
  });

  it('gives week and month buckets whose start can be before from', async () => {
    start(weekEvents);
    const a = accountIdOf(HASH_A);
    const week = await get(url(a, '', `${W45}&bucket=week`), screentimeResponseSchema);
    expect(week.buckets).toEqual([
      {
        period: '2026-W45',
        start: '2026-11-01T23:00:00.000Z',
        activeSeconds: 600,
        afkSeconds: 120,
      },
    ]);
    // Range 1–15 Nov local: one month bucket, starting 1 Nov local (31 Oct 23:00Z).
    const month = await get(
      url(a, '', 'from=2026-10-31T23:00:00.000Z&to=2026-11-15T23:00:00.000Z&bucket=month'),
      screentimeResponseSchema,
    );
    expect(month.buckets).toEqual([
      { period: '2026-11', start: '2026-10-31T23:00:00.000Z', activeSeconds: 600, afkSeconds: 120 },
    ]);
    // Mid-week range: Wed 4 Nov 12:00 local to Mon 9 Nov 12:00. W45 holds only
    // S2 and S3 (6 minutes); the partial W46 bucket is empty.
    const partial = await get(
      url(a, '', 'from=2026-11-04T11:00:00.000Z&to=2026-11-09T11:00:00.000Z&bucket=week'),
      screentimeResponseSchema,
    );
    expect(partial.buckets).toEqual([
      { period: '2026-W45', start: '2026-11-01T23:00:00.000Z', activeSeconds: 360, afkSeconds: 0 },
      { period: '2026-W46', start: '2026-11-08T23:00:00.000Z', activeSeconds: 0, afkSeconds: 0 },
    ]);
    // Not local midnights: previous is the same length in ms, [30 Oct 11:00Z, 4 Nov 11:00Z),
    // which holds S4 (3) and S1 (6).
    expect(partial.previous).toEqual(time(7, 2));
  });

  it('gives zeros and previous null without data, and only counts days so far', async () => {
    start(weekEvents, new Date('2026-11-04T12:00:00.000Z'));
    const a = accountIdOf(HASH_A);
    const empty = await get(
      url(a, '', 'from=2026-12-06T23:00:00.000Z&to=2026-12-08T23:00:00.000Z'),
      screentimeResponseSchema,
    );
    expect(empty.buckets.map((b) => b.period)).toEqual(['2026-12-07', '2026-12-08']);
    expect(empty.totals).toEqual(time(0));
    expect(empty.previous).toBeNull();
    expect(empty.stats).toEqual({
      sessionCount: 0,
      averagePerDaySeconds: 0, // the range is in the future: no days so far
      averageSessionSeconds: 0,
      longestSessionSeconds: 0,
      afkShare: 0,
    });
    // Now is Wed 4 Nov: Mon–Wed have started, 720 / 3 = 240.
    const week = await get(url(a, '', W45), screentimeResponseSchema);
    expect(week.stats.averagePerDaySeconds).toBe(240);
  });

  it('defaults to the last 30 local days', async () => {
    start(weekEvents);
    const a = accountIdOf(HASH_A);
    const response = await get(url(a, '', ''), screentimeResponseSchema);
    // Now is Tue 10 Nov: 12 Oct 00:00 CEST to 11 Nov 00:00 CET (30 days + 1 hour).
    expect(response.from).toBe('2026-10-11T22:00:00.000Z');
    expect(response.to).toBe('2026-11-10T23:00:00.000Z');
    expect(response.buckets).toHaveLength(30);
    expect(response.buckets[0]?.period).toBe('2026-10-12');
    expect(response.totals).toEqual(time(13, 2)); // S1–S4
    expect(response.stats.averagePerDaySeconds).toBe(30); // 900 / 30
  });
});

describe('GET /accounts/:accountId/screentime/worlds', () => {
  it('gives time per world, world type and location', async () => {
    start(weekEvents);
    const a = accountIdOf(HASH_A);
    expect(await get(url(a, '/worlds', W45), screentimeWorldsResponseSchema)).toEqual({
      from: '2026-11-01T23:00:00.000Z',
      to: '2026-11-08T23:00:00.000Z',
      worlds: [
        // S1 (4 active, 2 AFK) + S3's last minute. Latest types and activity from S3.
        {
          world: 420,
          seconds: 420,
          activeSeconds: 300,
          afkSeconds: 120,
          worldTypes: ['MEMBERS', 'SKILL_TOTAL'],
          location: 'GERMANY',
          activity: '2200 skill total',
        },
        // Latest known location, although the last two minutes had none.
        {
          world: 301,
          seconds: 180,
          activeSeconds: 180,
          afkSeconds: 0,
          worldTypes: [],
          location: 'UNITED_KINGDOM',
          activity: 'Trade - Free',
        },
        {
          world: 330,
          seconds: 120,
          activeSeconds: 120,
          afkSeconds: 0,
          worldTypes: ['MEMBERS', 'PVP'],
          location: 'AUSTRALIA',
          activity: 'PvP',
        },
      ],
      // MEMBERS: S1 6 + S3 3. F2P world 301 has no type.
      worldTypes: [
        { type: 'MEMBERS', seconds: 540 },
        { type: 'PVP', seconds: 120 },
        { type: 'SKILL_TOTAL', seconds: 60 },
      ],
      // By each minute's own location; null (no world list) after AUSTRALIA on a tie.
      locations: [
        { location: 'GERMANY', seconds: 420 },
        { location: 'AUSTRALIA', seconds: 120 },
        { location: null, seconds: 120 },
        { location: 'UNITED_KINGDOM', seconds: 60 },
      ],
    });
  });

  it('sums all accounts and gives empty lists without data', async () => {
    start(weekEvents);
    const all = await get(url('all', '/worlds', W45), screentimeWorldsResponseSchema);
    expect(all.worlds[0]).toMatchObject({ world: 420, seconds: 540, activeSeconds: 420 });
    expect(all.locations[0]).toEqual({ location: 'GERMANY', seconds: 540 });
    const empty = await get(
      url('all', '/worlds', 'from=2026-12-01T00:00:00.000Z&to=2026-12-02T00:00:00.000Z'),
      screentimeWorldsResponseSchema,
    );
    expect(empty).toMatchObject({ worlds: [], worldTypes: [], locations: [] });
  });
});

describe('GET /accounts/:accountId/screentime/heatmap', () => {
  it('gives local weekday × hour cells with play time', async () => {
    start(weekEvents);
    const a = accountIdOf(HASH_A);
    const cell = (weekday: number, hour: number, minutes: number) => ({
      weekday,
      hour,
      seconds: minutes * 60,
    });
    expect(await get(url(a, '/heatmap', W45), screentimeHeatmapResponseSchema)).toEqual({
      from: '2026-11-01T23:00:00.000Z',
      to: '2026-11-08T23:00:00.000Z',
      // Mon 20:xx (S1), Wed 23:58–59 and Thu 00:00 (S2), Sat 19:xx (S3).
      cells: [cell(1, 20, 6), cell(3, 23, 2), cell(4, 0, 1), cell(6, 19, 3)],
    });
    const all = await get(url('all', '/heatmap', W45), screentimeHeatmapResponseSchema);
    expect(all.cells.at(-1)).toEqual(cell(7, 11, 2)); // B, Sun 11:00–11:01
  });
});

// --- DST in Europe/Oslo ---------------------------------------------------------

describe('screen time across DST changes', () => {
  const dstEvents = [
    // Spring: Sun 29 Mar 2026 is 23 hours, [28 Mar 23:00Z, 29 Mar 22:00Z).
    // 22:59Z = Sat 23:59; 23:00Z = Sun 00:00; 00:59Z = 01:59 CET;
    // 01:00Z = 03:00 CEST (no hour 2); 21:59Z = Sun 23:59; 22:00Z = Mon 30 Mar 00:00.
    f.sessionStart('2026-03-28T22:58:00.000Z', A(20)),
    ...heartbeats(
      [
        '2026-03-28T22:59:00.000Z',
        '2026-03-28T23:00:00.000Z',
        '2026-03-29T00:59:00.000Z',
        '2026-03-29T01:00:00.000Z',
        '2026-03-29T21:59:00.000Z',
        '2026-03-29T22:00:00.000Z',
      ],
      A(20),
    ),
    f.sessionEnd('2026-03-29T22:01:00.000Z', A(20)),
    // 22 Mar 22:30Z = Sun 23:30 (W12); 23:30Z = Mon 23 Mar 00:30 (W13).
    f.sessionStart('2026-03-22T22:29:00.000Z', A(21)),
    ...heartbeats(['2026-03-22T22:30:00.000Z', '2026-03-22T23:30:00.000Z'], A(21)),
    f.sessionEnd('2026-03-22T23:31:00.000Z', A(21)),

    // Autumn: Sun 25 Oct 2026 is 25 hours, [24 Oct 22:00Z, 25 Oct 23:00Z).
    // 21:59Z = Sat 23:59; 22:00Z = Sun 00:00; 00:30Z = 02:30 CEST;
    // 01:30Z = 02:30 CET (hour 2 again); 22:59Z = Sun 23:59; 23:00Z = Mon 26 Oct 00:00.
    f.sessionStart('2026-10-24T21:58:00.000Z', A(22)),
    ...heartbeats(
      [
        '2026-10-24T21:59:00.000Z',
        '2026-10-24T22:00:00.000Z',
        '2026-10-25T00:30:00.000Z',
        '2026-10-25T01:30:00.000Z',
        '2026-10-25T22:59:00.000Z',
        '2026-10-25T23:00:00.000Z',
      ],
      A(22),
    ),
    f.sessionEnd('2026-10-25T23:01:00.000Z', A(22)),
  ];
  // W13 = Mon 23 Mar 00:00 CET – Mon 30 Mar 00:00 CEST (167 hours).
  const W13 = 'from=2026-03-22T23:00:00.000Z&to=2026-03-29T22:00:00.000Z';
  // W43 = Mon 19 Oct 00:00 CEST – Mon 26 Oct 00:00 CET (169 hours).
  const W43 = 'from=2026-10-18T22:00:00.000Z&to=2026-10-25T23:00:00.000Z';
  const bucket = (period: string, startAt: string, minutes: number) => ({
    period,
    start: startAt,
    activeSeconds: minutes * 60,
    afkSeconds: 0,
  });

  it('gives a 23-hour day in March and a 25-hour day in October', async () => {
    start(dstEvents);
    const a = accountIdOf(HASH_A);
    const spring = await get(url(a, '', W13), screentimeResponseSchema);
    expect(spring.buckets.filter((b) => b.activeSeconds > 0)).toEqual([
      bucket('2026-03-23', '2026-03-22T23:00:00.000Z', 1),
      bucket('2026-03-28', '2026-03-27T23:00:00.000Z', 1),
      bucket('2026-03-29', '2026-03-28T23:00:00.000Z', 4),
    ]);
    expect(spring.buckets).toHaveLength(7);

    const autumn = await get(url(a, '', W43), screentimeResponseSchema);
    expect(autumn.buckets.filter((b) => b.activeSeconds > 0)).toEqual([
      bucket('2026-10-24', '2026-10-23T22:00:00.000Z', 1),
      bucket('2026-10-25', '2026-10-24T22:00:00.000Z', 4),
    ]);
    expect(autumn.buckets).toHaveLength(7);
    expect(autumn.totals).toEqual(time(5)); // Mon 26 Oct 00:00 is outside
  });

  it('gives ISO weeks across the change', async () => {
    start(dstEvents);
    const a = accountIdOf(HASH_A);
    const range = 'from=2026-10-18T22:00:00.000Z&to=2026-11-01T23:00:00.000Z&bucket=week';
    expect((await get(url(a, '', range), screentimeResponseSchema)).buckets).toEqual([
      bucket('2026-W43', '2026-10-18T22:00:00.000Z', 5),
      bucket('2026-W44', '2026-10-25T23:00:00.000Z', 1),
    ]);
  });

  it('compares a week with the previous local week, not one shifted by an hour', async () => {
    start(dstEvents);
    const a = accountIdOf(HASH_A);
    // W14 = [29 Mar 22:00Z, 5 Apr 22:00Z) has only Mon 30 Mar 00:00. Previous is
    // W13 (167 hours): the 22 Mar 22:30Z minute (W12) is not in it, although a
    // shift of 7 × 24 hours (from 22 Mar 22:00Z) would include it.
    const w14 = await get(
      url(a, '', 'from=2026-03-29T22:00:00.000Z&to=2026-04-05T22:00:00.000Z&bucket=week'),
      screentimeResponseSchema,
    );
    expect(w14.totals).toEqual(time(1));
    expect(w14.previous).toEqual(time(6));
  });

  it('puts both 02:00 hours in hour 2 in October and has no hour 2 in March', async () => {
    start(dstEvents);
    const a = accountIdOf(HASH_A);
    const cell = (weekday: number, hour: number, minutes = 1) => ({
      weekday,
      hour,
      seconds: minutes * 60,
    });
    expect((await get(url(a, '/heatmap', W13), screentimeHeatmapResponseSchema)).cells).toEqual([
      cell(1, 0), // Mon 23 Mar 00:30
      cell(6, 23), // Sat 23:59
      cell(7, 0),
      cell(7, 1),
      cell(7, 3),
      cell(7, 23),
    ]);
    expect((await get(url(a, '/heatmap', W43), screentimeHeatmapResponseSchema)).cells).toEqual([
      cell(6, 23),
      cell(7, 0),
      cell(7, 2, 2),
      cell(7, 23),
    ]);
  });

  it('gives the same totals as the calendar, worlds and heatmap', async () => {
    start([...weekEvents, ...dstEvents]);
    const ranges = [
      W13,
      W43,
      W45,
      'from=2026-03-01T00:00:00.000Z&to=2026-11-30T00:00:00.000Z',
      'from=2026-03-29T00:30:00.000Z&to=2026-10-25T01:45:00.000Z',
    ];
    for (const account of [accountIdOf(HASH_A), accountIdOf(HASH_B), 'all'] as const) {
      for (const range of ranges) {
        const screen = await get(url(account, '', range), screentimeResponseSchema);
        const calendar = await get(
          `/api/v1/accounts/${String(account)}/calendar?${range}`,
          calendarResponseSchema,
        );
        const worlds = await get(url(account, '/worlds', range), screentimeWorldsResponseSchema);
        const heatmap = await get(url(account, '/heatmap', range), screentimeHeatmapResponseSchema);
        const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
        const played = screen.totals.playedSeconds;
        expect(sum(calendar.days.map((d) => d.playedSeconds)), range).toBe(played);
        expect(sum(calendar.days.map((d) => d.afkSeconds)), range).toBe(screen.totals.afkSeconds);
        expect(sum(worlds.worlds.map((w) => w.seconds)), range).toBe(played);
        expect(sum(worlds.locations.map((l) => l.seconds)), range).toBe(played);
        expect(sum(heatmap.cells.map((c) => c.seconds)), range).toBe(played);
      }
    }
  });
});

// --- Errors -----------------------------------------------------------------------

describe('screen time request errors', () => {
  it.each([
    ['', 'unknown=1', 'query'],
    ['', 'from=2026-11-01T23:00:00.000Z', 'query.to'],
    ['', 'to=2026-11-01T23:00:00.000Z', 'query.from'],
    ['', 'from=2025-11-01T23:00:00.000Z&to=2026-11-08T23:00:00.000Z', 'query.to'],
    ['', 'from=2026-11-08T23:00:00.000Z&to=2026-11-01T23:00:00.000Z', 'query.to'],
    ['', 'from=2026-11-01&to=2026-11-08', 'query.from'],
    ['', 'bucket=hour', 'query.bucket'],
    ['/worlds', 'bucket=day', 'query'],
    ['/worlds', 'from=2026-11-01T23:00:00.000Z', 'query.to'],
    ['/heatmap', 'bucket=day', 'query'],
    ['/heatmap', 'from=2025-11-01T23:00:00.000Z&to=2026-11-08T23:00:00.000Z', 'query.to'],
  ])('%s?%s gives 400 on %s', async (path, query, field) => {
    start(weekEvents);
    const error = await getError(url('all', path, query), 400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.map((d) => d.path)).toContain(field);
  });

  it.each(['', '/worlds', '/heatmap'])('%s gives 404 for an unknown account', async (path) => {
    start(weekEvents);
    expect((await getError(url(999, path, W45), 404)).code).toBe('NOT_FOUND');
    expect((await getError(url(0, path, W45), 400)).code).toBe('VALIDATION_ERROR');
  });
});
