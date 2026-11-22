import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { rebuildClog, storeExternalSnapshot } from '../clog/project.js';
import { clogBody, feedBody } from '../clog/testing.js';
import { accountIds } from '../db/schema.js';
import { accountPetsSnapshot } from '../pets/merge.js';
import {
  emptyRun,
  eventFactory,
  expectOrderIndependent,
  ingestBatch,
  seededRandom,
  shuffled,
  sessionIdOf,
  TEST_ACCOUNT_HASH,
  TEST_NOW,
  type TestRun,
} from './testing.js';
import { FIRST_USER_ID } from '../users/users.js';

type Row = Record<string, unknown>;
interface Snapshot {
  drops: Row[];
  pets: Row[];
}

const HASH_B = '2222222222';
const at = (time: string) => `2026-11-08T${time}:00.000Z`;

/** The pets projection's tables, checked to be the same in any order and after a rebuild. */
function derived(...events: Parameters<typeof expectOrderIndependent>[0]): Snapshot {
  return expectOrderIndependent(events).pets as Snapshot;
}

describe('pets projection (chat only)', () => {
  it('stores pet-drop.json and shows the pet as unconfirmed', () => {
    const f = eventFactory();
    const event = f.fromFixture('pet-drop.json', '19:00');
    expect(derived(event)).toEqual({
      drops: [
        {
          userId: FIRST_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          eventId: event.eventId,
          sessionId: sessionIdOf(1),
          occurredAt: at('19:00'),
          message: 'FOLLOWED',
          petItemId: 21992,
          petName: 'Vorki',
          sourceType: 'ACTIVITY',
          sourceName: 'Vorkath',
        },
      ],
      pets: [
        {
          userId: FIRST_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          petItemId: 21992,
          name: 'Vorki',
          obtainedAt: at('19:00'),
          approximate: false,
          sourceType: 'ACTIVITY',
          sourceName: 'Vorkath',
          confirmed: false,
          origin: 'CHAT',
          eventId: event.eventId,
        },
      ],
    });
  });

  it('counts a backpack message as a new pet, with a skill source', () => {
    const f = eventFactory();
    const { pets } = derived(
      f.petDrop('19:00', {
        message: 'BACKPACK',
        pet: { itemId: 13322, name: 'Beaver' },
        source: { type: 'SKILL', name: 'WOODCUTTING' },
      }),
    );
    expect(pets).toMatchObject([
      { petItemId: 13322, name: 'Beaver', sourceType: 'SKILL', sourceName: 'WOODCUTTING' },
    ]);
  });

  it('never counts a duplicate message', () => {
    const f = eventFactory();
    const { drops, pets } = derived(f.petDrop('19:00', { message: 'DUPLICATE' }));
    expect(drops).toHaveLength(1);
    expect(pets).toEqual([]);
  });

  it('keeps a drop without a guessed pet, but shows no pet for it', () => {
    const f = eventFactory();
    const { drops, pets } = derived(f.petDrop('19:00', { pet: null, source: null }));
    expect(drops).toMatchObject([
      { petItemId: null, petName: null, sourceType: null, sourceName: null },
    ]);
    expect(pets).toEqual([]);
  });

  it('keeps the earliest drop when the same pet drops twice, and one row per pet', () => {
    const f = eventFactory();
    const first = f.petDrop('18:00');
    const { drops, pets } = derived(
      f.petDrop('20:00', { source: { type: 'ACTIVITY', name: 'Something else' } }),
      first,
      f.petDrop('21:00', { message: 'DUPLICATE' }),
    );
    expect(drops).toHaveLength(3);
    expect(pets).toMatchObject([
      { petItemId: 21992, obtainedAt: at('18:00'), sourceName: 'Vorkath', eventId: first.eventId },
    ]);
  });

  it('keeps accounts apart', () => {
    const f = eventFactory();
    const { pets } = derived(
      f.petDrop('19:00'),
      f.petDrop('19:30', { accountHash: HASH_B, sessionId: sessionIdOf(2) }),
    );
    expect(pets.map((pet) => [pet.accountHash, pet.obtainedAt])).toEqual([
      [TEST_ACCOUNT_HASH, at('19:00')],
      [HASH_B, at('19:30')],
    ]);
  });

  it.each(['pet-drop-backpack-skill.json', 'pet-drop-duplicate.json', 'pet-drop-minimal.json'])(
    'projects %s',
    (file) => {
      const f = eventFactory();
      expect(derived(f.fromFixture(file, '19:00')).drops).toHaveLength(1);
    },
  );
});

// --- With the collection log --------------------------------------------------
// Item 13262 (Abyssal orphan) and 21992 (Vorki) are on "All Pets" in the test
// collection log; 4151 (Abyssal whip) is not a pet.

type Step =
  | { events: ReturnType<ReturnType<typeof eventFactory>['petDrop']>[] }
  | { clog: Record<number, number>; fetchedAt: string }
  | { feed: [number, string][]; fetchedAt: string };

function accountId(run: TestRun, hash = TEST_ACCOUNT_HASH): number {
  const row = run.database.db
    .select({ id: accountIds.id })
    .from(accountIds)
    .where(eq(accountIds.accountHash, hash))
    .get();
  if (!row) throw new Error('No account');
  return row.id;
}

let hashCounter = 0;
function apply(run: TestRun, step: Step): void {
  if ('events' in step) {
    ingestBatch(run, step.events);
    return;
  }
  hashCounter += 1;
  const { db } = run.database;
  db.transaction((tx) => {
    storeExternalSnapshot(tx, {
      source: 'RUNEPROFILE',
      kind: 'clog' in step ? 'COLLECTION_LOG' : 'ACTIVITIES',
      accountId: accountId(run),
      fetchedAt: step.fetchedAt,
      contentHash: `sha256:${hashCounter.toString(16).padStart(64, '0')}`,
      body: 'clog' in step ? clogBody(step.clog) : feedBody(step.feed),
    });
  });
}

/** Runs the steps on a database that already knows the account. */
function runSteps(steps: readonly Step[]): TestRun {
  const run = emptyRun();
  // The fixed account ID, as the account's first event would create it.
  run.database.db
    .insert(accountIds)
    .values({ userId: FIRST_USER_ID, accountHash: TEST_ACCOUNT_HASH })
    .run();
  for (const step of steps) apply(run, step);
  expect(run.failed).toEqual([]);
  return run;
}

/** The account's pets without the account ID. */
function petsOf(run: TestRun) {
  return accountPetsSnapshot(run.database.db).map((pet) =>
    Object.fromEntries(Object.entries(pet).filter(([key]) => key !== 'accountId')),
  );
}

describe('pets from the collection log and chat', () => {
  const SYNC_1 = '2026-11-05T10:00:00.000Z';
  const SYNC_2 = '2026-11-09T10:00:00.000Z';

  it('takes pets from "All Pets" only, without a time at the first sync', () => {
    const run = runSteps([{ clog: { 13262: 1, 4151: 3 }, fetchedAt: SYNC_1 }]);
    expect(petsOf(run)).toEqual([
      {
        petItemId: 13262,
        name: 'Abyssal orphan',
        obtainedAt: null,
        approximate: false,
        sourceType: null,
        sourceName: null,
        confirmed: true,
        origin: 'CLOG',
        eventId: null,
      },
    ]);
  });

  it('gives a pet new in a later sync that sync’s time, approximate', () => {
    const run = runSteps([
      { clog: { 13262: 1 }, fetchedAt: SYNC_1 },
      { clog: { 13262: 1, 21992: 1 }, fetchedAt: SYNC_2 },
    ]);
    expect(petsOf(run)).toMatchObject([
      { petItemId: 13262, obtainedAt: null, approximate: false },
      { petItemId: 21992, obtainedAt: SYNC_2, approximate: true, origin: 'CLOG' },
    ]);
  });

  it('uses the activity feed’s time when it arrives later', () => {
    const feedTime = '2026-11-08T19:00:02.000Z';
    const run = runSteps([
      { clog: {}, fetchedAt: SYNC_1 },
      { clog: { 21992: 1 }, fetchedAt: SYNC_2 },
      { feed: [[21992, feedTime]], fetchedAt: SYNC_2 },
    ]);
    expect(petsOf(run)).toMatchObject([
      { petItemId: 21992, obtainedAt: feedTime, approximate: false, origin: 'CLOG' },
    ]);
  });

  it('merges a chat drop with the collection log: chat time and source, confirmed', () => {
    const f = eventFactory();
    const drop = f.petDrop('19:00');
    const expected = [
      {
        petItemId: 21992,
        name: 'Vorki',
        obtainedAt: at('19:00'),
        approximate: false,
        sourceType: 'ACTIVITY',
        sourceName: 'Vorkath',
        confirmed: true,
        origin: 'CHAT',
        eventId: drop.eventId,
      },
    ];
    // Chat first, then the collection log confirms it.
    const chatFirst = runSteps([
      { clog: {}, fetchedAt: SYNC_1 },
      { events: [drop] },
      { clog: { 21992: 1 }, fetchedAt: SYNC_2 },
    ]);
    expect(petsOf(chatFirst)).toEqual(expected);
    // The collection log first (the plugin sent an old batch late).
    const clogFirst = runSteps([
      { clog: {}, fetchedAt: SYNC_1 },
      { clog: { 21992: 1 }, fetchedAt: SYNC_2 },
      { events: [drop] },
    ]);
    expect(petsOf(clogFirst)).toEqual(expected);
  });

  it('is unconfirmed until the collection log has the pet', () => {
    const f = eventFactory();
    const run = runSteps([
      { clog: { 13262: 1 }, fetchedAt: SYNC_1 },
      { events: [f.petDrop('19:00')] },
    ]);
    expect(petsOf(run)).toMatchObject([
      { petItemId: 13262, confirmed: true, origin: 'CLOG' },
      { petItemId: 21992, confirmed: false, origin: 'CHAT' },
    ]);
  });

  it('uses the collection log’s name for a pet the plugin named differently', () => {
    const f = eventFactory();
    const run = runSteps([
      { events: [f.petDrop('19:00', { pet: { itemId: 21992, name: 'vorki (plugin)' } })] },
      { clog: { 21992: 1 }, fetchedAt: SYNC_2 },
    ]);
    expect(petsOf(run)).toMatchObject([{ name: 'Vorki' }]);
  });

  it('a duplicate message changes nothing for a collection log pet', () => {
    const f = eventFactory();
    const run = runSteps([
      { clog: { 21992: 1 }, fetchedAt: SYNC_1 },
      { events: [f.petDrop('19:00', { message: 'DUPLICATE' })] },
    ]);
    expect(petsOf(run)).toMatchObject([{ petItemId: 21992, obtainedAt: null, origin: 'CLOG' }]);
  });

  it('gives the same pets after a rebuild, and in any order of events', () => {
    const f = eventFactory();
    const drops = [
      f.petDrop('19:00'),
      f.petDrop('19:05', { message: 'DUPLICATE' }),
      f.petDrop('20:00', { pet: { itemId: 13322, name: 'Beaver' }, source: null }),
      f.petDrop('21:00', { pet: null }),
    ];
    const clog: Step[] = [
      { clog: { 13262: 1 }, fetchedAt: SYNC_1 },
      { clog: { 13262: 1, 21992: 1 }, fetchedAt: SYNC_2 },
      { feed: [[21992, '2026-11-08T19:00:02.000Z']], fetchedAt: SYNC_2 },
    ];
    const live = runSteps([...clog.slice(0, 1), { events: drops }, ...clog.slice(1)]);
    const expected = petsOf(live);
    expect(expected.map((pet) => [pet.petItemId, pet.origin, pet.confirmed])).toEqual([
      [13262, 'CLOG', true],
      [13322, 'CHAT', false],
      [21992, 'CHAT', true],
    ]);

    rebuildDerivedTables(live.database.db, { now: () => TEST_NOW });
    expect(petsOf(live)).toEqual(expected);

    // Only the collection log rebuilt: the chat pets stay.
    live.database.db.transaction((tx) => rebuildClog(tx));
    expect(petsOf(live)).toEqual(expected);

    const random = seededRandom(7);
    for (let round = 0; round < 10; round++) {
      // The collection log rows keep their order (they are applied in the
      // order they were stored); the events arrive anywhere between them.
      const steps: Step[] = [...clog];
      for (const drop of shuffled(drops, random)) {
        steps.splice(Math.floor(random() * (steps.length + 1)), 0, { events: [drop] });
      }
      expect(petsOf(runSteps(steps)), `round ${String(round)}`).toEqual(expected);
    }
  });
});
