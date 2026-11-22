import {
  eventSchema,
  type AccountType,
  type BankSnapshotPayload,
  type DiaryEntry,
  DIARY_TIERS,
  type Event,
  type EventOfType,
  type EventType,
  type LootEvent,
  type PbRecord,
  type PetDropPayload,
  type PotionStorageSnapshotPayload,
  type QuestEntry,
  type RaidSpecialLootPayload,
  type SessionEndEvent,
  type SessionHeartbeatEvent,
  type SkillValue,
  SKILLS,
  type XpSnapshotEvent,
} from '@fireside/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
import { expect } from 'vitest';
import { REPO_ROOT } from '../paths.js';
import { createApiKey, ownKey } from '../auth/api-keys.js';
import type { Database } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { storeEvents } from '../ingest/store.js';
import { testDatabase } from '../test-utils.js';
import { createUser, FIRST_USER_ID } from '../users/users.js';
import {
  projectEvents,
  rebuildProjections,
  type Projection,
  type ProjectionFailure,
} from './framework.js';
import { PROJECTIONS } from './index.js';

// Test helpers for projections. Not part of the build (see tsconfig.build.json).

export const TEST_ACCOUNT_HASH = '1234567890123456789';
/** The default clock for projections in tests. */
export const TEST_NOW = new Date('2026-11-09T12:00:00.000Z');
const NOW = TEST_NOW;

/** A valid UUIDv7 that differs by `n`. */
function uuid7(prefix: string, n: number): string {
  return `${prefix}-8a2b-7c3d-9e4f-${n.toString(16).padStart(12, '0')}`;
}

interface EventOptions {
  accountHash?: string;
  sessionId?: string;
}

/** A valid session ID (UUIDv7) that differs by `n`. Session 1 is the default. */
export function sessionIdOf(n: number): string {
  return uuid7('01933c40', n);
}

/** `'19:00'` → `'2026-11-08T19:00:00.000Z'`; full timestamps are kept. */
export function timeOf(time: string): string {
  return /^\d\d:\d\d$/.test(time) ? `2026-11-08T${time}:00.000Z` : time;
}

/**
 * Builds valid events with increasing, deterministic event IDs. `at` is a
 * UTC timestamp; a short form like `'19:00'` means 2026-11-08 at that time.
 */
export function eventFactory() {
  let counter = 0;

  function make<T extends EventType>(
    type: T,
    time: string,
    payload: object,
    { accountHash = TEST_ACCOUNT_HASH, sessionId = sessionIdOf(1) }: EventOptions,
  ): EventOfType<T> {
    counter += 1;
    const occurredAt = timeOf(time);
    return eventSchema.parse({
      eventId: uuid7('01933c4e', counter),
      schemaVersion: 1,
      type,
      accountHash,
      occurredAt,
      sessionId,
      payload,
    }) as EventOfType<T>;
  }

  return {
    sessionStart(
      at: string,
      {
        displayName = 'Test Main',
        accountType = 'IRONMAN',
        ...options
      }: EventOptions & { displayName?: string; accountType?: AccountType } = {},
    ) {
      return make(
        'session.start',
        at,
        { displayName, accountType, world: 420, pluginVersion: '0.1.0' },
        options,
      );
    },
    heartbeat(
      at: string,
      {
        payload = {},
        ...options
      }: EventOptions & { payload?: Partial<SessionHeartbeatEvent['payload']> } = {},
    ) {
      return make(
        'session.heartbeat',
        at,
        {
          regionId: 12342,
          world: 420,
          worldTypes: ['MEMBERS'],
          worldLocation: 'GERMANY',
          worldActivity: '',
          idle: false,
          ...payload,
        },
        options,
      );
    },
    /** A `session.afk` event sent at `to`, for the period `from`–`to`. */
    afk(from: string, to: string, options: EventOptions = {}) {
      return make('session.afk', to, { startedAt: timeOf(from), endedAt: timeOf(to) }, options);
    },
    sessionEnd(
      at: string,
      {
        reason = 'logout',
        ...options
      }: EventOptions & { reason?: SessionEndEvent['payload']['reason'] } = {},
    ) {
      return make('session.end', at, { reason }, options);
    },
    kc(
      at: string,
      {
        killCount = 1,
        boss = 'Vorkath',
        timeSeconds,
        personalBestSeconds,
        teamSize,
        ...options
      }: EventOptions & {
        killCount?: number;
        boss?: string;
        timeSeconds?: number;
        personalBestSeconds?: number;
        teamSize?: number;
      } = {},
    ) {
      return make(
        'kc',
        at,
        {
          boss,
          killCount,
          ...(timeSeconds === undefined ? {} : { timeSeconds }),
          ...(personalBestSeconds === undefined ? {} : { personalBestSeconds }),
          ...(teamSize === undefined ? {} : { teamSize }),
        },
        options,
      );
    },
    /** A `raid.special_loot` event; by default your own Osmumten's fang from ToA. */
    raidSpecialLoot(
      at: string,
      {
        raid = 'Tombs of Amascut',
        item = { itemId: 26219, name: "Osmumten's fang", quantity: 1, gePrice: 24_500_000 },
        recipient = 'SELF',
        teamSize,
        killCount,
        ...options
      }: EventOptions & Partial<RaidSpecialLootPayload> = {},
    ) {
      return make(
        'raid.special_loot',
        at,
        {
          raid,
          item,
          recipient,
          ...(teamSize === undefined ? {} : { teamSize }),
          ...(killCount === undefined ? {} : { killCount }),
        },
        options,
      );
    },
    /** A `pb.records` event; by default TFA's overall trio PB. */
    pbRecords(
      at: string,
      {
        boss = 'Fractured Archive',
        records = [{ scope: 'overall', teamSize: 3, seconds: 1088.4 }],
        ...options
      }: EventOptions & { boss?: string; records?: PbRecord[] } = {},
    ) {
      return make('pb.records', at, { boss, records }, options);
    },
    /**
     * A `bank.snapshot`. Without `items`: 1 000 coins in the main tab. Tab
     * sizes default to all 0 and the hash to one derived from the counter.
     */
    bankSnapshot(
      at: string,
      { payload = {}, ...options }: EventOptions & { payload?: Partial<BankSnapshotPayload> } = {},
    ) {
      return make(
        'bank.snapshot',
        at,
        {
          tabSizes: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          items: [
            {
              itemId: 995,
              name: 'Coins',
              quantity: 1000,
              placeholder: false,
              gePrice: 1,
              haPrice: 1,
            },
          ],
          inventory: [],
          equipment: [],
          contentHash: `sha256:${(counter + 1).toString(16).padStart(64, '0')}`,
          ...payload,
        },
        options,
      );
    },
    /** A `potion_storage.snapshot`. Without `potions`: 100 doses of a super combat potion. */
    potionStorage(
      at: string,
      {
        payload = {},
        ...options
      }: EventOptions & { payload?: Partial<PotionStorageSnapshotPayload> } = {},
    ) {
      return make(
        'potion_storage.snapshot',
        at,
        {
          potions: [
            {
              itemId: 12695,
              name: 'Super combat potion',
              doses: 100,
              itemDoses: 4,
              gePrice: 12_400,
              haPrice: 0,
            },
          ],
          contentHash: `sha256:${(counter + 1).toString(16).padStart(64, '0')}`,
          ...payload,
        },
        options,
      );
    },
    /** A `pet.drop`; by default a new Vorki from Vorkath that follows the player. */
    petDrop(
      at: string,
      {
        message = 'FOLLOWED',
        pet = { itemId: 21992, name: 'Vorki' },
        source = { type: 'ACTIVITY', name: 'Vorkath' },
        ...options
      }: EventOptions & {
        message?: PetDropPayload['message'];
        /** `null` leaves the guess out. */
        pet?: PetDropPayload['guessedPet'] | null;
        source?: PetDropPayload['guessedSource'] | null;
      } = {},
    ) {
      return make(
        'pet.drop',
        at,
        {
          message,
          ...(pet === null ? {} : { guessedPet: pet }),
          ...(source === null ? {} : { guessedSource: source }),
        },
        options,
      );
    },
    /** A `quests.snapshot`. `quests` maps a quest key to its state; names are made from the keys. */
    questsSnapshot(
      at: string,
      {
        questPoints = 0,
        quests = {},
        entries,
        ...options
      }: EventOptions & {
        questPoints?: number;
        quests?: Record<string, QuestEntry['state']>;
        /** Full entries, instead of `quests`. */
        entries?: QuestEntry[];
      } = {},
    ) {
      return make(
        'quests.snapshot',
        at,
        {
          questPoints,
          quests:
            entries ??
            Object.entries(quests).map(([quest, state]) => ({
              quest,
              name: `Name of ${quest}`,
              state,
            })),
        },
        options,
      );
    },
    /** A `diaries.snapshot`. `diaries` maps a region to its completed tiers; all four tiers are sent. */
    diariesSnapshot(
      at: string,
      {
        diaries = {},
        entries,
        ...options
      }: EventOptions & {
        diaries?: Record<string, readonly DiaryEntry['tier'][]>;
        /** Full entries, instead of `diaries`. */
        entries?: DiaryEntry[];
      } = {},
    ) {
      return make(
        'diaries.snapshot',
        at,
        {
          diaries:
            entries ??
            Object.entries(diaries).flatMap(([region, done]) =>
              DIARY_TIERS.map((tier) => ({ region, tier, completed: done.includes(tier) })),
            ),
        },
        options,
      );
    },
    /**
     * An `xp.snapshot` with every skill in `SKILLS` at 0 XP / level 1, except
     * the given ones (unknown extra skills allowed). A number is XP at level 1.
     */
    xpSnapshot(
      at: string,
      skills: Readonly<Record<string, number | SkillValue>> = {},
      {
        reason = 'interval',
        ...options
      }: EventOptions & { reason?: XpSnapshotEvent['payload']['reason'] } = {},
    ) {
      const all: Record<string, SkillValue> = Object.fromEntries(
        SKILLS.map((skill) => [skill, { xp: 0, level: 1 }]),
      );
      for (const [skill, value] of Object.entries(skills)) {
        all[skill] = typeof value === 'number' ? { xp: value, level: 1 } : value;
      }
      return make('xp.snapshot', at, { reason, skills: all }, options);
    },
    /**
     * A `loot` event from an NPC (or `source`) with one item worth `geValue`
     * in total, or with `items`.
     */
    loot(
      at: string,
      {
        geValue = 1000,
        source = { type: 'NPC', name: 'Vorkath' },
        killCount,
        items,
        ...options
      }: EventOptions & {
        geValue?: number;
        source?: LootEvent['payload']['source'];
        killCount?: number;
        items?: LootEvent['payload']['items'];
      } = {},
    ) {
      return make(
        'loot',
        at,
        {
          source,
          items: items ?? [
            { itemId: 995, name: 'Coins', quantity: geValue, gePrice: 1, haPrice: 0 },
          ],
          ...(killCount === undefined ? {} : { killCount }),
        },
        options,
      );
    },
    /**
     * An event built from `shared/fixtures/events/valid/<file>`, with a fresh
     * event ID and time (all fixtures share one event ID). `payload` fields
     * replace the fixture's top-level payload fields.
     */
    fromFixture(
      file: string,
      at: string,
      { payload = {}, ...options }: EventOptions & { payload?: object } = {},
    ): Event {
      const fixture = readFixture(file);
      return make(fixture.type, at, { ...fixture.payload, ...payload }, options);
    },
  };
}

const VALID_EVENT_FIXTURES = join(REPO_ROOT, 'shared', 'fixtures', 'events', 'valid');

interface Fixture {
  type: EventType;
  payload: object;
}

let fixtureCache: ReadonlyMap<string, Fixture> | undefined;

/** All valid event fixtures by file name, read and parsed once per test file. */
function validFixtures(): ReadonlyMap<string, Fixture> {
  fixtureCache ??= new Map(
    readdirSync(VALID_EVENT_FIXTURES)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => {
        const data = JSON.parse(readFileSync(join(VALID_EVENT_FIXTURES, file), 'utf8')) as unknown;
        // Valid fixtures pass the contract, so this only re-checks and narrows the type.
        const event = eventSchema.parse(data);
        return [file, { type: event.type, payload: event.payload }] as const;
      }),
  );
  return fixtureCache;
}

/** File names of all valid event fixtures of the given type, sorted. */
export function validFixtureFiles(type: EventType): string[] {
  return [...validFixtures()].filter(([, fixture]) => fixture.type === type).map(([file]) => file);
}

function readFixture(file: string): Fixture {
  const fixture = validFixtures().get(file);
  if (!fixture) throw new Error(`No valid event fixture ${file}`);
  return fixture;
}

/** The second user every test run has (user 1 is the admin from the migration). */
export const SECOND_USER_ID = 2;

export interface TestRun {
  database: Database;
  /** User 1's key. */
  apiKeyId: number;
  /** One key per user, by user ID. Without it, only user 1's events (`apiKeyId`) can be stored. */
  apiKeyIds?: ReadonlyMap<number, number>;
  failed: ProjectionFailure[];
}

/** A fresh database with two users and one API key each, nothing stored. */
export function emptyRun(): TestRun {
  const database = testDatabase();
  const second = createUser(database.db, 'second');
  if (second !== SECOND_USER_ID) throw new Error('second user got an unexpected ID');
  const apiKeyIds = new Map(
    [FIRST_USER_ID, SECOND_USER_ID].map((userId) => [
      userId,
      createApiKey(database.db, ownKey(userId), `Test ${String(userId)}`).id,
    ]),
  );
  return { database, apiKeyId: apiKeyIds.get(FIRST_USER_ID) ?? 0, apiKeyIds, failed: [] };
}

/** Owners of test events sent by another user than user 1. */
const eventOwners = new WeakMap<Event, number>();

/**
 * Marks `events` as sent by `userId` (with that user's key) in the harness:
 * `storeOnly`, `ingestBatch` and every `run*` helper. Unmarked events are user 1's.
 */
export function ownedBy<E extends Event>(userId: number, events: readonly E[]): E[] {
  for (const event of events) eventOwners.set(event, userId);
  return [...events];
}

function ownerOf(event: Event): number {
  return eventOwners.get(event) ?? FIRST_USER_ID;
}

/**
 * Stores events like the ingest route does, without projecting. Returns
 * stored IDs. Consecutive events of the same owner go in one call, with that
 * owner's key, as if each user's plugin sent its own batch.
 */
export function storeOnly(run: TestRun, events: readonly Event[]): string[] {
  const batches: { userId: number; events: Event[] }[] = [];
  for (const event of events) {
    const userId = ownerOf(event);
    const last = batches.at(-1);
    if (last?.userId === userId) last.events.push(event);
    else batches.push({ userId, events: [event] });
  }
  return batches.flatMap(({ userId, events: batch }) => {
    const apiKeyId =
      run.apiKeyIds?.get(userId) ?? (userId === FIRST_USER_ID ? run.apiKeyId : undefined);
    if (apiKeyId === undefined) throw new Error(`No test key for user ${String(userId)}`);
    return storeEvents(
      run.database.db,
      batch.map((event, index) => ({ index, event, raw: { ...event } })),
      { userId, apiKeyId, receivedAt: NOW.toISOString() },
    ).storedIds;
  });
}

/** Stores and projects one batch, the same way as `POST /api/v1/ingest`. */
export function ingestBatch(
  run: TestRun,
  events: readonly Event[],
  projections: readonly Projection[] = PROJECTIONS,
  now: Date = NOW,
): void {
  const ids = storeOnly(run, events);
  const { failed } = projectEvents(run.database.db, ids, { projections, now: () => now });
  run.failed.push(...failed);
}

/** Ingests `events` in the given order, split into the given batches (default: one per event). */
export function runIncremental(
  events: readonly Event[],
  {
    batchSizes,
    projections = PROJECTIONS,
  }: { batchSizes?: readonly number[]; projections?: readonly Projection[] } = {},
): TestRun {
  const run = emptyRun();
  let start = 0;
  for (const size of batchSizes ?? events.map(() => 1)) {
    ingestBatch(run, events.slice(start, start + size), projections);
    start += size;
  }
  if (start < events.length) ingestBatch(run, events.slice(start), projections);
  return run;
}

/** Stores all events, then builds the derived tables with a full rebuild. */
export function runRebuild(
  events: readonly Event[],
  projections: readonly Projection[] = PROJECTIONS,
  now: Date = NOW,
): TestRun {
  const run = emptyRun();
  storeOnly(run, events);
  run.failed.push(...rebuildProjections(run.database.db, { projections, now: () => now }).failed);
  return run;
}

/** All projections' snapshots, keyed by projection name. */
export function snapshotDerived(
  run: TestRun,
  projections: readonly Projection[] = PROJECTIONS,
): Record<string, unknown> {
  return Object.fromEntries(projections.map((p) => [p.name, p.snapshot(run.database.db)]));
}

function accountIds(run: TestRun): { userId: number; accountHash: string; id: number }[] {
  return run.database.db
    .select({ userId: accounts.userId, accountHash: accounts.accountHash, id: accounts.id })
    .from(accounts)
    .orderBy(asc(accounts.userId), asc(accounts.accountHash))
    .all();
}

/** Small seeded PRNG (mulberry32), so shuffles are repeatable. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/** Ingests `events` in a random order, in random batches, sometimes resending a batch. */
function runShuffled(
  events: readonly Event[],
  random: () => number,
  projections: readonly Projection[],
): TestRun {
  const order = shuffled(events, random);
  const run = emptyRun();
  const sent: Event[][] = [];
  for (let start = 0; start < order.length;) {
    const size = 1 + Math.floor(random() * 5);
    const batch = order.slice(start, start + size);
    ingestBatch(run, batch, projections);
    sent.push(batch);
    start += size;
    // The plugin may resend a batch it didn't get an answer for.
    if (random() < 0.3) {
      ingestBatch(run, sent[Math.floor(random() * sent.length)] ?? [], projections);
    }
  }
  return run;
}

/** A projection that throws for the given event IDs, run after the real ones. */
export function failingFor(eventIds: ReadonlySet<string>): Projection {
  return {
    name: 'test-failure',
    apply(_tx, event) {
      if (eventIds.has(event.eventId)) throw new Error('simulated failure');
    },
    reset: () => undefined,
    snapshot: () => null,
  };
}

/**
 * Checks that the derived tables are the same however the events arrive:
 * a full rebuild, one event at a time in the given order, one batch, and
 * `shuffles` random orders with random batch sizes and resent batches
 * (duplicates). Also rebuilds in place and checks that account IDs survive.
 *
 * Then repeats with a random subset of events failing: the result must be
 * the same in any order, and the same as if the failed events never existed.
 * Returns the expected snapshot (without failures) so tests can assert on it.
 */
export function expectOrderIndependent(
  events: readonly Event[],
  {
    shuffles = 25,
    seed = 1,
    projections = PROJECTIONS,
  }: { shuffles?: number; seed?: number; projections?: readonly Projection[] } = {},
): Record<string, unknown> {
  const random = seededRandom(seed);
  const snapshot = (run: TestRun) => snapshotDerived(run, projections);

  const rebuilt = runRebuild(events, projections);
  expect(rebuilt.failed).toEqual([]);
  const expected = snapshot(rebuilt);

  const check = (run: TestRun, label: string) => {
    expect(run.failed, label).toEqual([]);
    expect(snapshot(run), label).toEqual(expected);
  };

  check(runIncremental(events, { projections }), 'given order, one at a time');
  check(runIncremental(events, { batchSizes: [events.length], projections }), 'one batch');

  for (let round = 0; round < shuffles; round++) {
    const run = runShuffled(events, random, projections);
    check(run, `shuffle ${String(round)} (seed ${String(seed)})`);

    if (round === 0) {
      const idsBefore = accountIds(run);
      run.failed.push(
        ...rebuildProjections(run.database.db, { projections, now: () => NOW }).failed,
      );
      check(run, 'in-place rebuild');
      expect(accountIds(run), 'account IDs kept by rebuild').toEqual(idsBefore);
    }
  }

  // With failures: about a quarter of the events fail in the projection step.
  const failing = new Set(events.filter(() => random() < 0.25).map((event) => event.eventId));
  if (failing.size === 0 && events[0]) failing.add(events[0].eventId);
  const withFailures = [...projections, failingFor(failing)];
  const failedIds = (run: TestRun) => new Set(run.failed.map((failure) => failure.eventId));

  const withoutFailed = runRebuild(
    events.filter((event) => !failing.has(event.eventId)),
    projections,
  );
  const expectedWithFailures = snapshot(withoutFailed);
  const rebuiltWithFailures = runRebuild(events, withFailures);
  expect(failedIds(rebuiltWithFailures), 'rebuild with failures').toEqual(failing);
  expect(snapshot(rebuiltWithFailures), 'rebuild with failures').toEqual(expectedWithFailures);

  for (let round = 0; round < Math.max(1, Math.ceil(shuffles / 3)); round++) {
    const run = runShuffled(events, random, withFailures);
    const label = `shuffle ${String(round)} with failures (seed ${String(seed)})`;
    expect(failedIds(run), label).toEqual(failing);
    expect(snapshot(run), label).toEqual(expectedWithFailures);
  }
  return expected;
}
