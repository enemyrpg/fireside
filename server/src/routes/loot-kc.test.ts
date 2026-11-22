import {
  dropsResponseSchema,
  errorResponseSchema,
  kcResponseSchema,
  lootResponseSchema,
  type Drop,
  type Event,
  type LootItem,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { accounts, kcObservations } from '../db/schema.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  type TestRun,
} from '../projections/testing.js';
import { rebuildProjections } from '../projections/framework.js';
import { PROJECTIONS } from '../projections/index.js';
import { testConfig } from '../test-utils.js';

// Loot, drops and KC. Small hand-built data in Europe/Oslo; every expected
// number is worked out by hand in the comments.

const TZ = 'Europe/Oslo';
const HASH_A = '1111111111';
const HASH_B = '2222222222';
const HASH_C = '3333333333';
const A = { accountHash: HASH_A, sessionId: sessionIdOf(1) };
const B = { accountHash: HASH_B, sessionId: sessionIdOf(2) };
const C = { accountHash: HASH_C, sessionId: sessionIdOf(3) };

let app: FastifyInstance | undefined;
let run: TestRun | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function start(events: readonly Event[]): FastifyInstance {
  run = emptyRun();
  ingestBatch(run, events);
  expect(run.failed).toEqual([]);
  app = buildApp({
    db: run.database,
    config: testConfig({ TZ }),
    dashboard: { now: () => new Date('2026-11-10T12:00:00.000Z') },
  });
  return app;
}

async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
  expect(response.statusCode, response.body).toBe(200);
  return schema.parse(response.json());
}

async function getError(url: string) {
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
  return { status: response.statusCode, body: errorResponseSchema.parse(response.json()) };
}

/** Account ID for a hash, as a path string (the API never shows hashes). */
function idOf(hash: string): string {
  return String(
    run?.database.db.select().from(accounts).where(eq(accounts.accountHash, hash)).get()?.id ?? 0,
  );
}

function item(itemId: number, quantity: number, gePrice: number, haPrice = 0, name?: string) {
  return { itemId, name: name ?? `Item ${String(itemId)}`, quantity, gePrice, haPrice };
}

const coins = (quantity: number): LootItem[] => [
  { itemId: 995, name: 'Coins', quantity, gePrice: 1, haPrice: 0 },
];

// --- Loot ---------------------------------------------------------------------

/**
 * Account A (with session.start) and B (loot only, no session.start).
 * Oslo is UTC+1 in November; 25 Oct 2026 is the 25-hour DST day
 * [2026-10-24T22:00Z, 2026-10-25T23:00Z).
 */
function lootEvents(): Event[] {
  const f = eventFactory();
  const barrows = { type: 'EVENT', name: 'Barrows' } as const;
  return [
    f.sessionStart('2026-10-24T20:00:00.000Z', A),
    // 25 Oct local: first and last millisecond of the 25-hour day.
    f.loot('2026-10-24T22:00:00.000Z', { source: barrows, items: coins(100), ...A }),
    f.loot('2026-10-25T22:59:59.999Z', { source: barrows, items: coins(200), ...A }),
    // 22:30Z on 8 Nov is 23:30 local (8 Nov); 23:30Z is 00:30 local (9 Nov).
    // GE 2 850 000 + 2 × 2 100 = 2 854 200; HA 60 000.
    f.loot('2026-11-08T22:30:00.000Z', {
      items: [
        item(11286, 1, 2_850_000, 60_000, 'Draconic visage'),
        item(536, 2, 2100, 0, 'Dragon bones'),
      ],
      ...A,
    }),
    // Same item, new price and name: 3 × 2 000 = 6 000.
    f.loot('2026-11-08T23:30:00.000Z', {
      items: [item(536, 3, 2000, 0, 'Dragon bones (new)')],
      ...A,
    }),
    // PLAYER loot (no name) and an OTHER source named "Player": two groups.
    f.loot('2026-11-09T10:00:00.000Z', {
      source: { type: 'PLAYER', name: null },
      items: coins(1500),
      ...A,
    }),
    f.loot('2026-11-09T11:00:00.000Z', {
      source: { type: 'OTHER', name: 'Player' },
      items: coins(1500),
      ...A,
    }),
    f.loot('2026-11-09T10:00:00.000Z', { items: coins(500), ...B }),
  ];
}

describe('GET /accounts/:accountId/loot', () => {
  it('groups by source, with PLAYER loot as its own group without a name', async () => {
    start(lootEvents());
    const loot = await get(`/api/v1/accounts/${idOf(HASH_A)}/loot`, lootResponseSchema);
    expect(loot).toEqual({
      groupBy: 'source',
      from: null,
      to: null,
      // 6 events; GE 2 860 200 + 1 500 + 1 500 + 300 = 2 863 500.
      totals: { lootCount: 6, geValue: 2_863_500, haValue: 60_000 },
      groups: [
        {
          source: { type: 'NPC', name: 'Vorkath' },
          lootCount: 2,
          // 2 854 200 + 6 000
          geValue: 2_860_200,
          haValue: 60_000,
          items: [
            {
              itemId: 11286,
              name: 'Draconic visage',
              quantity: 1,
              geValue: 2_850_000,
              haValue: 60_000,
            },
            // 2 + 3 bones, 4 200 + 6 000. Name from the newest drop.
            { itemId: 536, name: 'Dragon bones (new)', quantity: 5, geValue: 10_200, haValue: 0 },
          ],
        },
        // Same value: ordered by type, OTHER before PLAYER.
        {
          source: { type: 'OTHER', name: 'Player' },
          lootCount: 1,
          geValue: 1500,
          haValue: 0,
          items: [{ itemId: 995, name: 'Coins', quantity: 1500, geValue: 1500, haValue: 0 }],
        },
        {
          source: { type: 'PLAYER', name: null },
          lootCount: 1,
          geValue: 1500,
          haValue: 0,
          items: [{ itemId: 995, name: 'Coins', quantity: 1500, geValue: 1500, haValue: 0 }],
        },
        {
          source: { type: 'EVENT', name: 'Barrows' },
          lootCount: 2,
          geValue: 300,
          haValue: 0,
          items: [{ itemId: 995, name: 'Coins', quantity: 300, geValue: 300, haValue: 0 }],
        },
      ],
    });
  });

  it('groups by local day in TZ, across the DST change, without empty days', async () => {
    start(lootEvents());
    const loot = await get(`/api/v1/accounts/${idOf(HASH_A)}/loot?groupBy=day`, lootResponseSchema);
    expect(loot).toEqual({
      groupBy: 'day',
      from: null,
      to: null,
      totals: { lootCount: 6, geValue: 2_863_500, haValue: 60_000 },
      groups: [
        // Both ends of the 25-hour day.
        { date: '2026-10-25', lootCount: 2, geValue: 300, haValue: 0 },
        // 22:30Z on 8 Nov.
        { date: '2026-11-08', lootCount: 1, geValue: 2_854_200, haValue: 60_000 },
        // 23:30Z on 8 Nov (00:30 local), PLAYER and OTHER: 6 000 + 1 500 + 1 500.
        { date: '2026-11-09', lootCount: 3, geValue: 9000, haValue: 0 },
      ],
    });
  });

  it('sums all accounts for `all`, including an account without session.start', async () => {
    start(lootEvents());
    const byDay = await get('/api/v1/accounts/all/loot?groupBy=day', lootResponseSchema);
    // B adds 500 on 9 Nov.
    expect(byDay.totals).toEqual({ lootCount: 7, geValue: 2_864_000, haValue: 60_000 });
    expect(byDay.groups.at(-1)).toEqual({
      date: '2026-11-09',
      lootCount: 4,
      geValue: 9500,
      haValue: 0,
    });

    const bySource = await get('/api/v1/accounts/all/loot', lootResponseSchema);
    expect(bySource.totals).toEqual(byDay.totals);
    expect(bySource.groupBy === 'source' && bySource.groups[0]).toMatchObject({
      source: { type: 'NPC', name: 'Vorkath' },
      lootCount: 3,
      geValue: 2_860_700,
    });

    const onlyB = await get(`/api/v1/accounts/${idOf(HASH_B)}/loot`, lootResponseSchema);
    expect(onlyB.totals).toEqual({ lootCount: 1, geValue: 500, haValue: 0 });
  });

  it('uses the half-open range [from, to), with either end open', async () => {
    start(lootEvents());
    const id = idOf(HASH_A);
    // From exactly the 00:30-local drop (included) to exactly the OTHER drop (excluded).
    const range = 'from=2026-11-08T23:30:00.000Z&to=2026-11-09T11:00:00.000Z';
    const ranged = await get(`/api/v1/accounts/${id}/loot?${range}`, lootResponseSchema);
    expect(ranged).toMatchObject({
      from: '2026-11-08T23:30:00.000Z',
      to: '2026-11-09T11:00:00.000Z',
      // 6 000 + PLAYER 1 500.
      totals: { lootCount: 2, geValue: 7500, haValue: 0 },
    });

    const onlyFrom = await get(
      `/api/v1/accounts/${id}/loot?groupBy=day&from=2026-11-09T00:00:00.000Z`,
      lootResponseSchema,
    );
    expect(onlyFrom).toMatchObject({
      from: '2026-11-09T00:00:00.000Z',
      to: null,
      totals: { lootCount: 2, geValue: 3000, haValue: 0 },
    });

    const onlyTo = await get(
      `/api/v1/accounts/${id}/loot?to=2026-10-26T00:00:00.000Z`,
      lootResponseSchema,
    );
    expect(onlyTo).toMatchObject({ from: null, totals: { lootCount: 2, geValue: 300 } });

    const empty = await get(
      `/api/v1/accounts/${id}/loot?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z`,
      lootResponseSchema,
    );
    expect(empty).toMatchObject({ totals: { lootCount: 0, geValue: 0, haValue: 0 }, groups: [] });
  });

  it('rejects bad queries and unknown accounts', async () => {
    start(lootEvents());
    const id = idOf(HASH_A);
    for (const query of [
      'groupBy=week',
      'foo=1',
      'from=2026-11-09T00:00:00.000Z&to=2026-11-09T00:00:00.000Z',
      'from=2026-11-09',
    ]) {
      const { status, body } = await getError(`/api/v1/accounts/${id}/loot?${query}`);
      expect(status, query).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await getError('/api/v1/accounts/999/loot')).status).toBe(404);
    expect((await getError('/api/v1/accounts/01/loot')).status).toBe(400);
  });
});

// --- Drops --------------------------------------------------------------------

/**
 * Event IDs grow in the order made here. Newest first is: d4 (20:00), then
 * at 19:00.000 d2 (higher event ID) before d1, then d3 (18:00). Items keep
 * payload order. Item IDs in full order: 7, 4, 5, 1, 2, 3, 6.
 */
function dropEvents(): Event[] {
  const f = eventFactory();
  return [
    f.sessionStart('17:00', A),
    // d1: 100, 2 × 100 = 200 (HA 2 × 7 = 14), 300.
    f.loot('19:00', { items: [item(1, 1, 100), item(2, 2, 100, 7), item(3, 1, 300)], ...A }),
    // d2: same millisecond, account B.
    f.loot('19:00', { items: [item(4, 1, 50), item(5, 1, 1000)], ...B }),
    // d3
    f.loot('18:00', { items: [item(6, 1, 1000)], ...A }),
    // d4: PLAYER loot.
    f.loot('20:00', { source: { type: 'PLAYER', name: null }, items: [item(7, 1, 999)], ...A }),
  ];
}

async function allPages(url: string, limit: number): Promise<{ drops: Drop[]; pages: number }> {
  const drops: Drop[] = [];
  let pages = 0;
  let cursor: string | null = null;
  do {
    const separator = url.includes('?') ? '&' : '?';
    const page: z.infer<typeof dropsResponseSchema> = await get(
      `${url}${separator}limit=${String(limit)}${cursor ? `&cursor=${cursor}` : ''}`,
      dropsResponseSchema,
    );
    drops.push(...page.items);
    pages += 1;
    cursor = page.nextCursor;
    expect(pages).toBeLessThan(20);
  } while (cursor !== null);
  return { drops, pages };
}

const itemIds = (drops: readonly Drop[]) => drops.map((drop) => drop.itemId);

describe('GET /accounts/:accountId/loot/drops', () => {
  it('lists one row per item, newest event first and items in payload order', async () => {
    start(dropEvents());
    const page = await get('/api/v1/accounts/all/loot/drops', dropsResponseSchema);
    expect(itemIds(page.items)).toEqual([7, 4, 5, 1, 2, 3, 6]);
    expect(page.nextCursor).toBeNull();

    expect(page.items[0]).toMatchObject({
      accountId: Number(idOf(HASH_A)),
      sessionId: sessionIdOf(1),
      occurredAt: '2026-11-08T20:00:00.000Z',
      source: { type: 'PLAYER', name: null },
    });
    expect(page.items[1]).toMatchObject({ accountId: Number(idOf(HASH_B)) });
    expect(page.items[4]).toEqual({
      lootEventId: page.items[3]?.lootEventId,
      accountId: Number(idOf(HASH_A)),
      sessionId: sessionIdOf(1),
      occurredAt: '2026-11-08T19:00:00.000Z',
      source: { type: 'NPC', name: 'Vorkath' },
      itemId: 2,
      name: 'Item 2',
      quantity: 2,
      gePriceEach: 100,
      haPriceEach: 7,
      geValue: 200,
      haValue: 14,
    });

    const onlyA = await get(`/api/v1/accounts/${idOf(HASH_A)}/loot/drops`, dropsResponseSchema);
    expect(itemIds(onlyA.items)).toEqual([7, 1, 2, 3, 6]);
  });

  it('filters on geValue >= minValue (inclusive)', async () => {
    start(dropEvents());
    const atLimit = await get('/api/v1/accounts/all/loot/drops?minValue=1000', dropsResponseSchema);
    expect(itemIds(atLimit.items)).toEqual([5, 6]);
    const below = await get('/api/v1/accounts/all/loot/drops?minValue=999', dropsResponseSchema);
    expect(itemIds(below.items)).toEqual([7, 5, 6]);
    // 2 × 100 = 200 counts, not the price each.
    const value = await get('/api/v1/accounts/all/loot/drops?minValue=200', dropsResponseSchema);
    expect(itemIds(value.items)).toEqual([7, 5, 2, 3, 6]);
  });

  it('pages without gaps or duplicates for every page size', async () => {
    start(dropEvents());
    for (const limit of [1, 2, 3, 4, 6, 7, 8]) {
      const all = await allPages('/api/v1/accounts/all/loot/drops', limit);
      expect(itemIds(all.drops), `limit ${String(limit)}`).toEqual([7, 4, 5, 1, 2, 3, 6]);
      expect(all.pages).toBe(Math.max(1, Math.ceil(7 / limit)));

      const filtered = await allPages('/api/v1/accounts/all/loot/drops?minValue=200', limit);
      expect(itemIds(filtered.drops)).toEqual([7, 5, 2, 3, 6]);

      const ranged = await allPages(
        `/api/v1/accounts/${idOf(HASH_A)}/loot/drops?from=2026-11-08T18:00:00.000Z&to=2026-11-08T20:00:00.000Z`,
        limit,
      );
      expect(itemIds(ranged.drops)).toEqual([1, 2, 3, 6]);
    }
  });

  it('keeps a cursor valid after a rebuild', async () => {
    start(dropEvents());
    const first = await get('/api/v1/accounts/all/loot/drops?limit=4', dropsResponseSchema);
    expect(itemIds(first.items)).toEqual([7, 4, 5, 1]);
    const db = run?.database.db;
    if (!db) throw new Error('start() sets run');
    const rebuilt = rebuildProjections(db, {
      projections: PROJECTIONS,
      now: () => new Date('2026-11-10T12:00:00.000Z'),
    });
    expect(rebuilt.failed).toEqual([]);
    const next = await get(
      `/api/v1/accounts/all/loot/drops?limit=4&cursor=${String(first.nextCursor)}`,
      dropsResponseSchema,
    );
    expect(itemIds(next.items)).toEqual([2, 3, 6]);
  });

  it('rejects bad cursors and queries', async () => {
    start(dropEvents());
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const badCursors = [
      'abc',
      '!!!',
      encode([1, 2, 3]),
      encode(['2026-11-08T19:00:00.000Z', '01933c4e-8a2b-7c3d-9e4f-000000000002', -1]),
      encode(['2026-11-08T19:00:00Z', '01933c4e-8a2b-7c3d-9e4f-000000000002', 0]),
      encode(['2026-11-08T19:00:00.000Z', 'not-a-uuid', 0]),
    ];
    for (const cursor of badCursors) {
      const { status, body } = await getError(`/api/v1/accounts/all/loot/drops?cursor=${cursor}`);
      expect(status, cursor).toBe(400);
      expect(body.error.details).toEqual([{ path: 'query.cursor', message: 'Invalid cursor' }]);
    }
    for (const query of ['limit=0', 'limit=101', 'minValue=-1', 'minValue=1.5', 'groupBy=day']) {
      expect((await getError(`/api/v1/accounts/all/loot/drops?${query}`)).status, query).toBe(400);
    }
    expect((await getError('/api/v1/accounts/999/loot/drops')).status).toBe(404);
  });
});

// --- KC -----------------------------------------------------------------------

/** KC fields of a boss that is not a raid mode, without team sizes. */
const NOT_A_RAID = { category: 'boss', raid: null, bestTimesByTeamSize: [] } as const;

function kcEvents(): Event[] {
  const f = eventFactory();
  return [
    f.sessionStart('17:00', A),
    f.sessionStart('17:00', C),
    f.kc('19:00', { boss: 'Vorkath', killCount: 10, timeSeconds: 80, ...A }),
    f.kc('20:00', { boss: 'vorkath ', killCount: 12, timeSeconds: 75, ...A }),
    // Made last (highest event ID) but observed earlier: not the latest. Its time is the best.
    f.kc('19:30', { boss: 'Vorkath', killCount: 11, timeSeconds: 70, ...A }),
    // Same millisecond: the higher event ID (6) is the latest.
    f.kc('21:00', { boss: 'Zulrah', killCount: 5, ...A }),
    f.kc('21:00', { boss: 'Zulrah', killCount: 6, ...A }),
    // KC from loot: Dusk is an alias of Grotesque Guardians.
    f.loot('18:00', { source: { type: 'NPC', name: 'Dusk' }, killCount: 50, ...A }),
    // PLAYER loot with killCount never gives KC.
    f.loot('18:30', { source: { type: 'PLAYER', name: null }, killCount: 3, ...A }),
    f.kc('22:00', { boss: 'Vorkath', killCount: 3, timeSeconds: 90, ...B }),
  ];
}

describe('GET /accounts/:accountId/kc', () => {
  it('gives the latest observation per normalized boss, and the best time', async () => {
    // Reverse ingest order: the result depends on (observed_at, event_id) only.
    start(kcEvents().reverse());
    const kc = await get(`/api/v1/accounts/${idOf(HASH_A)}/kc`, kcResponseSchema);
    const a = Number(idOf(HASH_A));
    // All in the 30-day window, none before it: gained = highest − first.
    expect(kc).toEqual({
      bosses: [
        {
          boss: 'Grotesque Guardians',
          killCount: 50,
          lastObservedAt: '2026-11-08T18:00:00.000Z',
          bestTimeSeconds: null,
          gainedLast30Days: 0,
          byAccount: [{ accountId: a, killCount: 50 }],
          ...NOT_A_RAID,
        },
        {
          boss: 'Vorkath',
          killCount: 12,
          lastObservedAt: '2026-11-08T20:00:00.000Z',
          bestTimeSeconds: 70,
          // 12 − 10
          gainedLast30Days: 2,
          byAccount: [{ accountId: a, killCount: 12 }],
          ...NOT_A_RAID,
        },
        {
          boss: 'Zulrah',
          killCount: 6,
          lastObservedAt: '2026-11-08T21:00:00.000Z',
          bestTimeSeconds: null,
          // Same millisecond: 5 (lower event ID) is first, so 6 − 5.
          gainedLast30Days: 1,
          byAccount: [{ accountId: a, killCount: 6 }],
          ...NOT_A_RAID,
        },
      ],
    });
  });

  it('sums the latest KC of each account for `all`', async () => {
    start(kcEvents());
    const kc = await get('/api/v1/accounts/all/kc', kcResponseSchema);
    expect(kc.bosses.find((boss) => boss.boss === 'Vorkath')).toEqual({
      boss: 'Vorkath',
      // A 12 + B 3; newest observation is B's; best time over both.
      killCount: 15,
      lastObservedAt: '2026-11-08T22:00:00.000Z',
      bestTimeSeconds: 70,
      // A 12 − 10, B 3 − 3.
      gainedLast30Days: 2,
      byAccount: [
        { accountId: Number(idOf(HASH_A)), killCount: 12 },
        { accountId: Number(idOf(HASH_B)), killCount: 3 },
      ],
      ...NOT_A_RAID,
    });
    expect(kc.bosses.map((boss) => boss.boss)).toEqual([
      'Grotesque Guardians',
      'Vorkath',
      'Zulrah',
    ]);
  });

  it('gives an empty list without KC, and rejects bad requests', async () => {
    start(kcEvents());
    expect(await get(`/api/v1/accounts/${idOf(HASH_C)}/kc`, kcResponseSchema)).toEqual({
      bosses: [],
    });
    expect((await getError('/api/v1/accounts/999/kc')).status).toBe(404);
    expect((await getError('/api/v1/accounts/all/kc?boss=Vorkath')).status).toBe(400);
  });
});

describe('GET /accounts/:accountId/kc: raids', () => {
  const f = eventFactory();
  const toa = 'Tombs of Amascut: Expert Mode';
  const events = [
    f.kc('19:00', { boss: toa, killCount: 10, timeSeconds: 1900, teamSize: 3, ...A }),
    f.kc('19:40', { boss: toa, killCount: 11, timeSeconds: 1800, teamSize: 3, ...A }),
    f.kc('20:20', {
      boss: 'Tombs of Amascut Expert Mode',
      killCount: 12,
      timeSeconds: 2400,
      teamSize: 1,
      ...A,
    }),
    // No time: not a best time for its team size.
    f.kc('21:00', { boss: toa, killCount: 13, teamSize: 2, ...A }),
    // No team size: only in bestTimeSeconds.
    f.kc('21:40', { boss: toa, killCount: 14, timeSeconds: 1700, ...A }),
    f.kc('22:00', { boss: toa, killCount: 4, timeSeconds: 1750, teamSize: 3, ...B }),
    f.kc('22:00', { boss: 'Fractured Archive', killCount: 1, ...A }),
  ];

  it('gives category, raid and best time per team size', async () => {
    start(events);
    const kc = await get(`/api/v1/accounts/${idOf(HASH_A)}/kc`, kcResponseSchema);
    expect(kc.bosses.map(({ boss, category, raid }) => ({ boss, category, raid }))).toEqual([
      { boss: 'The Fractured Archive', category: 'raid', raid: 'The Fractured Archive' },
      { boss: toa, category: 'raid', raid: 'Tombs of Amascut' },
    ]);
    expect(kc.bosses[1]).toMatchObject({
      bestTimeSeconds: 1700,
      bestTimesByTeamSize: [
        { teamSize: 1, seconds: 2400 },
        { teamSize: 3, seconds: 1800 },
      ],
    });
    expect(kc.bosses[0]?.bestTimesByTeamSize).toEqual([]);
  });

  it('takes the fastest time per team size over all accounts for `all`', async () => {
    start(events);
    const kc = await get('/api/v1/accounts/all/kc', kcResponseSchema);
    expect(kc.bosses.find((boss) => boss.boss === toa)?.bestTimesByTeamSize).toEqual([
      { teamSize: 1, seconds: 2400 },
      { teamSize: 3, seconds: 1750 },
    ]);
    const b = await get(`/api/v1/accounts/${idOf(HASH_B)}/kc`, kcResponseSchema);
    expect(b.bosses[0]?.bestTimesByTeamSize).toEqual([{ teamSize: 3, seconds: 1750 }]);
  });
});

describe('GET /accounts/:accountId/kc: personalBestSeconds', () => {
  // The game reports the PB in the KC message, also one set before the
  // tracker existed. It counts like a kill time (contract 1.14.0).
  const f = eventFactory();
  const toa = 'Tombs of Amascut: Expert Mode';
  const events = [
    // Zulrah: PB 63 is lower than every kill seen (117, 90).
    f.kc('19:00', {
      boss: 'Zulrah',
      killCount: 10,
      timeSeconds: 117,
      personalBestSeconds: 63,
      ...A,
    }),
    f.kc('19:10', { boss: 'Zulrah', killCount: 11, timeSeconds: 90, ...A }),
    // Vorkath: a kill faster than the reported PB still wins.
    f.kc('19:20', {
      boss: 'Vorkath',
      killCount: 5,
      timeSeconds: 80,
      personalBestSeconds: 75,
      ...A,
    }),
    f.kc('19:30', { boss: 'Vorkath', killCount: 6, timeSeconds: 72, ...A }),
    // Account B: Zulrah PB 58 is lower than all of A's times.
    f.kc('20:00', {
      boss: 'Zulrah',
      killCount: 3,
      timeSeconds: 100,
      personalBestSeconds: 58,
      ...B,
    }),
    // Raids: kills at size 3 (1800, 1900), PB 1500 for size 3.
    f.kc('21:00', { boss: toa, killCount: 10, timeSeconds: 1900, teamSize: 3, ...A }),
    f.kc('21:40', { boss: toa, killCount: 11, timeSeconds: 1800, teamSize: 3, ...A }),
    f.kc('22:20', {
      boss: toa,
      killCount: 12,
      timeSeconds: 1850,
      personalBestSeconds: 1500,
      teamSize: 3,
      ...A,
    }),
    // Size 2: a kill only, untouched by the size-3 PB.
    f.kc('23:00', { boss: toa, killCount: 13, timeSeconds: 2000, teamSize: 2, ...A }),
    // Size 4: a PB without a kill time still gives the size an entry.
    f.kc('23:40', { boss: toa, killCount: 14, personalBestSeconds: 1600, teamSize: 4, ...A }),
    // No team size: a PB only counts in bestTimeSeconds.
    f.kc('23:50', { boss: toa, killCount: 15, personalBestSeconds: 1400, ...A }),
    // Size 3 for B: PB 1450, lower than A's.
    f.kc('23:55', { boss: toa, killCount: 2, personalBestSeconds: 1450, teamSize: 3, ...B }),
  ];

  const bestOf = (kc: z.infer<typeof kcResponseSchema>, boss: string) =>
    kc.bosses.find((entry) => entry.boss === boss);

  it('takes the lowest of kill times and reported PBs for one account', async () => {
    start(events);
    const kc = await get(`/api/v1/accounts/${idOf(HASH_A)}/kc`, kcResponseSchema);
    expect(bestOf(kc, 'Zulrah')?.bestTimeSeconds).toBe(63);
    expect(bestOf(kc, 'Vorkath')?.bestTimeSeconds).toBe(72);
    expect(bestOf(kc, toa)).toMatchObject({
      bestTimeSeconds: 1400,
      bestTimesByTeamSize: [
        { teamSize: 2, seconds: 2000 },
        { teamSize: 3, seconds: 1500 },
        { teamSize: 4, seconds: 1600 },
      ],
    });
  });

  it('takes the lowest over all accounts for `all`', async () => {
    start(events);
    const kc = await get('/api/v1/accounts/all/kc', kcResponseSchema);
    expect(bestOf(kc, 'Zulrah')?.bestTimeSeconds).toBe(58);
    expect(bestOf(kc, toa)).toMatchObject({
      bestTimeSeconds: 1400,
      bestTimesByTeamSize: [
        { teamSize: 2, seconds: 2000 },
        { teamSize: 3, seconds: 1450 },
        { teamSize: 4, seconds: 1600 },
      ],
    });
  });

  it('fills in the column for old rows on rebuild, with the same result', async () => {
    start(events);
    const before = await get('/api/v1/accounts/all/kc', kcResponseSchema);
    const db = run?.database.db;
    if (!db) throw new Error('start() sets run');
    // Rows projected before migration 0009 have no PB.
    db.update(kcObservations).set({ personalBestSeconds: null }).run();
    expect(bestOf(await get('/api/v1/accounts/all/kc', kcResponseSchema), 'Zulrah')).toMatchObject({
      bestTimeSeconds: 90,
    });
    const rebuilt = rebuildProjections(db, {
      projections: PROJECTIONS,
      now: () => new Date('2026-11-10T12:00:00.000Z'),
    });
    expect(rebuilt.failed).toEqual([]);
    const filled = db
      .select({ seconds: kcObservations.personalBestSeconds })
      .from(kcObservations)
      .all()
      .filter((row) => row.seconds !== null);
    expect(filled).toHaveLength(
      events.filter((event) => event.payload.personalBestSeconds !== undefined).length,
    );
    expect(await get('/api/v1/accounts/all/kc', kcResponseSchema)).toEqual(before);
  });
});

describe('GET /accounts/:accountId/kc: pb.records', () => {
  // The records table gives PBs per team size, also for sizes not played
  // since the tracker started (contract 1.17.0). PBs only get faster, so the
  // lowest of kc observations and `overall` records wins.
  const f = eventFactory();
  const tfa = 'The Fractured Archive';
  const record = (teamSize: number, seconds: number, scope = 'overall') => ({
    scope,
    teamSize,
    seconds,
  });
  const events = [
    // A: kills at size 3 (1162.2, PB 1088.4) and size 4 (1100).
    f.kc('19:00', {
      boss: 'Fractured Archive',
      killCount: 135,
      timeSeconds: 1162.2,
      personalBestSeconds: 1088.4,
      teamSize: 3,
      ...A,
    }),
    f.kc('19:30', {
      boss: 'Fractured Archive',
      killCount: 136,
      timeSeconds: 1100,
      teamSize: 4,
      ...A,
    }),
    // A's records: size 3 higher than the kc PB (kc wins), size 4 lower
    // (record wins), size 1 only in the records. A room PB of 60 s and a
    // record without any KC for its boss are not shown.
    f.pbRecords('20:00', {
      records: [record(1, 1905.2), record(3, 1090), record(4, 1050), record(3, 60, 'Ocellus')],
      ...A,
    }),
    f.pbRecords('20:01', { boss: 'Some New Raid', records: [record(2, 500)], ...A }),
    // B: no KC for TFA, only records. Lower than A's for size 3.
    f.kc('20:10', { boss: 'Vorkath', killCount: 1, ...B }),
    f.pbRecords('20:20', { records: [record(3, 1000), record(5, 900)], ...B }),
  ];

  const bossOf = (kc: z.infer<typeof kcResponseSchema>, boss: string) =>
    kc.bosses.find((entry) => entry.boss === boss);

  it('takes the lowest of kc observations and overall records for one account', async () => {
    start(events);
    const kc = await get(`/api/v1/accounts/${idOf(HASH_A)}/kc`, kcResponseSchema);
    expect(kc.bosses.map((entry) => entry.boss)).toEqual([tfa]);
    expect(bossOf(kc, tfa)).toMatchObject({
      killCount: 136,
      bestTimeSeconds: 1050,
      bestTimesByTeamSize: [
        { teamSize: 1, seconds: 1905.2 },
        { teamSize: 3, seconds: 1088.4 },
        { teamSize: 4, seconds: 1050 },
      ],
    });
  });

  it('only lists bosses with a KC, and uses records of accounts in scope', async () => {
    start(events);
    // B has records for TFA but no TFA KC: TFA is not listed for B.
    const b = await get(`/api/v1/accounts/${idOf(HASH_B)}/kc`, kcResponseSchema);
    expect(b.bosses.map((entry) => entry.boss)).toEqual(['Vorkath']);
    const all = await get('/api/v1/accounts/all/kc', kcResponseSchema);
    expect(bossOf(all, tfa)).toMatchObject({
      bestTimeSeconds: 900,
      bestTimesByTeamSize: [
        { teamSize: 1, seconds: 1905.2 },
        { teamSize: 3, seconds: 1000 },
        { teamSize: 4, seconds: 1050 },
        { teamSize: 5, seconds: 900 },
      ],
    });
    expect(bossOf(all, 'Vorkath')).toMatchObject({
      bestTimeSeconds: null,
      bestTimesByTeamSize: [],
    });
  });
});

describe('GET /accounts/:accountId/kc: gainedLast30Days', () => {
  // Clock: 2026-11-10T12:00Z. Local today is Nov 10 (Oslo), so the window
  // starts at local midnight Oct 12, which is still summer time (UTC+2):
  // 2026-10-11T22:00:00.000Z. DST ends Oct 25, inside the window, so a window
  // of "30 × 24 h" or one using today's offset (UTC+1, 23:00Z) would be wrong.
  const f = eventFactory();
  const events = [
    // A, Vorkath: 101 is the last KC before the window (1 ms before it); 105
    // is exactly at the start, so it is inside. 120 − 101 = 19.
    f.kc('2026-10-01T12:00:00.000Z', { boss: 'Vorkath', killCount: 100, ...A }),
    f.kc('2026-10-11T21:59:59.999Z', { boss: 'Vorkath', killCount: 101, ...A }),
    f.kc('2026-10-11T22:00:00.000Z', { boss: 'Vorkath', killCount: 105, ...A }),
    f.kc('2026-11-09T10:00:00.000Z', { boss: 'Vorkath', killCount: 120, ...A }),
    // A, Zulrah: first ever KC inside the window counts as 0: 9 − 7 = 2.
    f.kc('2026-10-20T10:00:00.000Z', { boss: 'Zulrah', killCount: 7, ...A }),
    f.kc('2026-11-01T10:00:00.000Z', { boss: 'Zulrah', killCount: 9, ...A }),
    // A, Kraken: nothing in the window: 0, still listed.
    f.kc('2026-09-01T10:00:00.000Z', { boss: 'Kraken', killCount: 50, ...A }),
    // A, Cerberus: KC goes down (rare data): never negative.
    f.kc('2026-10-01T10:00:00.000Z', { boss: 'Cerberus', killCount: 30, ...A }),
    f.kc('2026-10-30T10:00:00.000Z', { boss: 'Cerberus', killCount: 25, ...A }),
    // B, Vorkath: 40 is between 22:00Z and 23:00Z, so it is in the window and
    // 35 is the start: 44 − 35 = 9 (a window from 23:00Z would give 4).
    f.kc('2026-10-05T10:00:00.000Z', { boss: 'Vorkath', killCount: 35, ...B }),
    f.kc('2026-10-11T22:30:00.000Z', { boss: 'Vorkath', killCount: 40, ...B }),
    f.kc('2026-11-10T11:00:00.000Z', { boss: 'Vorkath', killCount: 44, ...B }),
  ];

  const gains = (bosses: { boss: string; gainedLast30Days: number }[]) =>
    Object.fromEntries(bosses.map((boss) => [boss.boss, boss.gainedLast30Days]));

  it('uses the KC before the window as the start, per account', async () => {
    start(events);
    const a = await get(`/api/v1/accounts/${idOf(HASH_A)}/kc`, kcResponseSchema);
    expect(gains(a.bosses)).toEqual({ Cerberus: 0, Kraken: 0, Vorkath: 19, Zulrah: 2 });
    const b = await get(`/api/v1/accounts/${idOf(HASH_B)}/kc`, kcResponseSchema);
    expect(gains(b.bosses)).toEqual({ Vorkath: 9 });
  });

  it('sums gains and lists each account for `all`', async () => {
    start(events);
    const kc = await get('/api/v1/accounts/all/kc', kcResponseSchema);
    expect(kc.bosses.find((boss) => boss.boss === 'Vorkath')).toEqual({
      boss: 'Vorkath',
      killCount: 164,
      lastObservedAt: '2026-11-10T11:00:00.000Z',
      bestTimeSeconds: null,
      gainedLast30Days: 28,
      byAccount: [
        { accountId: Number(idOf(HASH_A)), killCount: 120 },
        { accountId: Number(idOf(HASH_B)), killCount: 44 },
      ],
      ...NOT_A_RAID,
    });
    expect(gains(kc.bosses)).toEqual({ Cerberus: 0, Kraken: 0, Vorkath: 28, Zulrah: 2 });
  });
});
