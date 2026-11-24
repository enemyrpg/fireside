import { feedResponseSchema, type Event, type FeedEntry, type FeedType } from '@fireside/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { storeExternalSnapshot } from '../clog/project.js';
import { recordClogRead } from '../clog/reads.js';
import { clogBody, feedBody } from '../clog/testing.js';
import { accounts } from '../db/schema.js';
import { ApiError } from '../errors.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  type TestRun,
} from '../projections/testing.js';
import { feed } from './feed.js';

// The feed for "Latest" on Home. Two accounts of one user.

const NOW = new Date('2026-11-16T12:00:00.000Z');
const T = (time: string) => `2026-11-16T${time}.000Z`;
const HASH_A = '1111111111';
const HASH_B = '2222222222';
const A = { accountHash: HASH_A, sessionId: sessionIdOf(1) };
const A_OPEN = { accountHash: HASH_A, sessionId: sessionIdOf(2) };
const B = { accountHash: HASH_B, sessionId: sessionIdOf(3) };
const f = eventFactory();

const SPEAR = 1249;
const ORPHAN = 13262;
const VORKI = 21992;
const NEW_ITEM = 30001;
const ALL: FeedType[] = ['session', 'level', 'clog', 'pet', 'drop'];

function item(itemId: number, name: string, gePrice: number) {
  return [{ itemId, name, quantity: 1, gePrice, haPrice: 0 }];
}

const EVENTS: Event[] = [
  f.sessionStart(T('10:00:00'), A),
  f.xpSnapshot(T('10:00:01'), { SLAYER: { xp: 4_900_000, level: 89 } }, { ...A, reason: 'login' }),
  f.petDrop(T('10:20:00'), A),
  f.loot(T('10:30:00'), { ...A, items: item(SPEAR, 'Dragon spear', 1_200_000) }),
  f.loot(T('10:40:00'), { ...A, geValue: 500 }),
  // The new collection log item's first drop, and a second one.
  f.loot(T('10:45:00'), { ...A, items: item(NEW_ITEM, 'New item', 3_000_000) }),
  f.loot(T('10:50:00'), { ...A, items: item(NEW_ITEM, 'New item', 3_000_000) }),
  f.xpSnapshot(T('10:59:00'), { SLAYER: { xp: 5_400_000, level: 90 } }, A),
  f.heartbeat(T('11:00:00'), A),
  f.sessionEnd(T('11:00:00'), A),
  // B's session ends at the same time as A's.
  f.sessionStart(T('10:00:00'), { ...B, displayName: 'Test Alt' }),
  f.loot(T('10:30:00'), { ...B, items: item(SPEAR, 'Dragon spear', 1_200_000) }),
  f.heartbeat(T('11:00:00'), B),
  f.sessionEnd(T('11:00:00'), B),
  // A plays again, still open at NOW.
  f.sessionStart(T('11:30:00'), A_OPEN),
  f.heartbeat(T('11:55:00'), A_OPEN),
];

let hashCounter = 0;

function idOf(run: TestRun, hash: string): number {
  const row = run.database.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.accountHash, hash))
    .get();
  if (!row) throw new Error(`No account ${hash}`);
  return row.id;
}

function read(run: TestRun, time: string, has: number[], feedItems: [number, string][] = []) {
  const accountId = idOf(run, HASH_A);
  run.database.db.transaction((tx) => {
    recordClogRead(tx, accountId, T(time));
    const store = (kind: 'COLLECTION_LOG' | 'ACTIVITIES', body: string) => {
      hashCounter += 1;
      storeExternalSnapshot(tx, {
        source: 'RUNEPROFILE',
        kind,
        accountId,
        fetchedAt: T(time),
        contentHash: `sha256:${hashCounter.toString(16).padStart(64, '0')}`,
        body,
      });
    };
    store(
      'COLLECTION_LOG',
      clogBody(Object.fromEntries(has.map((id) => [id, 1])), {
        extraItems: [{ id: NEW_ITEM, name: 'New item', quantity: has.includes(NEW_ITEM) ? 1 : 0 }],
      }),
    );
    if (feedItems.length > 0) store('ACTIVITIES', feedBody(feedItems));
  });
}

function setUp(): TestRun {
  const run = emptyRun();
  ingestBatch(run, EVENTS, undefined, NOW);
  expect(run.failed).toEqual([]);
  read(run, '09:00:00', [4151]);
  // After A's session: the orphan (approximate), the new item and Vorki with feed times.
  read(
    run,
    '11:02:30',
    [4151, ORPHAN, NEW_ITEM, VORKI],
    [
      [NEW_ITEM, T('10:45:01')],
      [VORKI, T('10:20:00')],
    ],
  );
  return run;
}

function page(
  run: TestRun,
  options: {
    types?: FeedType[];
    minValue?: number;
    limit?: number;
    cursor?: string;
    accounts?: number[];
  } = {},
) {
  const result = feed(run.database.db, {
    accountIds: options.accounts ?? [idOf(run, HASH_A), idOf(run, HASH_B)],
    types: options.types ?? ALL,
    minValue: options.minValue ?? 1_000_000,
    limit: options.limit ?? 100,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
  return feedResponseSchema.parse(result);
}

/** Every page with `limit`, joined. */
function walk(run: TestRun, options: Parameters<typeof page>[1] & { limit: number }): FeedEntry[] {
  const out: FeedEntry[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const result = page(run, { ...options, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...result.items);
    if (result.nextCursor === null) return out;
    cursor = result.nextCursor;
  }
  throw new Error('Too many pages');
}

const ids = (entries: readonly FeedEntry[]) => entries.map((entry) => entry.id);

describe('the feed', () => {
  it('has every type, newest first, a session above what happened in it', () => {
    const run = setUp();
    const a = idOf(run, HASH_A);
    const b = idOf(run, HASH_B);
    const sessions = [A.sessionId, B.sessionId].sort().reverse();
    expect(ids(page(run).items)).toEqual([
      // Open: at its last heartbeat.
      `session:${A_OPEN.sessionId}`,
      // The orphan is on "All Pets" in the test layout: a pet, at its sync time.
      `pet:${String(a)}.${String(ORPHAN)}`,
      // Both end at 11:00: by ID, descending.
      ...sessions.map((id) => `session:${id}`),
      `level:${A.sessionId}.SLAYER`,
      // 10:50 the second drop of the new item stays a drop; the first (10:45)
      // is the clog entry at its feed time.
      `drop:${EVENTS[6]?.eventId ?? ''}.0`,
      `clog:${String(a)}.${String(NEW_ITEM)}`,
      ...[`drop:${EVENTS[3]?.eventId ?? ''}.0`, `drop:${EVENTS[11]?.eventId ?? ''}.0`]
        .sort()
        .reverse(),
      `pet:${String(a)}.${String(VORKI)}`,
    ]);
    expect(b).not.toBe(a);
  });

  it('times a closed session at its end and an open one at its last heartbeat', () => {
    const run = setUp();
    const at = Object.fromEntries(
      page(run, { types: ['session'] }).items.map((entry) => [entry.id, entry.at]),
    );
    expect(at[`session:${A.sessionId}`]).toBe(T('11:00:00'));
    expect(at[`session:${A_OPEN.sessionId}`]).toBe(T('11:55:00'));
  });

  it('gives a level-up per skill at the session end, and clog entries without pets', () => {
    const run = setUp();
    const entries = page(run, { types: ['level', 'clog'] }).items;
    expect(entries.find((entry) => entry.type === 'level')).toMatchObject({
      at: T('11:00:00'),
      sessionId: A.sessionId,
      skill: 'SLAYER',
      fromLevel: 89,
      toLevel: 90,
    });
    const clog = entries.filter((entry) => entry.type === 'clog');
    // The orphan is a pet in this layout ("All Pets"): a pet entry would stand
    // for it, but it has no pet time here. Vorki is a pet entry, never clog.
    expect(clog.map((entry) => entry.itemId)).toEqual([NEW_ITEM]);
    expect(clog[0]).toMatchObject({
      sessionId: A.sessionId,
      approximate: false,
      drop: { geValue: 3_000_000 },
      page: 'Vorkath',
    });
  });

  describe('one entry for a drop that is a new collection log item', () => {
    const firstDrop = () => `drop:${EVENTS[5]?.eventId ?? ''}.0`;

    it('with both types: only the clog entry, with the drop’s value', () => {
      const run = setUp();
      const entries = page(run, { types: ['clog', 'drop'] }).items;
      expect(ids(entries)).not.toContain(firstDrop());
      expect(entries.filter((entry) => entry.type === 'clog')).toHaveLength(1);
    });

    it('with drops only: the drop, marked newCollectionLog', () => {
      const run = setUp();
      const drops = page(run, { types: ['drop'] }).items;
      expect(drops.find((entry) => entry.id === firstDrop())).toMatchObject({
        newCollectionLog: true,
      });
      // The second drop of the item, and other drops, are not new.
      expect(
        drops.filter((entry) => entry.type === 'drop' && entry.newCollectionLog).map((e) => e.id),
      ).toEqual([firstDrop()]);
    });

    it('with clog only: the clog entry', () => {
      const run = setUp();
      expect(page(run, { types: ['clog'] }).items.map((entry) => entry.type)).toEqual(['clog']);
    });
  });

  it('filters each type on its own, giving the same entries as the full feed (drops: as above)', () => {
    const run = setUp();
    const full = page(run).items;
    for (const type of ALL.filter((t) => t !== 'drop')) {
      expect(ids(page(run, { types: [type] }).items), type).toEqual(
        ids(full.filter((entry) => entry.type === type)),
      );
    }
  });

  it('takes drops from minValue', () => {
    const run = setUp();
    const values = (minValue: number) =>
      page(run, { types: ['drop'], minValue }).items.flatMap((entry) =>
        entry.type === 'drop' ? [entry.drop.geValue] : [],
      );
    expect(values(0)).toContain(500);
    expect(values(1_000_000)).not.toContain(500);
    expect(values(10_000_000)).toEqual([]);
  });

  it('pages without gaps or duplicates, for every page size and type mix', () => {
    const run = setUp();
    const mixes: FeedType[][] = [
      ALL,
      ['clog', 'drop'],
      ['drop'],
      ['clog'],
      ['session', 'level'],
      ['pet'],
    ];
    for (const types of mixes) {
      const full = ids(page(run, { types, minValue: 0 }).items);
      for (let limit = 1; limit <= full.length + 1; limit++) {
        expect(
          ids(walk(run, { types, minValue: 0, limit })),
          `${types.join(',')} ${String(limit)}`,
        ).toEqual(full);
      }
    }
  });

  it('keeps one account’s feed to that account', () => {
    const run = setUp();
    const a = idOf(run, HASH_A);
    const entries = page(run, { accounts: [a], minValue: 0 }).items;
    expect(entries.every((entry) => entry.accountId === a)).toBe(true);
    expect(page(run, { accounts: [] }).items).toEqual([]);
  });

  it('gives the same pages after a rebuild, also from a cursor made before it', () => {
    // `lootEventId` is the row ID of `loot_events`, which a rebuild renumbers
    // (as in `loot/drops` and session detail). Entry IDs and cursors use the
    // event's `event_id`, so they stay.
    const stable = (value: unknown) =>
      JSON.parse(JSON.stringify(value).replace(/"lootEventId":\d+/g, '"lootEventId":0')) as unknown;
    const run = setUp();
    const first = page(run, { limit: 3, minValue: 0 });
    const cursor = first.nextCursor ?? undefined;
    expect(cursor).toBeDefined();
    const rest = walk(run, { limit: 3, minValue: 0, ...(cursor ? { cursor } : {}) });
    rebuildDerivedTables(run.database.db, { now: () => NOW });
    expect(stable(page(run, { limit: 3, minValue: 0 }))).toEqual(stable(first));
    expect(stable(walk(run, { limit: 3, minValue: 0, ...(cursor ? { cursor } : {}) }))).toEqual(
      stable(rest),
    );
  });

  it('rejects a bad cursor with 400 at query.cursor', () => {
    const run = setUp();
    expect(() => page(run, { cursor: 'bm9wZQ' })).toThrow(ApiError);
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'rejects the inherited name %s as a type with 400, never calling it',
    (type) => {
      const run = setUp();
      expect(() => page(run, { types: [type as FeedType] })).toThrow(ApiError);
    },
  );
});
