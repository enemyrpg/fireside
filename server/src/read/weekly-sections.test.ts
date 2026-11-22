import {
  potionValue,
  weeklyResponseSchema,
  type AccountScope,
  type Event,
  type WeeklyResponse,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { rebuildClog, storeExternalSnapshot } from '../clog/project.js';
import { clogBody, feedBody } from '../clog/testing.js';
import { accounts, weeklySummaries } from '../db/schema.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  seededRandom,
  sessionIdOf,
  shuffled,
  type TestRun,
} from '../projections/testing.js';
import { bankHistory } from './bank.js';
import { ownedAccountIds } from './accounts.js';
import { localUserId } from '../users/users.js';
import { weeklySummary } from './weekly.js';

// The weekly sections for pets, bank, collection log and quests, and that
// stored weeks are computed again when their data changes, also when it comes
// from a collection log sync (not an event).
//
// Europe/Oslo (UTC+1 in November):
// - 2026-W45: Mon 2 Nov – Sun 8 Nov,   [2026-11-01T23:00Z, 2026-11-08T23:00Z)
// - 2026-W46: Mon 9 Nov – Sun 15 Nov,  [2026-11-08T23:00Z, 2026-11-15T23:00Z)
// - 2026-W47: Mon 16 Nov – Sun 22 Nov, [2026-11-15T23:00Z, 2026-11-22T23:00Z)
// - 2026-W48: Mon 23 Nov – Sun 29 Nov, the current week at NOW (a Wednesday).

const TZ = 'Europe/Oslo';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const HASH_A = '1111111111';
const HASH_B = '2222222222';
const A = { accountHash: HASH_A, sessionId: sessionIdOf(1) };
const B = { accountHash: HASH_B, sessionId: sessionIdOf(2) };

/** Each account's first event, in W45, so every week below can have content. */
const f = eventFactory();
const FIRST = [f.sessionStart('2026-11-02T08:00:00.000Z', A)];
const FIRST_B = [f.sessionStart('2026-11-02T08:00:00.000Z', { ...B, displayName: 'Test Alt' })];

function started(events: readonly Event[] = []): TestRun {
  const run = emptyRun();
  ingest(run, [...FIRST, ...events]);
  return run;
}

function ingest(run: TestRun, events: readonly Event[]): void {
  ingestBatch(run, events, undefined, NOW);
  expect(run.failed).toEqual([]);
}

function idOf(run: TestRun, hash = HASH_A): number {
  const row = run.database.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.accountHash, hash))
    .get();
  if (!row) throw new Error(`No account ${hash}`);
  return row.id;
}

/** The week through the read code, checked against the contract. */
function week(run: TestRun, key: string, scope: AccountScope = idOf(run)): WeeklyResponse {
  return weeklyResponseSchema.parse(
    weeklySummary(
      run.database.db,
      scope === 'all' ? ownedAccountIds(run.database.db, localUserId(run.database.db)) : [scope],
      key,
      TZ,
      NOW.getTime(),
    ),
  );
}

function storedWeeks(run: TestRun): string[] {
  return run.database.db
    .select({ isoWeek: weeklySummaries.isoWeek })
    .from(weeklySummaries)
    .all()
    .map((row) => row.isoWeek)
    .sort();
}

let hashCounter = 0;
type ClogStep =
  | { clog: Record<number, number>; fetchedAt: string }
  | { feed: [number, string][]; fetchedAt: string };

/** Stores one collection log response or feed page, as a sync does. */
function sync(run: TestRun, step: ClogStep, hash = HASH_A): void {
  hashCounter += 1;
  run.database.db.transaction((tx) => {
    storeExternalSnapshot(tx, {
      source: 'RUNEPROFILE',
      kind: 'clog' in step ? 'COLLECTION_LOG' : 'ACTIVITIES',
      accountId: idOf(run, hash),
      fetchedAt: step.fetchedAt,
      contentHash: `sha256:${hashCounter.toString(16).padStart(64, '0')}`,
      body: 'clog' in step ? clogBody(step.clog) : feedBody(step.feed),
    });
  });
}

const coins = (quantity: number) => ({
  payload: {
    items: [
      { itemId: 995, name: 'Coins', quantity, placeholder: false as const, gePrice: 1, haPrice: 1 },
    ],
  },
});
/** The event factory's default potion storage: 100 doses of a 4-dose potion. */
const POTIONS = potionValue(12_400, 100, 4);

describe('weekly: bank', () => {
  const events = [
    f.bankSnapshot('2026-11-03T10:00:00.000Z', { ...A, ...coins(1000) }),
    f.bankSnapshot('2026-11-11T10:00:00.000Z', { ...A, ...coins(5000) }),
    f.potionStorage('2026-11-12T10:00:00.000Z', A),
  ];

  it('is null until the account has a snapshot before the end of the week', () => {
    const run = started([f.bankSnapshot('2026-11-11T10:00:00.000Z', { ...A, ...coins(5000) })]);
    expect(week(run, '2026-W45').bank).toBeNull();
    expect(week(run, '2026-W46').bank).not.toBeNull();
  });

  it('has no start value in the week of the first snapshot, and days from that day', () => {
    const run = started(events);
    expect(week(run, '2026-W45').bank).toEqual({
      startGeValue: null,
      endGeValue: 1000,
      // Tuesday to Sunday: Monday 2 Nov had no snapshot yet.
      days: ['03', '04', '05', '06', '07', '08'].map((day) => ({
        date: `2026-11-${day}`,
        geValue: 1000,
      })),
    });
  });

  it('carries the last snapshot forward and adds potion storage', () => {
    const run = started(events);
    expect(week(run, '2026-W46').bank).toEqual({
      startGeValue: 1000,
      endGeValue: 5000 + POTIONS,
      days: [
        { date: '2026-11-09', geValue: 1000 },
        { date: '2026-11-10', geValue: 1000 },
        { date: '2026-11-11', geValue: 5000 },
        { date: '2026-11-12', geValue: 5000 + POTIONS },
        { date: '2026-11-13', geValue: 5000 + POTIONS },
        { date: '2026-11-14', geValue: 5000 + POTIONS },
        { date: '2026-11-15', geValue: 5000 + POTIONS },
      ],
    });
  });

  it('shows a week without a new snapshot with no change', () => {
    const bank = week(started(events), '2026-W47').bank;
    expect(bank).toMatchObject({ startGeValue: 5000 + POTIONS, endGeValue: 5000 + POTIONS });
    expect(bank?.days).toHaveLength(7);
  });

  it('stops at today in the current week', () => {
    const current = week(started(events), '2026-W48');
    expect(current.complete).toBe(false);
    expect(current.bank?.days.map((day) => day.date)).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
    ]);
  });

  it('has the same days as bank/history for the week', () => {
    const run = started(events);
    for (const key of ['2026-W45', '2026-W46', '2026-W47', '2026-W48']) {
      const weekly = week(run, key);
      const history = bankHistory(
        run.database.db,
        [idOf(run)],
        { from: weekly.start, to: weekly.end },
        TZ,
        NOW.getTime(),
      );
      expect(weekly.bank?.days, key).toEqual(
        history.map(({ date, geValue }) => ({ date, geValue })),
      );
    }
  });

  it('sums accounts per day, and has no start while one of them has none', () => {
    const run = started(events);
    ingest(run, [
      ...FIRST_B,
      f.bankSnapshot('2026-11-13T10:00:00.000Z', { ...B, ...coins(70_000) }),
    ]);
    const w46 = week(run, '2026-W46', 'all').bank;
    // B's first snapshot is in the week: its whole bank is not a gain.
    expect(w46?.startGeValue).toBeNull();
    expect(w46?.days.map((day) => day.geValue)).toEqual([
      1000,
      1000,
      5000,
      5000 + POTIONS,
      5000 + POTIONS + 70_000,
      5000 + POTIONS + 70_000,
      5000 + POTIONS + 70_000,
    ]);
    expect(w46?.endGeValue).toBe(5000 + POTIONS + 70_000);
    expect(week(run, '2026-W47', 'all').bank).toMatchObject({
      startGeValue: 5000 + POTIONS + 70_000,
      endGeValue: 5000 + POTIONS + 70_000,
    });
  });

  it('computes stored weeks again after a late snapshot', () => {
    const run = started(events);
    for (const key of ['2026-W45', '2026-W46', '2026-W47']) week(run, key);
    expect(storedWeeks(run)).toEqual(['2026-W45', '2026-W46', '2026-W47']);
    // Sent late: a snapshot from Thursday of W45.
    ingest(run, [f.bankSnapshot('2026-11-05T10:00:00.000Z', { ...A, ...coins(3000) })]);
    expect(storedWeeks(run)).toEqual([]);
    expect(week(run, '2026-W45').bank?.endGeValue).toBe(3000);
    expect(week(run, '2026-W46').bank?.startGeValue).toBe(3000);
  });
});

describe('weekly: pets', () => {
  const DROP = '2026-11-05T19:00:00.000Z';
  const SYNC_1 = '2026-11-06T10:00:00.000Z';
  const SYNC_2 = '2026-11-12T10:00:00.000Z';

  function withDrop(): TestRun {
    return started([
      f.petDrop(DROP, A),
      // The KC line can come just after the pet line.
      f.kc('2026-11-05T19:00:01.000Z', { killCount: 1204, boss: 'Vorkath', ...A }),
    ]);
  }

  it('shows a chat pet in the week it dropped, with its KC', () => {
    const run = withDrop();
    expect(week(run, '2026-W45').pets).toEqual({
      pets: [
        {
          accountId: idOf(run),
          itemId: 21992,
          name: 'Vorki',
          obtainedAt: DROP,
          approximate: false,
          source: { type: 'ACTIVITY', name: 'Vorkath' },
          killCount: 1204,
          xp: null,
          confirmed: false,
          origin: 'CHAT',
        },
      ],
    });
    expect(week(run, '2026-W46').pets).toBeNull();
  });

  it('leaves out a pet without a time', () => {
    const run = started();
    sync(run, { clog: { 13262: 1 }, fetchedAt: SYNC_1 });
    for (const key of ['2026-W45', '2026-W46']) expect(week(run, key).pets, key).toBeNull();
  });

  it('computes a stored week again when a sync confirms the pet', () => {
    const run = withDrop();
    expect(week(run, '2026-W45').pets?.pets[0]?.confirmed).toBe(false);
    expect(storedWeeks(run)).toEqual(['2026-W45']);
    sync(run, { clog: { 21992: 1 }, fetchedAt: SYNC_1 });
    expect(week(run, '2026-W45').pets?.pets[0]).toMatchObject({ confirmed: true, origin: 'CHAT' });
  });

  it('moves a collection log pet to the week of its feed time, also in stored weeks', () => {
    const run = withDrop();
    sync(run, { clog: { 21992: 1 }, fetchedAt: SYNC_1 });
    sync(run, { clog: { 21992: 1, 13262: 1 }, fetchedAt: SYNC_2 });
    // New in the second sync: its time is that sync's, approximate.
    expect(week(run, '2026-W46').pets?.pets).toMatchObject([
      { itemId: 13262, obtainedAt: SYNC_2, approximate: true, origin: 'CLOG', killCount: null },
    ]);
    expect(week(run, '2026-W45').pets?.pets).toHaveLength(1);
    expect(storedWeeks(run)).toEqual(['2026-W45', '2026-W46']);

    // The feed has the real time, in the week before.
    sync(run, { feed: [[13262, '2026-11-04T08:00:00.000Z']], fetchedAt: SYNC_2 });
    expect(week(run, '2026-W46').pets).toBeNull();
    // Newest first.
    expect(week(run, '2026-W45').pets?.pets).toMatchObject([
      { itemId: 21992, obtainedAt: DROP },
      { itemId: 13262, obtainedAt: '2026-11-04T08:00:00.000Z', approximate: false },
    ]);
  });

  it('keeps stored weeks when a sync changes no pet with a time', () => {
    const run = withDrop();
    week(run, '2026-W45');
    // A feed page about an item the collection log does not have yet.
    sync(run, { feed: [[4151, '2026-11-04T08:00:00.000Z']], fetchedAt: SYNC_2 });
    expect(storedWeeks(run)).toEqual(['2026-W45']);
  });

  it('lists every account’s pets for all, with the account', () => {
    const run = withDrop();
    ingest(run, [
      ...FIRST_B,
      f.petDrop('2026-11-06T19:00:00.000Z', {
        ...B,
        message: 'BACKPACK',
        pet: { itemId: 13322, name: 'Beaver' },
        source: { type: 'SKILL', name: 'WOODCUTTING' },
      }),
    ]);
    expect(week(run, '2026-W45', 'all').pets?.pets).toMatchObject([
      { accountId: idOf(run, HASH_B), itemId: 13322, xp: null },
      { accountId: idOf(run, HASH_A), itemId: 21992, killCount: 1204 },
    ]);
  });
});

describe('weekly: collection log', () => {
  const SYNC_1 = '2026-11-03T10:00:00.000Z';
  const SYNC_2 = '2026-11-12T10:00:00.000Z';

  function synced(): TestRun {
    const run = started();
    sync(run, { clog: { 4151: 1 }, fetchedAt: SYNC_1 });
    sync(run, { clog: { 4151: 1, 13262: 1, 22006: 1 }, fetchedAt: SYNC_2 });
    return run;
  }

  it('is null without new items: what the first sync had has no time', () => {
    const run = synced();
    expect(week(run, '2026-W45').collectionLog).toBeNull();
    expect(week(run, '2026-W47').collectionLog).toBeNull();
  });

  it('lists the items new in the week, with the counts at its end', () => {
    const run = synced();
    const id = idOf(run);
    expect(week(run, '2026-W46').collectionLog).toEqual({
      newItems: 2,
      // Unique items: "All Pets" repeats two of the five.
      obtained: 3,
      total: 5,
      recentItems: [
        {
          accountId: id,
          itemId: 13262,
          name: 'Abyssal orphan',
          // Its first page in the game's order, not "All Pets".
          page: 'Abyssal Sire',
          firstSeenAt: SYNC_2,
          approximate: true,
        },
        {
          accountId: id,
          itemId: 22006,
          name: 'Skeletal visage',
          page: 'Vorkath',
          firstSeenAt: SYNC_2,
          approximate: true,
        },
      ],
    });
  });

  it('moves an item to the week of its feed time, also in stored weeks', () => {
    const run = synced();
    for (const key of ['2026-W45', '2026-W46', '2026-W47']) week(run, key);
    expect(storedWeeks(run)).toEqual(['2026-W45', '2026-W46', '2026-W47']);

    sync(run, { feed: [[22006, '2026-11-04T08:00:00.000Z']], fetchedAt: SYNC_2 });
    expect(storedWeeks(run)).toEqual([]);
    expect(week(run, '2026-W45').collectionLog).toMatchObject({
      newItems: 1,
      // The counts of the first sync, the only one before the end of W45.
      obtained: 1,
      total: 5,
      recentItems: [{ itemId: 22006, firstSeenAt: '2026-11-04T08:00:00.000Z', approximate: false }],
    });
    expect(week(run, '2026-W46').collectionLog).toMatchObject({
      newItems: 1,
      recentItems: [{ itemId: 13262 }],
    });
  });

  it('computes weeks from a new collection log’s time again, and keeps earlier ones', () => {
    const run = synced();
    for (const key of ['2026-W45', '2026-W46', '2026-W47']) week(run, key);
    sync(run, {
      clog: { 4151: 1, 13262: 1, 22006: 1, 13277: 1 },
      fetchedAt: '2026-11-17T10:00:00.000Z',
    });
    expect(storedWeeks(run)).toEqual(['2026-W45', '2026-W46']);
    expect(week(run, '2026-W47').collectionLog).toMatchObject({
      newItems: 1,
      obtained: 4,
      recentItems: [{ itemId: 13277, page: 'Abyssal Sire' }],
    });
  });

  it('has no counts for a week before the first collection log', () => {
    const run = started();
    sync(run, { clog: { 4151: 1 }, fetchedAt: SYNC_2 });
    sync(run, { feed: [[4151, '2026-11-04T08:00:00.000Z']], fetchedAt: SYNC_2 });
    expect(week(run, '2026-W45').collectionLog).toMatchObject({
      newItems: 1,
      obtained: null,
      total: null,
    });
  });

  it('keeps the five newest and counts the rest', () => {
    const run = started();
    sync(run, { clog: {}, fetchedAt: SYNC_1 });
    const items = [13262, 13277, 4151, 21992, 22006, 30001];
    const extraItems = [{ id: 30001, name: 'New item', quantity: 1 }];
    hashCounter += 1;
    run.database.db.transaction((tx) => {
      storeExternalSnapshot(tx, {
        source: 'RUNEPROFILE',
        kind: 'COLLECTION_LOG',
        accountId: idOf(run),
        fetchedAt: SYNC_2,
        contentHash: `sha256:${hashCounter.toString(16).padStart(64, '0')}`,
        body: clogBody(Object.fromEntries(items.map((id) => [id, 1])), { extraItems }),
      });
    });
    // Each a minute apart, 30001 newest.
    sync(run, {
      feed: items.map((id, index) => [id, `2026-11-10T08:0${String(index)}:00.000Z`]),
      fetchedAt: SYNC_2,
    });
    const clog = week(run, '2026-W46').collectionLog;
    expect(clog?.newItems).toBe(6);
    expect(clog?.recentItems.map((item) => item.itemId)).toEqual([
      30001, 22006, 21992, 4151, 13277,
    ]);
    // An item the server has never heard of is shown by its name.
    expect(clog?.recentItems[0]).toMatchObject({ name: 'New item', page: 'Vorkath' });
  });

  it('sums accounts for all and keeps the newest five of them', () => {
    const run = synced();
    ingest(run, FIRST_B);
    sync(run, { clog: {}, fetchedAt: SYNC_1 }, HASH_B);
    sync(run, { clog: { 4151: 2 }, fetchedAt: '2026-11-13T10:00:00.000Z' }, HASH_B);
    expect(week(run, '2026-W46', 'all').collectionLog).toMatchObject({
      newItems: 3,
      obtained: 4,
      total: 10,
      recentItems: [
        { accountId: idOf(run, HASH_B), itemId: 4151 },
        { accountId: idOf(run, HASH_A), itemId: 13262 },
        { accountId: idOf(run, HASH_A), itemId: 22006 },
      ],
    });
  });

  it('empties the stored weeks when the collection log is rebuilt, with the same answers', () => {
    const run = synced();
    const keys = ['2026-W45', '2026-W46', '2026-W47'];
    const before = keys.map((key) => ({ ...week(run, key), computedAt: null }));
    expect(storedWeeks(run)).toEqual(keys);
    run.database.db.transaction((tx) => rebuildClog(tx));
    expect(storedWeeks(run)).toEqual([]);
    expect(keys.map((key) => ({ ...week(run, key), computedAt: null }))).toEqual(before);
  });
});

describe('weekly: quests and diaries', () => {
  const T1 = '2026-11-03T10:00:00.000Z';
  const T2 = '2026-11-10T10:00:00.000Z';
  const events = [
    f.questsSnapshot(T1, {
      ...A,
      questPoints: 10,
      quests: { COOKS_ASSISTANT: 'FINISHED', DRAGON_SLAYER_I: 'IN_PROGRESS' },
    }),
    f.diariesSnapshot(T1, { ...A, diaries: { ARDOUGNE: ['EASY'] } }),
    f.questsSnapshot(T2, {
      ...A,
      questPoints: 12,
      entries: [
        { quest: 'COOKS_ASSISTANT', name: "Cook's Assistant", state: 'FINISHED' },
        { quest: 'DRAGON_SLAYER_I', name: 'Dragon Slayer I', state: 'FINISHED' },
        {
          quest: 'LAIR_OF_TARN_RAZORLOR',
          name: 'Lair of Tarn Razorlor',
          kind: 'MINIQUEST',
          state: 'FINISHED',
        },
      ],
    }),
    f.diariesSnapshot(T2, { ...A, diaries: { ARDOUGNE: ['EASY', 'MEDIUM'] } }),
    // W47: more quest points, nothing new finished.
    f.questsSnapshot('2026-11-17T10:00:00.000Z', {
      ...A,
      questPoints: 13,
      entries: [
        { quest: 'COOKS_ASSISTANT', name: "Cook's Assistant", state: 'FINISHED' },
        { quest: 'DRAGON_SLAYER_I', name: 'Dragon Slayer I', state: 'FINISHED' },
        {
          quest: 'LAIR_OF_TARN_RAZORLOR',
          name: 'Lair of Tarn Razorlor',
          kind: 'MINIQUEST',
          state: 'FINISHED',
        },
      ],
    }),
  ];

  it('is null in the week of the first snapshot: that was finished before tracking', () => {
    expect(week(started(events), '2026-W45').quests).toBeNull();
  });

  it('lists what was first seen as finished in the week, and the quest points gained', () => {
    const run = started(events);
    const id = idOf(run);
    expect(week(run, '2026-W46').quests).toEqual({
      questPointsGained: 2,
      quests: [
        {
          accountId: id,
          quest: 'DRAGON_SLAYER_I',
          name: 'Dragon Slayer I',
          kind: 'QUEST',
          finishedAt: T2,
        },
        {
          accountId: id,
          quest: 'LAIR_OF_TARN_RAZORLOR',
          name: 'Lair of Tarn Razorlor',
          kind: 'MINIQUEST',
          finishedAt: T2,
        },
      ],
      diaries: [
        { accountId: id, region: 'ARDOUGNE', name: 'Ardougne', tier: 'MEDIUM', completedAt: T2 },
      ],
    });
  });

  it('has a section for quest points alone', () => {
    expect(week(started(events), '2026-W47').quests).toEqual({
      questPointsGained: 1,
      quests: [],
      diaries: [],
    });
  });

  it('never shows lost quest points as a negative gain', () => {
    const run = started([
      ...events,
      f.questsSnapshot('2026-11-24T10:00:00.000Z', { ...A, questPoints: 5, quests: {} }),
    ]);
    expect(week(run, '2026-W48').quests).toBeNull();
  });

  it('computes stored weeks again when an older first snapshot arrives late', () => {
    const run = started(events);
    expect(week(run, '2026-W45').quests).toBeNull();
    week(run, '2026-W46');
    expect(storedWeeks(run)).toEqual(['2026-W45', '2026-W46']);
    // Sent late: a snapshot from the day before, where nothing was finished.
    const T0 = '2026-11-02T10:00:00.000Z';
    ingest(run, [
      f.questsSnapshot(T0, { ...A, questPoints: 9, quests: { COOKS_ASSISTANT: 'NOT_STARTED' } }),
      f.diariesSnapshot(T0, { ...A, diaries: { ARDOUGNE: [] } }),
    ]);
    expect(storedWeeks(run)).toEqual([]);
    // What the old first snapshot had is now finished during tracking.
    expect(week(run, '2026-W45').quests).toMatchObject({
      questPointsGained: 1,
      quests: [{ quest: 'COOKS_ASSISTANT', finishedAt: T1 }],
      diaries: [{ region: 'ARDOUGNE', tier: 'EASY', completedAt: T1 }],
    });
    expect(week(run, '2026-W46').quests).toMatchObject({ questPointsGained: 2 });
  });

  it('lists every account’s quests for all and sums the points', () => {
    const run = started(events);
    ingest(run, [
      ...FIRST_B,
      f.questsSnapshot(T1, { ...B, questPoints: 1, quests: { DORICS_QUEST: 'NOT_STARTED' } }),
      f.questsSnapshot('2026-11-11T10:00:00.000Z', {
        ...B,
        questPoints: 2,
        quests: { DORICS_QUEST: 'FINISHED' },
      }),
    ]);
    expect(week(run, '2026-W46', 'all').quests).toMatchObject({
      questPointsGained: 3,
      // Newest first.
      quests: [
        { accountId: idOf(run, HASH_B), quest: 'DORICS_QUEST' },
        { accountId: idOf(run, HASH_A), quest: 'DRAGON_SLAYER_I' },
        { accountId: idOf(run, HASH_A), quest: 'LAIR_OF_TARN_RAZORLOR' },
      ],
    });
  });
});

describe('weekly: events and syncs in any order', () => {
  const WEEKS = ['2026-W45', '2026-W46', '2026-W47', '2026-W48'];

  /** Every week of the account without `computedAt`. */
  function readAll(run: TestRun): unknown {
    return WEEKS.map((key) => ({ ...week(run, key), computedAt: null }));
  }

  it('gives the same weeks whenever they are read, and after a rebuild', () => {
    const events: Event[] = [
      f.petDrop('2026-11-05T19:00:00.000Z', A),
      f.kc('2026-11-05T19:00:01.000Z', { killCount: 77, boss: 'Vorkath', ...A }),
      f.petDrop('2026-11-18T19:00:00.000Z', {
        ...A,
        pet: { itemId: 13262, name: 'Abyssal orphan' },
        source: { type: 'ACTIVITY', name: 'Abyssal Sire' },
      }),
      f.bankSnapshot('2026-11-04T10:00:00.000Z', { ...A, ...coins(1000) }),
      f.bankSnapshot('2026-11-13T10:00:00.000Z', { ...A, ...coins(9000) }),
      f.potionStorage('2026-11-19T10:00:00.000Z', A),
      f.questsSnapshot('2026-11-03T10:00:00.000Z', {
        ...A,
        questPoints: 1,
        quests: { Q_ONE: 'NOT_STARTED' },
      }),
      f.questsSnapshot('2026-11-12T10:00:00.000Z', {
        ...A,
        questPoints: 3,
        quests: { Q_ONE: 'FINISHED' },
      }),
      f.diariesSnapshot('2026-11-03T10:00:00.000Z', { ...A, diaries: { KANDARIN: [] } }),
      f.diariesSnapshot('2026-11-20T10:00:00.000Z', { ...A, diaries: { KANDARIN: ['EASY'] } }),
    ];
    // Applied in this order (the order they were stored in); events arrive anywhere between.
    const syncs: ClogStep[] = [
      { clog: { 4151: 1 }, fetchedAt: '2026-11-04T12:00:00.000Z' },
      { clog: { 4151: 1, 21992: 1, 22006: 1 }, fetchedAt: '2026-11-10T12:00:00.000Z' },
      { feed: [[22006, '2026-11-06T08:00:00.000Z']], fetchedAt: '2026-11-10T12:00:00.000Z' },
      { clog: { 4151: 1, 21992: 1, 22006: 1, 13262: 1 }, fetchedAt: '2026-11-21T12:00:00.000Z' },
      { feed: [[13262, '2026-11-18T19:00:03.000Z']], fetchedAt: '2026-11-21T12:00:00.000Z' },
    ];

    const plain = started();
    ingest(plain, events);
    for (const step of syncs) sync(plain, step);
    const expected = readAll(plain);
    const text = JSON.stringify(expected);
    for (const part of ['"pets":{', '"bank":{', '"collectionLog":{', '"quests":{']) {
      expect(text).toContain(part);
    }

    rebuildDerivedTables(plain.database.db, { now: () => NOW });
    expect(storedWeeks(plain)).toEqual([]);
    expect(readAll(plain), 'after a rebuild').toEqual(expected);

    for (const seed of [1, 2, 3, 4, 5]) {
      const random = seededRandom(seed);
      const steps: (ClogStep | Event)[] = [...syncs];
      for (const event of shuffled(events, random)) {
        steps.splice(Math.floor(random() * (steps.length + 1)), 0, event);
      }
      const run = started();
      for (const step of steps) {
        if ('eventId' in step) ingest(run, [step]);
        else sync(run, step);
        // Read (and so store) a week between the steps, like an open dashboard.
        week(run, WEEKS[Math.floor(random() * WEEKS.length)] ?? '2026-W45');
      }
      expect(readAll(run), `seed ${String(seed)}`).toEqual(expected);
    }
  });
});
