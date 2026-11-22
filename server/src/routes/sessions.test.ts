import {
  calendarResponseSchema,
  errorResponseSchema,
  sessionDetailResponseSchema,
  sessionsResponseSchema,
  type Event,
  type Session,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { accounts } from '../db/schema.js';
import { closeTimedOutSessions } from '../projections/sessions.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  TEST_NOW,
  type TestRun,
} from '../projections/testing.js';
import { PROJECTIONS } from '../projections/index.js';
import { testConfig } from '../test-utils.js';

// Sessions, session detail and calendar. Small hand-built data in Europe/Oslo
// (UTC+1 in winter, UTC+2 in summer); every expected number is worked out by
// hand in the comments.

const TZ = 'Europe/Oslo';
const HASH_A = '1111111111';
const HASH_B = '2222222222';
const HASH_C = '3333333333';

let app: FastifyInstance | undefined;
let run: TestRun | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Ingests `events` with the projection clock at `projectedAt`, then starts the app. */
function start(
  events: readonly Event[],
  { projectedAt = TEST_NOW, now = new Date('2026-11-10T12:00:00.000Z') } = {},
): TestRun {
  run = emptyRun();
  ingestBatch(run, events, PROJECTIONS, projectedAt);
  expect(run.failed).toEqual([]);
  app = buildApp({ db: run.database, config: testConfig({ TZ }), dashboard: { now: () => now } });
  return run;
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

/** Account ID of a RuneLite account hash. */
function accountIdOf(hash: string): number {
  const row = run?.database.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.accountHash, hash))
    .get();
  expect(row, hash).toBeDefined();
  return row?.id ?? 0;
}

/** Every page of `…/sessions` with `query`, following `nextCursor`. */
async function allPages(account: number | 'all', query = ''): Promise<Session[][]> {
  const pages: Session[][] = [];
  let cursor: string | null = null;
  do {
    const page: z.infer<typeof sessionsResponseSchema> = await get(
      `/api/v1/accounts/${String(account)}/sessions?${query}${cursor ? `&cursor=${cursor}` : ''}`,
      sessionsResponseSchema,
    );
    pages.push(page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return pages;
}

// --- Sessions list ------------------------------------------------------------

describe('GET /accounts/:accountId/sessions', () => {
  // A: S1 (Nov 1), S2 and S3 (both Nov 2 10:00), S4 (Nov 3). B: S5 (Nov 2 12:00).
  // Newest first, ties by ID descending: A = S4, S3, S2, S1;
  // all = S4, S5, S3, S2, S1.
  const f = eventFactory();
  const A = (n: number) => ({ accountHash: HASH_A, sessionId: sessionIdOf(n) });
  const B = (n: number) => ({ accountHash: HASH_B, sessionId: sessionIdOf(n) });
  const listEvents = [
    f.sessionStart('2026-11-01T10:00:00.000Z', A(1)),
    f.sessionEnd('2026-11-01T11:00:00.000Z', A(1)),
    f.sessionStart('2026-11-02T12:00:00.000Z', { ...B(5), displayName: 'Alt' }),
    f.sessionEnd('2026-11-02T12:10:00.000Z', B(5)),
    f.sessionStart('2026-11-02T10:00:00.000Z', A(2)),
    f.sessionEnd('2026-11-02T10:30:00.000Z', A(2)),
    f.sessionStart('2026-11-02T10:00:00.000Z', A(3)),
    f.sessionEnd('2026-11-02T10:20:00.000Z', A(3)),
    f.sessionStart('2026-11-03T10:00:00.000Z', A(4)),
    f.sessionEnd('2026-11-03T10:45:00.000Z', A(4)),
  ];
  const ids = (pages: Session[][]) => pages.map((page) => page.map((s) => s.id));

  it('pages one account newest first, ties by ID, without gaps or duplicates', async () => {
    start(listEvents);
    const a = accountIdOf(HASH_A);
    expect(ids(await allPages(a, 'limit=2'))).toEqual([
      [sessionIdOf(4), sessionIdOf(3)],
      [sessionIdOf(2), sessionIdOf(1)],
    ]);
    expect(ids(await allPages(a, 'limit=3'))).toEqual([
      [sessionIdOf(4), sessionIdOf(3), sessionIdOf(2)],
      [sessionIdOf(1)],
    ]);
    expect(ids(await allPages(a))).toEqual([
      [sessionIdOf(4), sessionIdOf(3), sessionIdOf(2), sessionIdOf(1)],
    ]);
  });

  it('gives each session its neighbors in list order, within the account', async () => {
    start(listEvents);
    // A in list order (oldest first): S1, S2, S3 (S2 and S3 tie, by ID), S4. B: S5 alone.
    const neighbors = async (n: number) =>
      (await get(`/api/v1/sessions/${sessionIdOf(n)}`, sessionDetailResponseSchema)).neighbors;
    expect(await neighbors(1)).toEqual({ olderId: null, newerId: sessionIdOf(2) });
    expect(await neighbors(2)).toEqual({ olderId: sessionIdOf(1), newerId: sessionIdOf(3) });
    expect(await neighbors(3)).toEqual({ olderId: sessionIdOf(2), newerId: sessionIdOf(4) });
    expect(await neighbors(4)).toEqual({ olderId: sessionIdOf(3), newerId: null });
    expect(await neighbors(5)).toEqual({ olderId: null, newerId: null });
  });

  it('pages all accounts with accountId on each session', async () => {
    start(listEvents);
    const a = accountIdOf(HASH_A);
    const b = accountIdOf(HASH_B);
    const pages = await allPages('all', 'limit=2');
    expect(ids(pages)).toEqual([
      [sessionIdOf(4), sessionIdOf(5)],
      [sessionIdOf(3), sessionIdOf(2)],
      [sessionIdOf(1)],
    ]);
    expect(pages.flat().map((s) => s.accountId)).toEqual([a, b, a, a, a]);
  });

  it('gives closed sessions with times, world and an empty summary', async () => {
    start(listEvents);
    const [first] = await allPages(accountIdOf(HASH_A), 'limit=1');
    expect(first?.[0]).toEqual({
      id: sessionIdOf(4),
      accountId: accountIdOf(HASH_A),
      startedAt: '2026-11-03T10:00:00.000Z',
      endedAt: '2026-11-03T10:45:00.000Z',
      endReason: 'logout',
      world: 420,
      // 45 min, no AFK.
      durationSeconds: 2700,
      activeSeconds: 2700,
      afkSeconds: 0,
      summary: {
        xpGainedTotal: 0,
        xpGainedBySkill: {},
        lootGeValue: 0,
        lootCount: 0,
        kcGainedByBoss: {},
      },
      newCollectionLogCount: 0,
    });
  });

  it('filters on started_at in [from, to)', async () => {
    start(listEvents);
    // Nov 2 00:00 to Nov 3 10:00 (exclusive): S5, S3, S2. S4 starts exactly at `to`.
    expect(
      ids(await allPages('all', 'from=2026-11-02T00:00:00.000Z&to=2026-11-03T10:00:00.000Z')),
    ).toEqual([[sessionIdOf(5), sessionIdOf(3), sessionIdOf(2)]]);
    // `from` is inclusive: S2 and S3 start exactly at it.
    expect(
      ids(await allPages('all', 'from=2026-11-02T10:00:00.000Z&to=2026-11-02T11:00:00.000Z')),
    ).toEqual([[sessionIdOf(3), sessionIdOf(2)]]);
    expect(ids(await allPages('all', 'from=2026-12-01T00:00:00.000Z'))).toEqual([[]]);
  });

  it('rejects bad queries and unknown accounts', async () => {
    start(listEvents);
    const base = '/api/v1/accounts/all/sessions';
    for (const query of ['limit=0', 'limit=101', 'limit=01', 'foo=1', 'from=2026-11-02']) {
      expect((await getError(`${base}?${query}`, 400)).code).toBe('VALIDATION_ERROR');
    }
    expect(
      (await getError(`${base}?from=2026-11-02T00:00:00.000Z&to=2026-11-01T00:00:00.000Z`, 400))
        .details,
    ).toEqual([expect.objectContaining({ path: 'query.to' })]);
    const badCursors = [
      '!!!',
      Buffer.from('not json').toString('base64url'),
      Buffer.from(JSON.stringify(['2026-11-02T10:00:00.000Z'])).toString('base64url'),
      Buffer.from(JSON.stringify(['2026-11-02T10:00:00Z', sessionIdOf(1)])).toString('base64url'),
    ];
    for (const cursor of badCursors) {
      expect((await getError(`${base}?cursor=${cursor}`, 400)).details).toEqual([
        { path: 'query.cursor', message: 'Invalid cursor' },
      ]);
    }
    expect((await getError('/api/v1/accounts/999/sessions', 404)).code).toBe('NOT_FOUND');
    expect((await getError('/api/v1/accounts/abc/sessions', 400)).code).toBe('VALIDATION_ERROR');
  });
});

// --- Open and timed-out sessions ---------------------------------------------

describe('open and timed-out sessions', () => {
  // Account A, session O on 2026-11-09 from 11:00 UTC: heartbeats 11:01–11:05,
  // an AFK period 10:58–11:03 (starts before the session), XP, loot and KC.
  const f = eventFactory();
  const O = { accountHash: HASH_A, sessionId: sessionIdOf(7) };
  const at = (time: string) => `2026-11-09T${time}:00.000Z`;
  const openEvents = [
    f.sessionStart(at('11:00'), O),
    f.xpSnapshot(at('11:00'), { ATTACK: { xp: 1000, level: 9 } }, { ...O, reason: 'login' }),
    ...['11:01', '11:02', '11:03', '11:04', '11:05'].map((t) => f.heartbeat(at(t), O)),
    f.afk(at('10:58'), at('11:03'), O),
    f.kc(at('11:02'), { ...O, killCount: 5 }),
    f.loot(at('11:03'), { ...O, geValue: 2500 }),
    f.kc(at('11:04'), { ...O, killCount: 7 }),
    f.xpSnapshot(at('11:04'), { ATTACK: { xp: 1500, level: 10 }, SLAYER: 200 }, O),
  ];

  /** The detail parts that don't depend on whether the session is open. */
  const liveParts = {
    // ATTACK 1000 → 1500 (level 9 → 10), SLAYER 0 → 200 (level 1). SKILLS order.
    xp: [
      { skill: 'ATTACK', xpGained: 500, startLevel: 9, endLevel: 10 },
      { skill: 'SLAYER', xpGained: 200, startLevel: 1, endLevel: 1 },
    ],
    // No KC before the session: the first one (5) is the start.
    kc: [{ boss: 'Vorkath', startKillCount: 5, endKillCount: 7, gained: 2 }],
    // 10:58–11:03 clipped to the session start.
    afkPeriods: [{ startedAt: at('11:00'), endedAt: at('11:03') }],
  };

  it('has no end, no summary, but live XP, loot, KC and clipped AFK', async () => {
    // Projected at 11:06: one minute after the last heartbeat, so still open.
    start(openEvents, { projectedAt: new Date(at('11:06')) });
    const detail = await get(`/api/v1/sessions/${O.sessionId}`, sessionDetailResponseSchema);
    expect(detail.session).toEqual({
      id: O.sessionId,
      accountId: accountIdOf(HASH_A),
      startedAt: at('11:00'),
      endedAt: null,
      endReason: null,
      world: 420,
      // Open: counted to the last heartbeat (11:05), 5 min. AFK 11:00–11:03.
      durationSeconds: 300,
      activeSeconds: 120,
      afkSeconds: 180,
      summary: null,
      newCollectionLogCount: 0,
    });
    // The account's only session.
    expect(detail.neighbors).toEqual({ olderId: null, newerId: null });
    expect(detail).toMatchObject(liveParts);
    expect(detail.loot).toEqual([
      {
        id: expect.any(Number) as number,
        occurredAt: at('11:03'),
        source: { type: 'NPC', name: 'Vorkath' },
        killCount: null,
        geValue: 2500,
        haValue: 0,
        items: [{ itemId: 995, name: 'Coins', quantity: 2500, gePriceEach: 1, haPriceEach: 0 }],
      },
    ]);

    const list = await get('/api/v1/accounts/all/sessions', sessionsResponseSchema);
    expect(list.items).toEqual([detail.session]);
  });

  it('closes with timeout at the last heartbeat and gets a summary', async () => {
    const testRun = start(openEvents, { projectedAt: new Date(at('11:06')) });
    // The timeout job 10 min after the last heartbeat (11:05).
    expect(closeTimedOutSessions(testRun.database.db, new Date(at('11:15')))).toBe(1);

    const detail = await get(`/api/v1/sessions/${O.sessionId}`, sessionDetailResponseSchema);
    expect(detail.session).toMatchObject({
      endedAt: at('11:05'),
      endReason: 'timeout',
      durationSeconds: 300,
      activeSeconds: 120,
      afkSeconds: 180,
      summary: {
        xpGainedTotal: 700,
        xpGainedBySkill: { ATTACK: 500, SLAYER: 200 },
        lootGeValue: 2500,
        lootCount: 1,
        kcGainedByBoss: { Vorkath: 2 },
      },
    });
    expect(detail).toMatchObject(liveParts);
  });
});

// --- Session detail -----------------------------------------------------------

describe('GET /sessions/:sessionId', () => {
  // Account A. P (Nov 5) sees Vorkath KC 10. D (Nov 6 18:00–19:00 UTC) has
  // overlapping and out-of-range AFK, two bosses, NPC and PLAYER loot, and
  // XP with an odd drop and an unknown skill.
  const f = eventFactory();
  const P = { accountHash: HASH_A, sessionId: sessionIdOf(10) };
  const D = { accountHash: HASH_A, sessionId: sessionIdOf(11) };
  const N = { accountHash: HASH_C, sessionId: sessionIdOf(12) };
  const at = (time: string) => `2026-11-06T${time}:00.000Z`;
  const detailEvents = [
    f.sessionStart('2026-11-05T18:00:00.000Z', P),
    f.kc('2026-11-05T18:10:00.000Z', { ...P, killCount: 10 }),
    f.sessionEnd('2026-11-05T18:30:00.000Z', P),

    f.sessionStart(at('18:00'), D),
    f.xpSnapshot(
      at('18:00'),
      { ATTACK: { xp: 1000, level: 9 }, DEFENCE: { xp: 5000, level: 20 }, NEWSKILL: 100 },
      { ...D, reason: 'login' },
    ),
    f.afk(at('17:50'), at('18:05'), D),
    f.afk(at('18:20'), at('18:30'), D),
    f.afk(at('18:25'), at('18:40'), D),
    f.afk(at('18:55'), at('19:10'), D),
    f.kc(at('18:10'), { ...D, killCount: 11 }),
    f.loot(at('18:10'), {
      ...D,
      killCount: 11,
      items: [
        { itemId: 11286, name: 'Draconic visage', quantity: 1, gePrice: 2850000, haPrice: 60000 },
        { itemId: 536, name: 'Dragon bones', quantity: 2, gePrice: 2100, haPrice: 0 },
      ],
    }),
    f.kc(at('18:15'), { ...D, boss: 'Zulrah', killCount: 1 }),
    f.kc(at('18:30'), { ...D, killCount: 13 }),
    f.kc(at('18:45'), { ...D, boss: 'zulrah', killCount: 4 }),
    f.loot(at('18:50'), { ...D, source: { type: 'PLAYER', name: null }, geValue: 1500 }),
    f.xpSnapshot(
      at('18:59'),
      { ATTACK: { xp: 1500, level: 10 }, DEFENCE: { xp: 4000, level: 20 }, NEWSKILL: 300 },
      D,
    ),
    f.sessionEnd(at('19:00'), D),

    // Account C has no session.start: its only session event is an AFK period.
    f.afk('2026-11-07T10:00:00.000Z', '2026-11-07T10:10:00.000Z', N),
  ];

  it('gives XP, loot, KC and merged AFK periods', async () => {
    start(detailEvents);
    const detail = await get(`/api/v1/sessions/${D.sessionId}`, sessionDetailResponseSchema);
    // AFK clipped to 18:00–19:00 and merged: 18:00–18:05, 18:20–18:40, 18:55–19:00 = 30 min.
    expect(detail.afkPeriods).toEqual([
      { startedAt: at('18:00'), endedAt: at('18:05') },
      { startedAt: at('18:20'), endedAt: at('18:40') },
      { startedAt: at('18:55'), endedAt: at('19:00') },
    ]);
    expect(detail.session).toMatchObject({
      endReason: 'logout',
      durationSeconds: 3600,
      afkSeconds: 1800,
      activeSeconds: 1800,
      summary: {
        // Unknown skills don't count in the summary.
        xpGainedTotal: 500,
        xpGainedBySkill: { ATTACK: 500 },
        lootGeValue: 2855700,
        lootCount: 2,
        kcGainedByBoss: { Vorkath: 3, Zulrah: 3 },
      },
    });
    // DEFENCE went down (odd data): no gain. NEWSKILL is unknown: listed after SKILLS.
    expect(detail.xp).toEqual([
      { skill: 'ATTACK', xpGained: 500, startLevel: 9, endLevel: 10 },
      { skill: 'NEWSKILL', xpGained: 200, startLevel: 1, endLevel: 1 },
    ]);
    // Vorkath: last KC before (10, session P) → highest (13). Zulrah is new: 1 → 4.
    expect(detail.kc).toEqual([
      { boss: 'Vorkath', startKillCount: 10, endKillCount: 13, gained: 3 },
      { boss: 'Zulrah', startKillCount: 1, endKillCount: 4, gained: 3 },
    ]);
    expect(detail.loot.every((loot) => loot.id > 0)).toBe(true);
    expect(detail.loot.map((loot) => ({ ...loot, id: 0 }))).toEqual([
      {
        id: 0,
        occurredAt: at('18:10'),
        source: { type: 'NPC', name: 'Vorkath' },
        killCount: 11,
        // 2,850,000 + 2 × 2,100
        geValue: 2854200,
        haValue: 60000,
        items: [
          {
            itemId: 11286,
            name: 'Draconic visage',
            quantity: 1,
            gePriceEach: 2850000,
            haPriceEach: 60000,
          },
          { itemId: 536, name: 'Dragon bones', quantity: 2, gePriceEach: 2100, haPriceEach: 0 },
        ],
      },
      {
        id: 0,
        occurredAt: at('18:50'),
        source: { type: 'PLAYER', name: null },
        killCount: null,
        geValue: 1500,
        haValue: 0,
        items: [{ itemId: 995, name: 'Coins', quantity: 1500, gePriceEach: 1, haPriceEach: 0 }],
      },
    ]);
  });

  it('accepts an upper-case session ID', async () => {
    start(detailEvents);
    const detail = await get(
      `/api/v1/sessions/${D.sessionId.toUpperCase()}`,
      sessionDetailResponseSchema,
    );
    expect(detail.session.id).toBe(D.sessionId);
  });

  it('handles an account without session.start and a session without world', async () => {
    start(detailEvents);
    const c = accountIdOf(HASH_C);
    const list = await get(`/api/v1/accounts/${String(c)}/sessions`, sessionsResponseSchema);
    // Start falls back to the AFK period's start; no heartbeat, so it timed out there.
    expect(list.items).toEqual([
      {
        id: N.sessionId,
        accountId: c,
        startedAt: '2026-11-07T10:00:00.000Z',
        endedAt: '2026-11-07T10:00:00.000Z',
        endReason: 'timeout',
        world: null,
        durationSeconds: 0,
        activeSeconds: 0,
        afkSeconds: 0,
        summary: {
          xpGainedTotal: 0,
          xpGainedBySkill: {},
          lootGeValue: 0,
          lootCount: 0,
          kcGainedByBoss: {},
        },
        newCollectionLogCount: 0,
      },
    ]);
    const detail = await get(`/api/v1/sessions/${N.sessionId}`, sessionDetailResponseSchema);
    expect(detail).toEqual({
      session: list.items[0],
      neighbors: { olderId: null, newerId: null },
      xp: [],
      loot: [],
      kc: [],
      afkPeriods: [],
      collectionLog: { obtained: null, total: null, items: [] },
    });
  });

  it('gives 404 for an unknown session and 400 for a bad ID or query', async () => {
    start(detailEvents);
    expect((await getError(`/api/v1/sessions/${sessionIdOf(99)}`, 404)).code).toBe('NOT_FOUND');
    expect((await getError('/api/v1/sessions/abc', 400)).details).toEqual([
      expect.objectContaining({ path: 'params.sessionId' }),
    ]);
    // A UUIDv4 is not a session ID.
    await getError('/api/v1/sessions/9b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d', 400);
    await getError(`/api/v1/sessions/${D.sessionId}?limit=1`, 400);
  });
});

// --- Calendar -----------------------------------------------------------------

describe('GET /accounts/:accountId/calendar', () => {
  const f = eventFactory();
  const A = (n: number) => ({ accountHash: HASH_A, sessionId: sessionIdOf(n) });
  const B = { accountHash: HASH_B, sessionId: sessionIdOf(30) };
  const heartbeats = (
    times: readonly string[],
    options: { accountHash: string; sessionId: string },
  ) => times.map((time) => f.heartbeat(time, options));
  const calendarEvents = [
    // Across midnight (UTC+1): 23:58, 23:59 on Nov 7 and 00:00, 00:01 on Nov 8, local.
    // AFK 22:59–23:00 UTC: the 22:59 heartbeat is AFK (start inclusive),
    // the 23:00 one active (end exclusive).
    f.sessionStart('2026-11-07T22:57:00.000Z', A(20)),
    ...heartbeats(
      [
        '2026-11-07T22:58:00.000Z',
        '2026-11-07T22:59:00.000Z',
        '2026-11-07T23:00:00.000Z',
        '2026-11-07T23:01:00.000Z',
      ],
      A(20),
    ),
    f.afk('2026-11-07T22:59:00.000Z', '2026-11-07T23:00:00.000Z', A(20)),
    f.sessionEnd('2026-11-07T23:02:00.000Z', A(20)),
    // Account B plays on Nov 8 too: 3 heartbeats. Its AFK period covers A's
    // 22:58 heartbeat, but only a period of the same session counts.
    f.sessionStart('2026-11-08T10:00:00.000Z', B),
    f.afk('2026-11-07T22:58:00.000Z', '2026-11-07T22:59:00.000Z', B),
    ...heartbeats(
      ['2026-11-08T10:01:00.000Z', '2026-11-08T10:02:00.000Z', '2026-11-08T10:03:00.000Z'],
      B,
    ),
    f.sessionEnd('2026-11-08T10:04:00.000Z', B),

    // Autumn DST: Oct 25 local is 25 hours, [Oct 24 22:00Z, Oct 25 23:00Z).
    // 21:59Z = Oct 24 23:59 local; 22:00Z = Oct 25 00:00; 00:30Z = 02:30 CEST;
    // 01:30Z = 02:30 CET (the repeated hour); 22:59Z = 23:59; 23:00Z = Oct 26 00:00.
    f.sessionStart('2026-10-24T21:58:00.000Z', A(21)),
    ...heartbeats(
      [
        '2026-10-24T21:59:00.000Z',
        '2026-10-24T22:00:00.000Z',
        '2026-10-25T00:30:00.000Z',
        '2026-10-25T01:30:00.000Z',
        '2026-10-25T22:59:00.000Z',
        '2026-10-25T23:00:00.000Z',
      ],
      A(21),
    ),
    f.sessionEnd('2026-10-25T23:01:00.000Z', A(21)),

    // Spring DST: Mar 29 local is 23 hours, [Mar 28 23:00Z, Mar 29 22:00Z).
    // 22:59Z = Mar 28 23:59; 23:00Z = Mar 29 00:00; 00:59Z = 01:59 CET;
    // 01:00Z = 03:00 CEST; 21:59Z = 23:59; 22:00Z = Mar 30 00:00.
    f.sessionStart('2026-03-28T22:58:00.000Z', A(22)),
    ...heartbeats(
      [
        '2026-03-28T22:59:00.000Z',
        '2026-03-28T23:00:00.000Z',
        '2026-03-29T00:59:00.000Z',
        '2026-03-29T01:00:00.000Z',
        '2026-03-29T21:59:00.000Z',
        '2026-03-29T22:00:00.000Z',
      ],
      A(22),
    ),
    f.sessionEnd('2026-03-29T22:01:00.000Z', A(22)),

    // New year: 22:59Z = Dec 31 23:59 local, 23:00Z = Jan 1 2027 00:00.
    f.sessionStart('2026-12-31T22:58:00.000Z', A(23)),
    ...heartbeats(['2026-12-31T22:59:00.000Z', '2026-12-31T23:00:00.000Z'], A(23)),
    f.sessionEnd('2026-12-31T23:01:00.000Z', A(23)),
  ];
  const day = (date: string, active: number, afk: number, sessionCount = 1) => ({
    date,
    playedSeconds: (active + afk) * 60,
    activeSeconds: active * 60,
    afkSeconds: afk * 60,
    sessionCount,
  });

  it('splits sessions across midnight and DST changes by local day', async () => {
    start(calendarEvents);
    const a = accountIdOf(HASH_A);
    const calendar = await get(
      `/api/v1/accounts/${String(a)}/calendar?year=2026`,
      calendarResponseSchema,
    );
    expect(calendar).toEqual({
      year: 2026,
      // The local year in UTC (CET, UTC+1).
      from: '2025-12-31T23:00:00.000Z',
      to: '2026-12-31T23:00:00.000Z',
      days: [
        day('2026-03-28', 1, 0),
        // 23 hours: 00:00, 01:59 CET, 03:00 CEST, 23:59.
        day('2026-03-29', 4, 0),
        day('2026-03-30', 1, 0),
        day('2026-10-24', 1, 0),
        // 25 hours: 00:00, 02:30 CEST, 02:30 CET, 23:59.
        day('2026-10-25', 4, 0),
        day('2026-10-26', 1, 0),
        // 23:58 active, 23:59 AFK.
        day('2026-11-07', 1, 1),
        day('2026-11-08', 2, 0),
        day('2026-12-31', 1, 0),
      ],
    });
  });

  it('defaults to the current local year and splits a session across new year', async () => {
    // 2026-12-31T23:30Z is already 2027 in Oslo.
    start(calendarEvents, { now: new Date('2026-12-31T23:30:00.000Z') });
    const a = accountIdOf(HASH_A);
    expect(await get(`/api/v1/accounts/${String(a)}/calendar`, calendarResponseSchema)).toEqual({
      year: 2027,
      from: '2026-12-31T23:00:00.000Z',
      to: '2027-12-31T23:00:00.000Z',
      days: [day('2027-01-01', 1, 0)],
    });
    expect(
      await get(`/api/v1/accounts/${String(a)}/calendar?year=2025`, calendarResponseSchema),
    ).toEqual({
      year: 2025,
      from: '2024-12-31T23:00:00.000Z',
      to: '2025-12-31T23:00:00.000Z',
      days: [],
    });
  });

  it('sums all accounts and counts sessions per day', async () => {
    start(calendarEvents);
    const b = accountIdOf(HASH_B);
    expect(
      (await get(`/api/v1/accounts/${String(b)}/calendar?year=2026`, calendarResponseSchema)).days,
    ).toEqual([day('2026-11-08', 3, 0)]);
    const all = await get('/api/v1/accounts/all/calendar?year=2026', calendarResponseSchema);
    // Nov 8: A's 2 minutes after midnight and B's 3, two sessions.
    expect(all.days.find((d) => d.date === '2026-11-08')).toEqual(day('2026-11-08', 5, 0, 2));
    expect(all.days).toHaveLength(9);
  });

  it('rejects bad queries and unknown accounts', async () => {
    start(calendarEvents);
    for (const query of ['year=1999', 'year=10000', 'year=abc', 'year=02026', 'year=', 'x=1']) {
      expect((await getError(`/api/v1/accounts/all/calendar?${query}`, 400)).code).toBe(
        'VALIDATION_ERROR',
      );
    }
    expect((await getError('/api/v1/accounts/999/calendar', 404)).code).toBe('NOT_FOUND');
  });

  describe('with from/to', () => {
    const url = (account: string | number, from: string, to: string) =>
      `/api/v1/accounts/${String(account)}/calendar?from=${from}&to=${to}`;

    it('spans a year boundary, grouped by local day', async () => {
      start(calendarEvents);
      const a = accountIdOf(HASH_A);
      const from = '2026-12-01T00:00:00.000Z';
      const to = '2027-01-15T00:00:00.000Z';
      expect(await get(url(a, from, to), calendarResponseSchema)).toEqual({
        year: null,
        from,
        to,
        // 22:59Z is Dec 31 local, 23:00Z Jan 1.
        days: [day('2026-12-31', 1, 0), day('2027-01-01', 1, 0)],
      });
    });

    it('splits a DST day and counts only heartbeats inside a partial edge day', async () => {
      start(calendarEvents);
      const a = accountIdOf(HASH_A);
      // 00:00Z = Oct 25 02:00 CEST, so 22:00Z (local midnight) is left out.
      // `to` is exclusive: the 23:00Z heartbeat (Oct 26 local) is left out.
      const from = '2026-10-25T00:00:00.000Z';
      const to = '2026-10-25T23:00:00.000Z';
      expect((await get(url(a, from, to), calendarResponseSchema)).days).toEqual([
        // 02:30 CEST, 02:30 CET, 23:59.
        day('2026-10-25', 3, 0),
      ]);
      // Spring: the whole 23-hour day in one range, and the day after.
      expect(
        (
          await get(
            url(a, '2026-03-28T23:00:00.000Z', '2026-03-30T22:00:00.000Z'),
            calendarResponseSchema,
          )
        ).days,
      ).toEqual([day('2026-03-29', 4, 0), day('2026-03-30', 1, 0)]);
    });

    it('gives each account and the sum for `all`', async () => {
      start(calendarEvents);
      const from = '2026-11-07T00:00:00.000Z';
      const to = '2026-11-09T00:00:00.000Z';
      expect((await get(url(accountIdOf(HASH_A), from, to), calendarResponseSchema)).days).toEqual([
        day('2026-11-07', 1, 1),
        day('2026-11-08', 2, 0),
      ]);
      expect((await get(url(accountIdOf(HASH_B), from, to), calendarResponseSchema)).days).toEqual([
        day('2026-11-08', 3, 0),
      ]);
      expect((await get(url('all', from, to), calendarResponseSchema)).days).toEqual([
        day('2026-11-07', 1, 1),
        day('2026-11-08', 5, 0, 2),
      ]);
    });

    it('matches the two year calls for a rolling year', async () => {
      start(calendarEvents);
      // Local midnight Mar 30 2026 (CEST) to local midnight Mar 30 2027 (CEST): 365 days.
      const from = '2026-03-29T22:00:00.000Z';
      const to = '2027-03-29T22:00:00.000Z';
      const rolling = await get(url('all', from, to), calendarResponseSchema);
      const years = [
        ...(await get('/api/v1/accounts/all/calendar?year=2026', calendarResponseSchema)).days,
        ...(await get('/api/v1/accounts/all/calendar?year=2027', calendarResponseSchema)).days,
      ].filter((d) => d.date >= '2026-03-30' && d.date < '2027-03-30');
      expect(rolling.days).toEqual(years);
      expect(rolling.days.map((d) => d.date)).toContain('2027-01-01');
    });

    it.each([
      [
        'a range over 366 days',
        'from=2025-11-10T23:00:00.000Z&to=2026-11-11T23:00:00.001Z',
        'query.to',
      ],
      ['to equal to from', 'from=2026-11-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z', 'query.to'],
      ['to before from', 'from=2026-11-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z', 'query.to'],
      ['only from', 'from=2026-11-01T00:00:00.000Z', 'query.to'],
      ['only to', 'to=2026-11-01T00:00:00.000Z', 'query.from'],
      [
        'year with from/to',
        'year=2026&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z',
        'query.year',
      ],
      [
        'from without milliseconds',
        'from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00.000Z',
        'query.from',
      ],
    ])('rejects %s', async (_name, query, path) => {
      start(calendarEvents);
      const error = await getError(`/api/v1/accounts/all/calendar?${query}`, 400);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details.map((d) => d.path)).toContain(path);
    });

    it('accepts exactly 366 days', async () => {
      start(calendarEvents);
      const from = '2025-11-10T23:00:00.000Z';
      const to = '2026-11-11T23:00:00.000Z';
      // Every day of 2026 up to Nov 8; Dec 31 is after `to`.
      const days = (await get(url('all', from, to), calendarResponseSchema)).days;
      expect(days.map((d) => d.date)).toEqual([
        '2026-03-28',
        '2026-03-29',
        '2026-03-30',
        '2026-10-24',
        '2026-10-25',
        '2026-10-26',
        '2026-11-07',
        '2026-11-08',
      ]);
    });
  });
});
