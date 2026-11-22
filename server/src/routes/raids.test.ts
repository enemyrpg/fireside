import {
  errorResponseSchema,
  lootResponseSchema,
  normalizeBossName,
  raidOf,
  raidSplitsResponseSchema,
  raidsResponseSchema,
  RAIDS,
  type Event,
  type LootItem,
  type RaidSummary,
  type SpecialLootItem,
} from '@fireside/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { accounts, lootEvents, lootItems } from '../db/schema.js';
import { rebuildProjections } from '../projections/framework.js';
import { PROJECTIONS } from '../projections/index.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';

// `GET /accounts/:accountId/raids`. Small hand-built data; every expected
// number is worked out by hand in the comments.

const NOW = new Date('2026-11-10T12:00:00.000Z');
const HASH_A = '1111111111';
const HASH_B = '2222222222';
const A = { accountHash: HASH_A, sessionId: sessionIdOf(1) };
const B = { accountHash: HASH_B, sessionId: sessionIdOf(2) };

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
  app = buildApp({ db: run.database, config: testConfig(), dashboard: { now: () => NOW } });
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

function idOf(hash: string): number {
  return (
    run?.database.db.select().from(accounts).where(eq(accounts.accountHash, hash)).get()?.id ?? 0
  );
}

const lootItem = (itemId: number, name: string, quantity: number, gePrice: number): LootItem => ({
  itemId,
  name,
  quantity,
  gePrice,
  haPrice: 0,
});
const coins = (quantity: number) => lootItem(995, 'Coins', quantity, 1);
const special = ({ itemId, name, quantity, gePrice }: LootItem) => ({
  itemId,
  name,
  quantity,
  gePrice,
});

const FANG = lootItem(26219, "Osmumten's fang", 1, 24_500_000);
const MASK = lootItem(27226, 'Masori mask', 1, 10_000_000);
const LIGHTBEARER = lootItem(25975, 'Lightbearer', 1, 5_000_000);
const TBOW = lootItem(20997, 'Twisted bow', 1, 1_000_000_000);
const MAUL = lootItem(21003, 'Elder maul', 1, 30_000_000);
const SCYTHE = lootItem(22486, 'Scythe of vitur (uncharged)', 1, 800_000_000);
const TOA = { type: 'EVENT', name: 'Tombs of Amascut' } as const;

/**
 * Account A (session 1) and B (session 2), all on 8 Nov 2026 (UTC).
 * - 19:00 A: ToA chest (coins 50 000 + fang 24.5M) and its SELF event, whose
 *   price (25M) differs from the chest's: the chest's price is used.
 * - 19:00 B: ToA chest (coins 20 000 + mask 10M) and its SELF event; a
 *   teammate's twisted bow in CoX.
 * - 20:00 A: CoX: Challenge Mode chest named "Chambers of Xeric" (coins
 *   10 000 + twisted bow 1B + elder maul 30M), no SELF events.
 * - 20:30 A: ToB: Hard Mode chest (coins 30 000), a teammate's scythe.
 * - 21:00 A: SELF lightbearer (5M) in ToA without a chest.
 * - 21:30/21:45 A: Vorkath and PLAYER loot (not raid loot).
 */
function raidEvents() {
  const f = eventFactory();
  const e = {
    startA: f.sessionStart('18:00', A),
    startB: f.sessionStart('18:00', { ...B, displayName: 'Test Alt' }),
    toaChestA: f.loot('19:00', { source: TOA, items: [coins(50_000), FANG], killCount: 140, ...A }),
    fangA: f.raidSpecialLoot('19:00', {
      raid: 'Tombs of Amascut Expert Mode',
      item: { ...special(FANG), gePrice: 25_000_000 },
      teamSize: 3,
      killCount: 140,
      ...A,
    }),
    toaChestB: f.loot('19:00', { source: TOA, items: [coins(20_000), MASK], ...B }),
    maskB: f.raidSpecialLoot('19:00', { item: special(MASK), teamSize: 2, ...B }),
    tbowTeammateB: f.raidSpecialLoot('19:00', {
      raid: 'Chambers of Xeric',
      item: { ...special(TBOW), gePrice: 1_500_000_000 },
      recipient: 'TEAMMATE',
      teamSize: 3,
      ...B,
    }),
    coxChestA: f.loot('20:00', {
      source: { type: 'EVENT', name: 'Chambers of Xeric' },
      items: [coins(10_000), TBOW, MAUL],
      killCount: 50,
      ...A,
    }),
    tobChestA: f.loot('20:30', {
      source: { type: 'EVENT', name: 'Theatre of Blood: Hard Mode' },
      items: [coins(30_000)],
      ...A,
    }),
    scytheTeammateA: f.raidSpecialLoot('20:30', {
      raid: 'Theatre of Blood: Hard Mode',
      item: special(SCYTHE),
      recipient: 'TEAMMATE',
      teamSize: 4,
      ...A,
    }),
    lightbearerA: f.raidSpecialLoot('21:00', {
      item: special(LIGHTBEARER),
      killCount: 141,
      ...A,
    }),
    vorkathA: f.loot('21:30', { geValue: 1000, ...A }),
    playerA: f.loot('21:45', { source: { type: 'PLAYER', name: null }, items: [coins(500)], ...A }),
  };
  return { events: Object.values(e) as Event[], e };
}

function summaries(values: Record<string, [number, number, number]>): RaidSummary[] {
  return RAIDS.map(({ name }) => {
    const [lootCount, lootGeValue, specialLootGeValue] = values[name] ?? [0, 0, 0];
    return { raid: name, lootCount, lootGeValue, specialLootGeValue };
  });
}

/** Short labels for a page: `item name/recipient`. */
const labels = (items: readonly SpecialLootItem[]) =>
  items.map((item) => `${item.name}/${item.recipient}`);

const ALL_ORDER = [
  'Lightbearer/SELF',
  'Scythe of vitur (uncharged)/TEAMMATE',
  // Same chest: items in payload order.
  'Twisted bow/SELF',
  'Elder maul/SELF',
  // 19:00: by event ID, newest first (the teammate's bow, the mask, the fang).
  'Twisted bow/TEAMMATE',
  'Masori mask/SELF',
  "Osmumten's fang/SELF",
];

async function allPages(url: string, limit: number): Promise<SpecialLootItem[]> {
  const items: SpecialLootItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const separator = url.includes('?') ? '&' : '?';
    const next: z.infer<typeof raidsResponseSchema> = await get(
      `${url}${separator}limit=${String(limit)}${cursor ? `&cursor=${cursor}` : ''}`,
      raidsResponseSchema,
    );
    expect(next.specialLoot.items.length).toBeLessThanOrEqual(limit);
    items.push(...next.specialLoot.items);
    cursor = next.specialLoot.nextCursor;
    if (cursor === null) return items;
  }
  throw new Error('too many pages');
}

describe('GET /accounts/:accountId/raids', () => {
  it('sums loot per raid without own purples, and own purples separately', async () => {
    start(raidEvents().events);
    const { raids } = await get('/api/v1/accounts/all/raids', raidsResponseSchema);
    expect(raids).toEqual(
      summaries({
        // 10 000 + 1B + 30M − (1B + 30M) in loot; both purples in special loot.
        'Chambers of Xeric': [1, 10_000, 1_030_000_000],
        // The teammate's scythe counts nowhere.
        'Theatre of Blood': [1, 30_000, 0],
        // (50 000 + 24.5M) + (20 000 + 10M) − 24.5M − 10M in loot;
        // 24.5M (chest price) + 10M + 5M (no chest) in special loot.
        'Tombs of Amascut': [2, 70_000, 39_500_000],
      }),
    );

    const a = await get(`/api/v1/accounts/${String(idOf(HASH_A))}/raids`, raidsResponseSchema);
    expect(a.raids).toEqual(
      summaries({
        'Chambers of Xeric': [1, 10_000, 1_030_000_000],
        'Theatre of Blood': [1, 30_000, 0],
        'Tombs of Amascut': [1, 50_000, 29_500_000],
      }),
    );
    const b = await get(`/api/v1/accounts/${String(idOf(HASH_B))}/raids`, raidsResponseSchema);
    expect(b.raids).toEqual(summaries({ 'Tombs of Amascut': [1, 20_000, 10_000_000] }));
  });

  it('counts every linked own purple once: raid loot + special loot = loot', async () => {
    const { events, e } = raidEvents();
    start(events);
    for (const scope of ['all', String(idOf(HASH_A)), String(idOf(HASH_B))]) {
      const { raids } = await get(`/api/v1/accounts/${scope}/raids`, raidsResponseSchema);
      const loot = await get(`/api/v1/accounts/${scope}/loot`, lootResponseSchema);
      if (loot.groupBy !== 'source') throw new Error('groupBy defaults to source');
      const { groups } = loot;
      for (const summary of raids) {
        const lootValue = groups
          .filter(
            (group) =>
              group.source.name !== null &&
              raidOf(normalizeBossName(group.source.name))?.name === summary.raid,
          )
          .reduce((sum, group) => sum + group.geValue, 0);
        // The lightbearer has no chest, so it is only in special loot.
        const noChest =
          summary.raid === 'Tombs of Amascut' && scope !== String(idOf(HASH_B))
            ? e.lightbearerA.payload.item.gePrice
            : 0;
        expect(summary.lootGeValue + summary.specialLootGeValue - noChest, scope).toBe(lootValue);
      }
    }
  });

  it('keeps raid loot + special loot = loot when an own purple is added by hand', async () => {
    const { events } = raidEvents();
    start(events);
    const a = String(idOf(HASH_A));
    const urls = [`/api/v1/accounts/${a}/raids`, '/api/v1/accounts/all/raids'];
    const before = await Promise.all(urls.map((url) => get(url, raidsResponseSchema)));
    const lootBefore = await get(`/api/v1/accounts/${a}/loot`, lootResponseSchema);

    const added = await app?.inject({
      method: 'POST',
      url: `/api/v1/accounts/${a}/raids/drops`,
      payload: {
        raid: 'Tombs of Amascut',
        itemId: FANG.itemId,
        occurredAt: '2019-03-01T20:00:00.000Z',
        recipient: 'SELF',
        partySize: 3,
      },
    });
    expect(added?.statusCode, added?.body).toBe(201);

    // `raids` and `loot` only have what the plugin recorded, so the sums of
    // the detected drops (checked in the test above) are exactly as before.
    // The manual purple comes on top, in `raids/splits`.
    expect(await Promise.all(urls.map((url) => get(url, raidsResponseSchema)))).toEqual(before);
    expect(await get(`/api/v1/accounts/${a}/loot`, lootResponseSchema)).toEqual(lootBefore);
    const splits = await get(`/api/v1/accounts/${a}/raids/splits`, raidSplitsResponseSchema);
    expect(
      splits.raids.find((raid) => raid.raid === 'Tombs of Amascut')?.manualSpecialLootValue,
      // The newest fang price in the data.
    ).toBe(25_000_000);
  });

  it('lists every purple once, newest first, with chest prices and no names', async () => {
    start(raidEvents().events);
    const response = await get('/api/v1/accounts/all/raids', raidsResponseSchema);
    const { items, nextCursor } = response.specialLoot;
    expect(nextCursor).toBeNull();
    expect(labels(items)).toEqual(ALL_ORDER);
    expect(JSON.stringify(response)).not.toMatch(/Test Main|Test Alt/);

    const fang = items.find((item) => item.itemId === FANG.itemId);
    expect(fang).toEqual({
      occurredAt: '2026-11-08T19:00:00.000Z',
      accountId: idOf(HASH_A),
      sessionId: sessionIdOf(1),
      raid: 'Tombs of Amascut: Expert Mode',
      raidGroup: 'Tombs of Amascut',
      itemId: FANG.itemId,
      name: "Osmumten's fang",
      quantity: 1,
      // From the chest, not the SELF event (25M).
      gePriceEach: 24_500_000,
      geValue: 24_500_000,
      recipient: 'SELF',
      teamSize: 3,
      killCount: 140,
    });
    // A chest purple without a SELF event: mode as named by the chest, KC from the chest.
    expect(items.find((item) => item.itemId === MAUL.itemId)).toMatchObject({
      raid: 'Chambers of Xeric',
      raidGroup: 'Chambers of Xeric',
      recipient: 'SELF',
      teamSize: null,
      killCount: 50,
      geValue: 30_000_000,
    });
    // A teammate's purple keeps the event's price.
    expect(
      items.find((item) => item.recipient === 'TEAMMATE' && item.itemId === TBOW.itemId),
    ).toMatchObject({ accountId: idOf(HASH_B), geValue: 1_500_000_000, killCount: null });

    const a = await get(`/api/v1/accounts/${String(idOf(HASH_A))}/raids`, raidsResponseSchema);
    expect(labels(a.specialLoot.items)).toEqual(
      ALL_ORDER.filter((label) => !['Twisted bow/TEAMMATE', 'Masori mask/SELF'].includes(label)),
    );
  });

  it('pages without gaps or duplicates, also across accounts at the same time', async () => {
    start(raidEvents().events);
    for (const limit of [1, 2, 3, 6, 7, 100]) {
      expect(labels(await allPages('/api/v1/accounts/all/raids', limit)), String(limit)).toEqual(
        ALL_ORDER,
      );
    }
    const page = await get('/api/v1/accounts/all/raids?limit=3', raidsResponseSchema);
    expect(page.specialLoot.nextCursor).not.toBeNull();
    // Raids are the same on every page.
    const next = await get(
      `/api/v1/accounts/all/raids?limit=3&cursor=${String(page.specialLoot.nextCursor)}`,
      raidsResponseSchema,
    );
    expect(next.raids).toEqual(page.raids);
  });

  it('gives four empty raids without data', async () => {
    start([eventFactory().sessionStart('18:00', A)]);
    expect(await get('/api/v1/accounts/all/raids', raidsResponseSchema)).toEqual({
      raids: summaries({}),
      specialLoot: { items: [], nextCursor: null },
    });
  });

  it('lists a purple from an unknown raid but sums it in no raid', async () => {
    const f = eventFactory();
    start([
      f.raidSpecialLoot('19:00', { raid: 'Nex Raid', item: special(MASK), ...A }),
      f.loot('19:30', { source: { type: 'EVENT', name: 'Nex Raid' }, items: [MASK], ...A }),
    ]);
    const response = await get('/api/v1/accounts/all/raids', raidsResponseSchema);
    expect(response.raids).toEqual(summaries({}));
    expect(response.specialLoot.items).toEqual([
      expect.objectContaining({ raid: 'Nex Raid', raidGroup: 'Nex Raid', recipient: 'SELF' }),
    ]);
  });

  it('caps huge purple values so the response still passes its schema', async () => {
    const f = eventFactory();
    const huge = { ...special(SCYTHE), quantity: 2, gePrice: 2 ** 52 };
    start([
      f.raidSpecialLoot('19:00', { raid: 'Theatre of Blood', item: huge, ...A }),
      f.raidSpecialLoot('19:30', {
        raid: 'Theatre of Blood',
        item: huge,
        recipient: 'TEAMMATE',
        ...A,
      }),
    ]);
    const { raids, specialLoot } = await get('/api/v1/accounts/all/raids', raidsResponseSchema);
    expect(specialLoot.items.map((item) => item.geValue)).toEqual([
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ]);
    expect(raids.find((raid) => raid.raid === 'Theatre of Blood')?.specialLootGeValue).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('reads a purple the same way in the sums and the list if its chest item is missing', async () => {
    const { events, e } = raidEvents();
    start(events);
    // Not possible through ingest; checks that sums and list never disagree.
    const db = run?.database.db;
    if (!db) throw new Error('start() sets run');
    const chest = db
      .select()
      .from(lootEvents)
      .where(eq(lootEvents.eventId, e.toaChestA.eventId))
      .get();
    db.delete(lootItems)
      .where(and(eq(lootItems.lootEventId, chest?.id ?? 0), eq(lootItems.position, 1)))
      .run();

    const { raids, specialLoot } = await get('/api/v1/accounts/all/raids', raidsResponseSchema);
    // The fang falls back to the SELF event (25M) and is no longer taken out of loot.
    expect(raids.find((raid) => raid.raid === 'Tombs of Amascut')).toEqual({
      raid: 'Tombs of Amascut',
      lootCount: 2,
      lootGeValue: 70_000 + 24_500_000,
      specialLootGeValue: 25_000_000 + 10_000_000 + 5_000_000,
    });
    for (const summary of raids) {
      const own = specialLoot.items.filter(
        (item) => item.recipient === 'SELF' && item.raidGroup === summary.raid,
      );
      expect(
        own.reduce((sum, item) => sum + item.geValue, 0),
        summary.raid,
      ).toBe(summary.specialLootGeValue);
    }
  });

  it('gives the same response and keeps cursors valid after a rebuild', async () => {
    start(raidEvents().events);
    const before = await get('/api/v1/accounts/all/raids', raidsResponseSchema);
    const first = await get('/api/v1/accounts/all/raids?limit=3', raidsResponseSchema);
    const db = run?.database.db;
    if (!db) throw new Error('start() sets run');
    expect(rebuildProjections(db, { projections: PROJECTIONS, now: () => NOW }).failed).toEqual([]);
    expect(await get('/api/v1/accounts/all/raids', raidsResponseSchema)).toEqual(before);
    const next = await get(
      `/api/v1/accounts/all/raids?limit=3&cursor=${String(first.specialLoot.nextCursor)}`,
      raidsResponseSchema,
    );
    expect(labels(next.specialLoot.items)).toEqual(ALL_ORDER.slice(3, 6));
  });

  it('rejects bad cursors and queries, and unknown accounts', async () => {
    start(raidEvents().events);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const badCursors = [
      'abc',
      '!!!',
      encode([1, 2, 3]),
      encode(['2026-11-08T19:00:00.000Z', '01933c4e-8a2b-7c3d-9e4f-000000000002', -1]),
      encode(['2026-11-08T19:00:00.000Z', 'not-a-uuid', 0]),
    ];
    for (const cursor of badCursors) {
      const { status, body } = await getError(`/api/v1/accounts/all/raids?cursor=${cursor}`);
      expect(status, cursor).toBe(400);
      expect(body.error.details).toEqual([{ path: 'query.cursor', message: 'Invalid cursor' }]);
    }
    for (const query of ['limit=0', 'limit=101', 'from=2026-11-01T00:00:00.000Z']) {
      expect((await getError(`/api/v1/accounts/all/raids?${query}`)).status, query).toBe(400);
    }
    expect((await getError('/api/v1/accounts/999/raids')).status).toBe(404);
  });
});
