import {
  errorResponseSchema,
  raidDropCreateRequestSchema,
  raidDropResponseSchema,
  raidSplitDefaultResponseSchema,
  raidSplitsResponseSchema,
  type Event,
  type RaidDrop,
  type RaidSplitsResponse,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { accounts, raidDropChoices, raidManualDrops, raidSplitDefaults } from '../db/schema.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  ownedBy,
  SECOND_USER_ID,
  sessionIdOf,
  type TestRun,
} from '../projections/testing.js';
import { createManualDrop } from '../raids/choices.js';
import { findTrackedDrop } from '../read/raid-splits.js';
import { testConfig } from '../test-utils.js';

// The raid loot split tracker. Small hand-built data; every expected number is
// worked out by hand in the comments. Europe/Oslo is UTC+1 in the data's winter
// months and UTC+2 in summer.

const NOW = new Date('2026-11-10T12:00:00.000Z');
const HASH_A = '1111111111';
const HASH_B = '2222222222';
const A = { accountHash: HASH_A, sessionId: sessionIdOf(1) };
const B = { accountHash: HASH_B, sessionId: sessionIdOf(2) };

const purple = (itemId: number, name: string, gePrice: number) => ({
  itemId,
  name,
  quantity: 1,
  gePrice,
});
const FANG = purple(26219, "Osmumten's fang", 24_000_000);
const MASK = purple(27226, 'Masori mask', 10_000_000);
const TBOW = purple(20997, 'Twisted bow', 1_000_000_000);
const MAUL = purple(21003, 'Elder maul', 30_000_000);
const SCYTHE = purple(22486, 'Scythe of vitur (uncharged)', 800_000_000);
const KODAI_ID = 21043;

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
    config: testConfig({ TZ: 'Europe/Oslo' }),
    dashboard: { now: () => NOW },
  });
  return app;
}

function inject(options: InjectOptions) {
  if (!app) throw new Error('start() sets app');
  return app.inject(options);
}

function idOf(hash: string): number {
  return (
    run?.database.db.select().from(accounts).where(eq(accounts.accountHash, hash)).get()?.id ?? 0
  );
}

const base = (scope: number | 'all') => `/api/v1/accounts/${String(scope)}/raids`;

async function splits(scope: number | 'all', query = ''): Promise<RaidSplitsResponse> {
  const response = await inject({ method: 'GET', url: `${base(scope)}/splits${query}` });
  expect(response.statusCode, response.body).toBe(200);
  return raidSplitsResponseSchema.parse(response.json());
}

async function setDefault(scope: number | 'all', mode: unknown, options: InjectOptions = {}) {
  return inject({
    method: 'PUT',
    url: `${base(scope)}/split-default`,
    payload: { mode },
    ...options,
  });
}

function patch(accountId: number, dropId: string, payload: object, options: InjectOptions = {}) {
  return inject({
    method: 'PATCH',
    url: `${base(accountId)}/drops/${dropId}`,
    payload,
    ...options,
  });
}

async function patched(accountId: number, dropId: string, payload: object): Promise<RaidDrop> {
  const response = await patch(accountId, dropId, payload);
  expect(response.statusCode, response.body).toBe(200);
  return raidDropResponseSchema.parse(response.json()).drop;
}

function add(accountId: number, payload: object, options: InjectOptions = {}) {
  return inject({ method: 'POST', url: `${base(accountId)}/drops`, payload, ...options });
}

async function added(accountId: number, payload: object): Promise<RaidDrop> {
  const response = await add(accountId, payload);
  expect(response.statusCode, response.body).toBe(201);
  return raidDropResponseSchema.parse(response.json()).drop;
}

function remove(accountId: number, dropId: string, options: InjectOptions = {}) {
  return inject({ method: 'DELETE', url: `${base(accountId)}/drops/${dropId}`, ...options });
}

async function expectError(
  response: ReturnType<typeof inject>,
  status: number,
  path?: string,
): Promise<void> {
  const result = await response;
  expect(result.statusCode, result.body).toBe(status);
  const { error } = errorResponseSchema.parse(result.json());
  if (path !== undefined) expect(error.details.map((detail) => detail.path)).toEqual([path]);
}

function dropOf(response: RaidSplitsResponse, name: string, accountId?: number): RaidDrop {
  const found = response.drops.items.filter(
    (drop) => drop.name === name && (accountId === undefined || drop.accountId === accountId),
  );
  const [drop] = found;
  if (!drop || found.length !== 1)
    throw new Error(`Expected one ${name}, got ${String(found.length)}`);
  return drop;
}

/** The special loot added by hand, per raid. */
const manualValues = (response: RaidSplitsResponse) =>
  Object.fromEntries(response.raids.map((raid) => [raid.raid, raid.manualSpecialLootValue]));
const NO_MANUAL = {
  'Chambers of Xeric': 0,
  'Theatre of Blood': 0,
  'Tombs of Amascut': 0,
  'The Fractured Archive': 0,
};

const raidShares = (response: RaidSplitsResponse) =>
  Object.fromEntries(
    response.raids.map((raid) => [raid.raid, [raid.fromOwnDrops, raid.fromTeammateDrops]]),
  );

/**
 * Account A (session 1) and B (session 2).
 * - A, 31 Oct 22:30 UTC (23:30 local, October): own fang 24M, party of 3.
 * - A, 31 Oct 23:30 UTC (00:30 local on 1 Nov): teammate's twisted bow 1B in CoX, party of 3.
 * - A, 8 Nov 19:00: own masori mask 10M in ToA, party size unknown.
 * - A, 8 Nov 20:00: teammate's scythe 800M in ToB: Hard Mode, party of 4.
 * - B, 8 Nov 19:00: own elder maul 30M in CoX, party of 2; teammate's fang 24M, party of 2.
 */
function events(f = eventFactory()): Event[] {
  return [
    f.sessionStart('2026-10-31T18:00:00.000Z', A),
    f.sessionStart('2026-11-08T18:00:00.000Z', { ...B, displayName: 'Test Alt' }),
    f.raidSpecialLoot('2026-10-31T22:30:00.000Z', { item: FANG, teamSize: 3, ...A }),
    f.raidSpecialLoot('2026-10-31T23:30:00.000Z', {
      raid: 'Chambers of Xeric',
      item: TBOW,
      recipient: 'TEAMMATE',
      teamSize: 3,
      ...A,
    }),
    f.raidSpecialLoot('19:00', { item: MASK, ...A }),
    f.raidSpecialLoot('20:00', {
      raid: 'Theatre of Blood: Hard Mode',
      item: SCYTHE,
      recipient: 'TEAMMATE',
      teamSize: 4,
      ...A,
    }),
    f.raidSpecialLoot('19:00', { raid: 'Chambers of Xeric', item: MAUL, teamSize: 2, ...B }),
    f.raidSpecialLoot('19:00', { item: FANG, recipient: 'TEAMMATE', teamSize: 2, ...B }),
  ];
}

describe('GET /accounts/:accountId/raids/splits', () => {
  it('splits every drop by its party size by default', async () => {
    start(events());
    const a = idOf(HASH_A);
    const response = await splits(a);

    expect(response.defaults).toEqual([{ accountId: a, mode: 'SPLIT' }]);
    // Own: fang 24M ÷ 3 = 8M; the mask has no party size and counts 0.
    // Teammates: bow 1B ÷ 3 = 333 333 333 (rounded down) + scythe 800M ÷ 4 = 200M.
    expect(response.total).toEqual({
      share: 541_333_333,
      fromOwnDrops: 8_000_000,
      fromTeammateDrops: 533_333_333,
    });
    expect(raidShares(response)).toEqual({
      'Chambers of Xeric': [0, 333_333_333],
      'Theatre of Blood': [0, 200_000_000],
      'Tombs of Amascut': [8_000_000, 0],
      'The Fractured Archive': [0, 0],
    });
    // The bow dropped 00:30 local time on 1 November, so it is in November.
    expect(response.months).toEqual([
      { month: '2026-10', share: 8_000_000 },
      { month: '2026-11', share: 533_333_333 },
    ]);

    expect(response.drops.items.map((drop) => drop.name)).toEqual([
      SCYTHE.name,
      MASK.name,
      TBOW.name,
      FANG.name,
    ]);
    expect(dropOf(response, TBOW.name)).toMatchObject({
      manual: false,
      recipient: 'TEAMMATE',
      gePriceEach: 1_000_000_000,
      geValue: 1_000_000_000,
      gePriceSource: 'DROP',
      gePriceAt: '2026-10-31T23:30:00.000Z',
      ownValue: null,
      value: 1_000_000_000,
      valueUnknown: false,
      mode: 'SPLIT',
      overridden: false,
      teamSize: 3,
      partySize: 3,
      partySizeOverridden: false,
      partySizeUnknown: false,
      share: 333_333_333,
      nickname: null,
      note: null,
      possibleDuplicate: false,
      duplicateOfDropId: null,
    });
  });

  it('shows a split without a party size as unknown and counts it 0', async () => {
    start(events());
    const a = idOf(HASH_A);
    const mask = dropOf(await splits(a), MASK.name);
    expect(mask).toMatchObject({
      teamSize: null,
      partySize: null,
      partySizeUnknown: true,
      share: null,
      value: 10_000_000,
    });

    // The user enters the size: 10M ÷ 5 = 2M, and own drops go from 8M to 10M.
    const set = await patched(a, mask.dropId, { partySize: 5 });
    expect(set).toMatchObject({
      teamSize: null,
      partySize: 5,
      partySizeOverridden: true,
      partySizeUnknown: false,
      share: 2_000_000,
    });
    expect((await splits(a)).total.fromOwnDrops).toBe(10_000_000);
  });

  it('counts a teammate drop 0 under FFA and own drops in full', async () => {
    start(events());
    const a = idOf(HASH_A);
    const response = await setDefault(a, 'FFA');
    expect(response.statusCode, response.body).toBe(200);
    expect(raidSplitDefaultResponseSchema.parse(response.json())).toEqual({
      accountId: a,
      mode: 'FFA',
    });

    const ffa = await splits(a);
    expect(ffa.defaults).toEqual([{ accountId: a, mode: 'FFA' }]);
    // Own: fang 24M + mask 10M (no party size needed). Teammates: 0.
    expect(ffa.total).toEqual({
      share: 34_000_000,
      fromOwnDrops: 34_000_000,
      fromTeammateDrops: 0,
    });
    expect(ffa.months).toEqual([
      { month: '2026-10', share: 24_000_000 },
      { month: '2026-11', share: 10_000_000 },
    ]);
    expect(dropOf(ffa, TBOW.name)).toMatchObject({ mode: 'FFA', overridden: false, share: 0 });
    expect(dropOf(ffa, SCYTHE.name).share).toBe(0);
    expect(dropOf(ffa, MASK.name)).toMatchObject({ partySizeUnknown: false, share: 10_000_000 });

    // Back to split.
    expect((await setDefault(a, 'SPLIT')).statusCode).toBe(200);
    expect((await splits(a)).total.share).toBe(541_333_333);
  });

  it('uses each account’s own default for all', async () => {
    start(events());
    const a = idOf(HASH_A);
    const b = idOf(HASH_B);
    await setDefault(a, 'FFA');

    const all = await splits('all');
    expect(all.defaults).toEqual([
      { accountId: a, mode: 'FFA' },
      { accountId: b, mode: 'SPLIT' },
    ]);
    // A (FFA): own 34M, teammates 0. B (split): maul 30M ÷ 2 = 15M own, fang 24M ÷ 2 = 12M.
    expect(all.total).toEqual({
      share: 61_000_000,
      fromOwnDrops: 49_000_000,
      fromTeammateDrops: 12_000_000,
    });
    expect(raidShares(all)).toEqual({
      'Chambers of Xeric': [15_000_000, 0],
      'Theatre of Blood': [0, 0],
      'Tombs of Amascut': [34_000_000, 12_000_000],
      'The Fractured Archive': [0, 0],
    });
    expect(dropOf(all, FANG.name, a)).toMatchObject({ mode: 'FFA', share: 24_000_000 });
    expect(dropOf(all, FANG.name, b)).toMatchObject({ mode: 'SPLIT', share: 12_000_000 });

    // B alone is unaffected by A's default.
    expect((await splits(b)).total.share).toBe(27_000_000);
  });

  it('lists every local month from the first drop to now, across a DST change', async () => {
    const f = eventFactory();
    // 31 March 22:30 UTC is 00:30 on 1 April in Oslo (UTC+2 since 29 March).
    start([
      f.sessionStart('2026-03-31T20:00:00.000Z', A),
      f.raidSpecialLoot('2026-03-31T22:30:00.000Z', { item: FANG, teamSize: 2, ...A }),
    ]);
    const { months, total } = await splits(idOf(HASH_A));
    expect(months.map((month) => month.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(months.map((month) => month.share)).toEqual([12_000_000, 0, 0, 0, 0, 0, 0, 0]);
    expect(total.share).toBe(12_000_000);
  });

  it('is empty without drops and 404 for an unknown account', async () => {
    const f = eventFactory();
    start([f.sessionStart('18:00', A)]);
    const response = await splits(idOf(HASH_A));
    expect(response.total).toEqual({ share: 0, fromOwnDrops: 0, fromTeammateDrops: 0 });
    expect(response.months).toEqual([]);
    expect(response.drops).toEqual({ items: [], nextCursor: null });
    await expectError(inject({ method: 'GET', url: `${base(999)}/splits` }), 404);
    await expectError(inject({ method: 'GET', url: `${base('all')}/splits?from=x` }), 400, 'query');
  });

  it('pages the drops with manual drops merged in, without gaps or duplicates', async () => {
    start(events());
    const a = idOf(HASH_A);
    // Between the mask (19:00) and the scythe (20:00) on 8 November.
    const manual = await added(a, {
      raid: 'Tombs of Amascut',
      itemId: FANG.itemId,
      occurredAt: '2026-11-08T19:30:00.000Z',
    });

    const everything = await splits('all');
    const order = everything.drops.items.map((drop) => drop.dropId);
    expect(order).toHaveLength(7);
    expect(order[1]).toBe(manual.dropId);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const page = await splits('all', query);
      expect(page.total).toEqual(everything.total);
      seen.push(...page.drops.items.map((drop) => drop.dropId));
      cursor = page.drops.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(order);

    await expectError(
      inject({ method: 'GET', url: `${base('all')}/splits?cursor=abc` }),
      400,
      'query.cursor',
    );
  });
});

describe('PATCH /accounts/:accountId/raids/drops/:dropId', () => {
  it('uses the user’s own value instead of the GE value', async () => {
    start(events());
    const a = idOf(HASH_A);
    const bow = dropOf(await splits(a), TBOW.name);

    // Sold for 900M: 900M ÷ 3 = 300M.
    const sold = await patched(a, bow.dropId, { ownValue: 900_000_000 });
    expect(sold).toMatchObject({
      geValue: 1_000_000_000,
      ownValue: 900_000_000,
      value: 900_000_000,
      share: 300_000_000,
    });
    // Teammates: 300M + scythe 200M.
    expect((await splits(a)).total.fromTeammateDrops).toBe(500_000_000);

    // Cleared: back to the GE value.
    const cleared = await patched(a, bow.dropId, { ownValue: null });
    expect(cleared).toMatchObject({ ownValue: null, value: 1_000_000_000, share: 333_333_333 });
    expect(run?.database.db.select().from(raidDropChoices).all()).toEqual([]);
  });

  it('lets a drop override the account default, both ways', async () => {
    start(events());
    const a = idOf(HASH_A);
    const before = await splits(a);
    const fang = dropOf(before, FANG.name);
    const bow = dropOf(before, TBOW.name);

    // Account split, fang FFA: the whole 24M instead of 8M.
    expect(await patched(a, fang.dropId, { mode: 'FFA' })).toMatchObject({
      mode: 'FFA',
      overridden: true,
      share: 24_000_000,
    });
    expect((await splits(a)).total.fromOwnDrops).toBe(24_000_000);

    // Account FFA, bow split: 333 333 333 although teammates' drops count 0 by default.
    await setDefault(a, 'FFA');
    await patched(a, bow.dropId, { mode: 'SPLIT' });
    const ffa = await splits(a);
    expect(dropOf(ffa, TBOW.name)).toMatchObject({
      mode: 'SPLIT',
      overridden: true,
      share: 333_333_333,
    });
    expect(dropOf(ffa, SCYTHE.name)).toMatchObject({ mode: 'FFA', overridden: false, share: 0 });
    // Own: fang 24M + mask 10M.
    expect(ffa.total).toEqual({
      share: 367_333_333,
      fromOwnDrops: 34_000_000,
      fromTeammateDrops: 333_333_333,
    });

    // `null` goes back to the account default.
    expect(await patched(a, bow.dropId, { mode: null })).toMatchObject({
      mode: 'FFA',
      overridden: false,
      share: 0,
    });
  });

  it('changes only the fields that are sent', async () => {
    start(events());
    const a = idOf(HASH_A);
    const scythe = dropOf(await splits(a), SCYTHE.name);
    await patched(a, scythe.dropId, { ownValue: 700_000_000, partySize: 5, note: ' sold fast ' });
    // 700M ÷ 5 = 140M.
    expect(await patched(a, scythe.dropId, { nickname: 'Nickname C' })).toMatchObject({
      ownValue: 700_000_000,
      teamSize: 4,
      partySize: 5,
      partySizeOverridden: true,
      note: 'sold fast',
      nickname: 'Nickname C',
      share: 140_000_000,
    });
    // An empty body changes nothing.
    expect(await patched(a, scythe.dropId, {})).toMatchObject({
      nickname: 'Nickname C',
      partySize: 5,
    });
    // The plugin's party size is back when the user's is cleared: 700M ÷ 4.
    expect(await patched(a, scythe.dropId, { partySize: null })).toMatchObject({
      partySize: 4,
      partySizeOverridden: false,
      share: 175_000_000,
    });
  });

  it('trims nicknames, clears them when empty and refuses bad ones', async () => {
    start(events());
    const a = idOf(HASH_A);
    const before = await splits(a);
    const bow = dropOf(before, TBOW.name);
    const fang = dropOf(before, FANG.name);

    expect((await patched(a, bow.dropId, { nickname: '  Nickname A  ' })).nickname).toBe(
      'Nickname A',
    );
    expect((await patched(a, bow.dropId, { nickname: 'x'.repeat(30) })).nickname).toHaveLength(30);
    await expectError(patch(a, bow.dropId, { nickname: 'x'.repeat(31) }), 400, 'body.nickname');
    await expectError(patch(a, bow.dropId, { nickname: 'a‮b' }), 400, 'body.nickname');
    await expectError(patch(a, bow.dropId, { note: 'x'.repeat(201) }), 400, 'body.note');
    await expectError(patch(a, bow.dropId, { note: 'line\nbreak' }), 400, 'body.note');
    expect(dropOf(await splits(a), TBOW.name).nickname).toBe('x'.repeat(30));
    expect((await patched(a, bow.dropId, { nickname: '   ' })).nickname).toBeNull();

    // Your own drop has no one to nickname; a note is fine.
    await expectError(patch(a, fang.dropId, { nickname: 'Me' }), 400, 'body.nickname');
    expect(await patched(a, fang.dropId, { nickname: null, note: 'kept it' })).toMatchObject({
      nickname: null,
      note: 'kept it',
    });
  });

  it('validates the body, the drop and the account', async () => {
    start(events());
    const a = idOf(HASH_A);
    const b = idOf(HASH_B);
    const bow = dropOf(await splits(a), TBOW.name);

    await expectError(patch(a, bow.dropId, { partySize: 0 }), 400, 'body.partySize');
    await expectError(patch(a, bow.dropId, { partySize: 101 }), 400, 'body.partySize');
    await expectError(patch(a, bow.dropId, { ownValue: -1 }), 400, 'body.ownValue');
    await expectError(patch(a, bow.dropId, { ownValue: 1.5 }), 400, 'body.ownValue');
    await expectError(patch(a, bow.dropId, { mode: 'HALF' }), 400, 'body.mode');
    await expectError(patch(a, bow.dropId, { recipient: 'SELF' }), 400, 'body');
    await expectError(patch(a, 'not-a-drop', { partySize: 2 }), 400, 'params.dropId');
    // Another account's drop, an unknown drop and an unknown account.
    await expectError(patch(b, bow.dropId, { partySize: 2 }), 404);
    await expectError(patch(a, '01933c4e-8a2b-7c3d-9e4f-00000000ffff', { partySize: 2 }), 404);
    await expectError(patch(999, bow.dropId, { partySize: 2 }), 404);
    await expectError(
      patch(a, bow.dropId, { partySize: 2 }, { headers: { 'content-type': 'text/plain' } }),
      415,
    );
    expect(run?.database.db.select().from(raidDropChoices).all()).toEqual([]);
  });

  it('keeps the choices when a chest purple later gets its own event', async () => {
    const f = eventFactory();
    const chest = f.loot('19:00', {
      source: { type: 'EVENT', name: 'Tombs of Amascut' },
      items: [
        { itemId: 995, name: 'Coins', quantity: 50_000, gePrice: 1, haPrice: 1 },
        { ...FANG, haPrice: 0 },
      ],
      ...A,
    });
    const special = f.raidSpecialLoot('19:00', { item: FANG, teamSize: 3, ...A });
    start([f.sessionStart('18:00', A), chest]);
    const a = idOf(HASH_A);

    // Only the chest is known: the drop is keyed by the loot event and the item's position.
    const chestOnly = dropOf(await splits(a), FANG.name);
    expect(chestOnly.dropId).toBe(`${chest.eventId}.1`);
    expect(chestOnly).toMatchObject({ recipient: 'SELF', teamSize: null, share: null });
    await patched(a, chestOnly.dropId, { ownValue: 21_000_000, mode: 'FFA', note: 'first' });

    // The `SELF` event arrives: the same drop, now keyed by that event.
    if (!run) throw new Error('start() sets run');
    ingestBatch(run, [special]);
    const response = await splits(a);
    expect(response.drops.items).toHaveLength(1);
    expect(dropOf(response, FANG.name)).toMatchObject({
      dropId: special.eventId,
      ownValue: 21_000_000,
      mode: 'FFA',
      overridden: true,
      note: 'first',
      teamSize: 3,
      share: 21_000_000,
    });

    // The old ID still reaches it, and a change keeps the earlier choices.
    const changed = await patched(a, chestOnly.dropId, { mode: null });
    // Split again: 21M ÷ 3.
    expect(changed).toMatchObject({
      dropId: special.eventId,
      ownValue: 21_000_000,
      note: 'first',
      share: 7_000_000,
    });
    expect(run.database.db.select().from(raidDropChoices).all()).toHaveLength(1);
  });
});

describe('PUT /accounts/:accountId/raids/split-default', () => {
  it('validates the mode and the account', async () => {
    start(events());
    const a = idOf(HASH_A);
    await expectError(setDefault(a, 'HALF'), 400, 'body.mode');
    await expectError(setDefault('all', 'FFA'), 400, 'params.accountId');
    await expectError(setDefault(999, 'FFA'), 404);
    expect(run?.database.db.select().from(raidSplitDefaults).all()).toEqual([]);
  });
});

describe('manual drops', () => {
  it('prices a manual drop from the latest price in the user’s own data', async () => {
    start(events());
    const a = idOf(HASH_A);
    // A's teammate bow (1B on 31 October) is the only price for a twisted bow.
    const bow = await added(a, {
      raid: 'Chambers of Xeric Challenge Mode',
      itemId: TBOW.itemId,
      occurredAt: '2026-11-09T20:00:00.000Z',
      partySize: 4,
      nickname: ' Nickname A ',
    });
    // 1B ÷ 4 = 250M.
    expect(bow).toMatchObject({
      manual: true,
      accountId: a,
      sessionId: null,
      raid: 'Chambers of Xeric: Challenge Mode',
      raidGroup: 'Chambers of Xeric',
      name: 'Twisted bow',
      quantity: 1,
      recipient: 'TEAMMATE',
      gePriceEach: 1_000_000_000,
      geValue: 1_000_000_000,
      gePriceSource: 'SPECIAL_LOOT',
      gePriceAt: '2026-10-31T23:30:00.000Z',
      value: 1_000_000_000,
      valueUnknown: false,
      teamSize: null,
      partySize: 4,
      share: 250_000_000,
      nickname: 'Nickname A',
      killCount: null,
    });
    const response = await splits(a);
    // Teammates: 533 333 333 + 250M.
    expect(response.total.fromTeammateDrops).toBe(783_333_333);
    expect(raidShares(response)['Chambers of Xeric']).toEqual([0, 583_333_333]);
    expect(response.months.at(-1)).toEqual({ month: '2026-11', share: 783_333_333 });
  });

  it('takes the latest price at or before the drop, else the newest', async () => {
    const f = eventFactory();
    const bankItem = (gePrice: number) => ({
      itemId: MAUL.itemId,
      name: MAUL.name,
      quantity: 1,
      placeholder: false as const,
      gePrice,
      haPrice: 0,
    });
    start([
      ...events(f),
      // An elder maul as normal loot on 9 November at 29M, and in the bank at 31M at 10:00 on 10 November.
      f.loot('2026-11-09T10:00:00.000Z', {
        source: { type: 'NPC', name: 'Vorkath' },
        items: [{ ...MAUL, gePrice: 29_000_000, haPrice: 0 }],
        ...A,
      }),
      f.bankSnapshot('2026-11-10T10:00:00.000Z', {
        payload: { items: [bankItem(31_000_000)] },
        ...A,
      }),
    ]);
    const a = idOf(HASH_A);
    const maul = (occurredAt: string) =>
      added(a, { raid: 'Chambers of Xeric', itemId: MAUL.itemId, occurredAt });

    // B's own maul was 30M on 8 November 19:00.
    expect(await maul('2026-11-08T23:00:00.000Z')).toMatchObject({
      gePriceEach: 30_000_000,
      gePriceSource: 'SPECIAL_LOOT',
      gePriceAt: '2026-11-08T19:00:00.000Z',
    });
    expect(await maul('2026-11-09T12:00:00.000Z')).toMatchObject({
      gePriceEach: 29_000_000,
      gePriceSource: 'LOOT',
      gePriceAt: '2026-11-09T10:00:00.000Z',
    });
    expect(await maul('2026-11-10T11:00:00.000Z')).toMatchObject({
      gePriceEach: 31_000_000,
      geValue: 31_000_000,
      gePriceSource: 'BANK',
      gePriceAt: '2026-11-10T10:00:00.000Z',
    });
    // Before every price: the newest one.
    expect(await maul('2026-11-01T12:00:00.000Z')).toMatchObject({
      gePriceEach: 31_000_000,
      gePriceSource: 'BANK',
    });
  });

  it('never prices a manual drop from another user’s loot, purples or bank', async () => {
    const f = eventFactory();
    const bankItem = (itemId: number, name: string, gePrice: number) => ({
      itemId,
      name,
      quantity: 1,
      placeholder: false as const,
      gePrice,
      haPrice: 0,
    });
    // The other user has the same account hash as A, in its own session.
    const OTHER = { accountHash: HASH_A, sessionId: sessionIdOf(9) };
    start([
      // User 1: A's teammate bow (purple, 1B), a maul as loot and a kodai in the bank.
      ...events(f),
      f.loot('2026-11-09T10:00:00.000Z', {
        source: { type: 'NPC', name: 'Vorkath' },
        items: [{ ...MAUL, gePrice: 29_000_000, haPrice: 0 }],
        ...A,
      }),
      f.bankSnapshot('2026-11-10T10:00:00.000Z', {
        payload: { items: [bankItem(KODAI_ID, 'Kodai insignia', 40_000_000)] },
        ...A,
      }),
      // User 2: only a login, and later a maul of its own at 5M.
      ...ownedBy(SECOND_USER_ID, [
        f.sessionStart('2026-11-09T09:00:00.000Z', { ...OTHER, displayName: 'Friend' }),
      ]),
    ]);
    const db = run?.database.db;
    if (!db) throw new Error('start() sets run');
    const friendAccount =
      db.select().from(accounts).where(eq(accounts.userId, SECOND_USER_ID)).get()?.id ?? 0;
    const a = idOf(HASH_A);
    expect(friendAccount).not.toBe(a);

    // The dashboard acts as user 1 (local mode), so user 2's drops are added
    // through the same code the route uses; over HTTP user 2's account is 404.
    expect(
      (
        await add(friendAccount, {
          raid: 'Chambers of Xeric',
          itemId: TBOW.itemId,
          occurredAt: '2026-11-10T11:00:00.000Z',
        })
      ).statusCode,
    ).toBe(404);
    const drop = async (accountId: number, raid: string, itemId: number) => {
      const payload = { raid, itemId, occurredAt: '2026-11-10T11:00:00.000Z' };
      if (accountId !== friendAccount) return added(accountId, payload);
      const body = raidDropCreateRequestSchema.parse(payload);
      const id = createManualDrop(db, accountId, body, NOW);
      const found = findTrackedDrop(db, accountId, id);
      if (!found) throw new Error('The drop was just added');
      return found.drop;
    };
    const unpriced = {
      gePriceEach: null,
      gePriceSource: null,
      gePriceAt: null,
      geValue: null,
      valueUnknown: true,
    };
    // User 2 gets no price from user 1's purple, loot or bank...
    expect(await drop(friendAccount, 'Chambers of Xeric', TBOW.itemId)).toMatchObject(unpriced);
    expect(await drop(friendAccount, 'Chambers of Xeric', MAUL.itemId)).toMatchObject(unpriced);
    expect(await drop(friendAccount, 'Chambers of Xeric', KODAI_ID)).toMatchObject(unpriced);
    // ...while user 1 does, from each source.
    expect(await drop(a, 'Chambers of Xeric', TBOW.itemId)).toMatchObject({
      gePriceSource: 'SPECIAL_LOOT',
    });
    expect(await drop(a, 'Chambers of Xeric', MAUL.itemId)).toMatchObject({
      gePriceEach: 29_000_000,
      gePriceSource: 'LOOT',
    });
    expect(await drop(a, 'Chambers of Xeric', KODAI_ID)).toMatchObject({
      gePriceEach: 40_000_000,
      gePriceSource: 'BANK',
    });

    // User 2's own price is used, even though user 1's is newer.
    if (!run) throw new Error('start() sets run');
    ingestBatch(
      run,
      ownedBy(SECOND_USER_ID, [
        f.loot('2026-11-09T09:30:00.000Z', {
          source: { type: 'NPC', name: 'Vorkath' },
          items: [{ ...MAUL, gePrice: 5_000_000, haPrice: 0 }],
          ...OTHER,
        }),
      ]),
    );
    expect(await drop(friendAccount, 'Chambers of Xeric', MAUL.itemId)).toMatchObject({
      gePriceEach: 5_000_000,
      gePriceSource: 'LOOT',
      gePriceAt: '2026-11-09T09:30:00.000Z',
    });
  });

  it('counts a manual drop without any price 0 until the user gives a value', async () => {
    start(events());
    const a = idOf(HASH_A);
    const kodai = await added(a, {
      raid: 'Chambers of Xeric',
      itemId: KODAI_ID,
      occurredAt: '2026-11-09T20:00:00.000Z',
      partySize: 4,
    });
    expect(kodai).toMatchObject({
      name: 'Kodai insignia',
      gePriceEach: null,
      geValue: null,
      gePriceSource: null,
      gePriceAt: null,
      ownValue: null,
      value: null,
      valueUnknown: true,
      partySizeUnknown: false,
      share: null,
    });
    expect((await splits(a)).total.share).toBe(541_333_333);

    // 80M ÷ 4 = 20M.
    expect(await patched(a, kodai.dropId, { ownValue: 80_000_000 })).toMatchObject({
      geValue: null,
      value: 80_000_000,
      valueUnknown: false,
      share: 20_000_000,
    });
    expect((await splits(a)).total.share).toBe(561_333_333);

    // Under FFA a teammate's drop is 0 whether or not the value is known.
    expect(await patched(a, kodai.dropId, { ownValue: null, mode: 'FFA' })).toMatchObject({
      valueUnknown: true,
      share: 0,
    });
  });

  it('keeps the price from when the drop was added, also when new data arrives', async () => {
    const f = eventFactory();
    start(events(f));
    if (!run) throw new Error('start() sets run');
    const a = idOf(HASH_A);
    const bow = await added(a, {
      raid: 'Chambers of Xeric',
      itemId: TBOW.itemId,
      occurredAt: '2026-11-09T20:00:00.000Z',
      partySize: 4,
    });
    const kodai = await added(a, {
      raid: 'Chambers of Xeric',
      itemId: KODAI_ID,
      occurredAt: '2026-11-09T20:00:00.000Z',
      partySize: 4,
    });
    expect(bow).toMatchObject({ gePriceEach: 1_000_000_000, share: 250_000_000 });
    expect(kodai).toMatchObject({ gePriceEach: null, valueUnknown: true, share: null });
    const before = await splits(a);

    // Newer prices for both items arrive, dated before the drops: a bow at
    // 1.2B and a kodai insignia at 90M, as teammates' purples for B.
    ingestBatch(run, [
      f.raidSpecialLoot('2026-11-09T19:00:00.000Z', {
        raid: 'Chambers of Xeric',
        item: { ...TBOW, gePrice: 1_200_000_000 },
        recipient: 'TEAMMATE',
        teamSize: 2,
        ...B,
      }),
      f.raidSpecialLoot('2026-11-09T19:00:00.000Z', {
        raid: 'Chambers of Xeric',
        item: purple(KODAI_ID, 'Kodai insignia', 90_000_000),
        recipient: 'TEAMMATE',
        teamSize: 2,
        ...B,
      }),
    ]);
    expect(run.failed).toEqual([]);

    // A's drops and sums are exactly as before; the kodai is still unknown.
    expect(await splits(a)).toEqual(before);
    // Also after a rebuild and after an unrelated change to the drop.
    expect((await inject({ method: 'POST', url: '/api/v1/admin/rebuild' })).statusCode).toBe(200);
    expect(await splits(a)).toEqual(before);
    expect(await patched(a, kodai.dropId, { note: 'ask later' })).toMatchObject({
      gePriceEach: null,
      geValue: null,
      valueUnknown: true,
      share: null,
    });
    expect(await patched(a, bow.dropId, { partySize: 5 })).toMatchObject({
      gePriceEach: 1_000_000_000,
      gePriceSource: 'SPECIAL_LOOT',
      gePriceAt: '2026-10-31T23:30:00.000Z',
      share: 200_000_000,
    });

    // Only the user's own value ends "value unknown": 80M ÷ 4.
    expect(await patched(a, kodai.dropId, { ownValue: 80_000_000 })).toMatchObject({
      geValue: null,
      valueUnknown: false,
      share: 20_000_000,
    });

    // A drop added now sees the newer price.
    const later = await added(a, {
      raid: 'Chambers of Xeric',
      itemId: TBOW.itemId,
      occurredAt: '2026-11-09T21:00:00.000Z',
    });
    expect(later).toMatchObject({
      gePriceEach: 1_200_000_000,
      gePriceAt: '2026-11-09T19:00:00.000Z',
    });
  });

  it('lists months that add up to the total, also from the earliest allowed date', async () => {
    start(events());
    const a = idOf(HASH_A);
    const sum = (response: RaidSplitsResponse) =>
      response.months.reduce((total, month) => total + month.share, 0);

    const before = await splits(a);
    expect(sum(before)).toBe(before.total.share);
    expect(sum(await splits('all'))).toBe((await splits('all')).total.share);

    // The first instant of launch day: 01:00 local time on 22 February 2013.
    // The bow's stored price is A's 1B: 1B ÷ 4 = 250M.
    const oldest = await added(a, {
      raid: 'Chambers of Xeric',
      itemId: TBOW.itemId,
      occurredAt: '2013-02-22T00:00:00.000Z',
      partySize: 4,
    });
    expect(oldest.share).toBe(250_000_000);

    const after = await splits(a);
    // February 2013 to November 2026: 11 + 12 × 12 + 11 = 166 months, oldest first.
    expect(after.months).toHaveLength(166);
    expect(after.months[0]).toEqual({ month: '2013-02', share: 250_000_000 });
    expect(after.months.at(-2)).toEqual({ month: '2026-10', share: 8_000_000 });
    expect(after.months.at(-1)).toEqual({ month: '2026-11', share: 533_333_333 });
    expect(after.months.slice(1, -2).every((month) => month.share === 0)).toBe(true);
    expect(new Set(after.months.map((month) => month.month)).size).toBe(166);
    expect(after.total.share).toBe(791_333_333);
    expect(sum(after)).toBe(after.total.share);

    // Still true after changes that move shares between drops and modes.
    await setDefault(a, 'FFA');
    const ffa = await splits(a);
    expect(ffa.total.share).toBe(34_000_000);
    expect(sum(ffa)).toBe(ffa.total.share);
    const all = await splits('all', '?limit=1');
    expect(sum(all)).toBe(all.total.share);
  });

  it('flags a manual drop that may duplicate a detected teammate purple', async () => {
    start(events());
    const a = idOf(HASH_A);
    const b = idOf(HASH_B);
    const detected = dropOf(await splits(a), SCYTHE.name);
    const scythe = (accountId: number, occurredAt: string, raid = 'Theatre of Blood') =>
      added(accountId, { raid, itemId: SCYTHE.itemId, occurredAt });

    // A's detected teammate scythe dropped at 20:00 in ToB: Hard Mode.
    // Another mode of the same raid, exactly two hours later.
    const close = await scythe(a, '2026-11-08T22:00:00.000Z');
    expect(close).toMatchObject({ possibleDuplicate: true, duplicateOfDropId: detected.dropId });
    // Before the detected drop counts too.
    expect((await scythe(a, '2026-11-08T18:30:00.000Z')).possibleDuplicate).toBe(true);
    // One millisecond too late, and another account.
    expect(await scythe(a, '2026-11-08T22:00:00.001Z')).toMatchObject({
      possibleDuplicate: false,
      duplicateOfDropId: null,
    });
    expect((await scythe(b, '2026-11-08T20:00:00.000Z')).possibleDuplicate).toBe(false);
    // Another item in the same raid, and an own drop of the same item, don't count.
    const rapier = await added(a, {
      raid: 'Theatre of Blood',
      itemId: 22324,
      occurredAt: '2026-11-08T20:00:00.000Z',
    });
    expect(rapier.possibleDuplicate).toBe(false);
    const fang = await added(a, {
      raid: 'Tombs of Amascut',
      itemId: FANG.itemId,
      occurredAt: '2026-10-31T22:30:00.000Z',
    });
    expect(fang.possibleDuplicate).toBe(false);

    // Nothing is merged or hidden: both drops are listed and counted.
    const response = await splits(a);
    expect(response.drops.items.filter((drop) => drop.name === SCYTHE.name)).toHaveLength(4);
    expect(response.drops.items.find((drop) => drop.dropId === detected.dropId)).toMatchObject({
      possibleDuplicate: false,
    });
  });

  it('adds an own purple and counts it under Split and FFA', async () => {
    start(events());
    const a = idOf(HASH_A);
    const before = await splits(a);

    // From before the plugin: no fang price that early, so the newest one is
    // used (B's teammate fang on 8 Nov, 24M).
    const own = await added(a, {
      raid: 'Tombs of Amascut',
      itemId: FANG.itemId,
      occurredAt: '2019-03-01T20:00:00.000Z',
      recipient: 'SELF',
    });
    expect(own).toMatchObject({
      manual: true,
      recipient: 'SELF',
      sessionId: null,
      teamSize: null,
      geValue: 24_000_000,
      gePriceSource: 'SPECIAL_LOOT',
      gePriceAt: '2026-11-08T19:00:00.000Z',
      value: 24_000_000,
      mode: 'SPLIT',
      partySizeUnknown: true,
      share: null,
      nickname: null,
    });
    // A split without a party size counts 0, but the purple is special loot.
    let response = await splits(a);
    expect(response.total).toEqual(before.total);
    expect(response.months[0]).toEqual({ month: '2019-03', share: 0 });
    expect(manualValues(response)).toEqual({ ...NO_MANUAL, 'Tombs of Amascut': 24_000_000 });

    // Split: 24M ÷ 4 = 6M, as your own drop.
    expect(await patched(a, own.dropId, { partySize: 4 })).toMatchObject({ share: 6_000_000 });
    response = await splits(a);
    expect(response.total).toEqual({
      share: before.total.share + 6_000_000,
      fromOwnDrops: before.total.fromOwnDrops + 6_000_000,
      fromTeammateDrops: before.total.fromTeammateDrops,
    });
    expect(response.months[0]).toEqual({ month: '2019-03', share: 6_000_000 });
    const toa = (splitsResponse: RaidSplitsResponse) =>
      splitsResponse.raids.find((raid) => raid.raid === 'Tombs of Amascut');
    expect(toa(response)?.fromOwnDrops).toBe((toa(before)?.fromOwnDrops ?? 0) + 6_000_000);

    // "Sold for" decides the value and the share (20M ÷ 4 = 5M), never the
    // special loot value, which stays the GE value.
    expect(await patched(a, own.dropId, { ownValue: 20_000_000 })).toMatchObject({
      value: 20_000_000,
      geValue: 24_000_000,
      share: 5_000_000,
    });
    expect(manualValues(await splits(a))).toEqual({ ...NO_MANUAL, 'Tombs of Amascut': 24_000_000 });

    // FFA: the whole value of an own drop, whatever the party size.
    expect(await patched(a, own.dropId, { mode: 'FFA' })).toMatchObject({ share: 20_000_000 });
    expect((await splits(a)).total.fromOwnDrops).toBe(before.total.fromOwnDrops + 20_000_000);
    await setDefault(a, 'FFA');
    expect(await patched(a, own.dropId, { mode: null, ownValue: null })).toMatchObject({
      mode: 'FFA',
      overridden: false,
      share: 24_000_000,
    });
  });

  it('sums the special loot added by hand per raid at GE value', async () => {
    start(events());
    const a = idOf(HASH_A);
    const b = idOf(HASH_B);
    expect(manualValues(await splits('all'))).toEqual(NO_MANUAL);

    // A teammate's manual drop never counts as special loot.
    await added(a, {
      raid: 'Chambers of Xeric',
      itemId: TBOW.itemId,
      occurredAt: '2026-11-01T20:00:00.000Z',
    });
    expect(manualValues(await splits(a))).toEqual(NO_MANUAL);

    // Own: a twisted bow at 1B and, in Challenge Mode, a kodai without any price.
    await added(a, {
      raid: 'Chambers of Xeric',
      itemId: TBOW.itemId,
      occurredAt: '2026-11-01T20:00:00.000Z',
      recipient: 'SELF',
    });
    const kodai = await added(a, {
      raid: 'Chambers of Xeric Challenge Mode',
      itemId: KODAI_ID,
      occurredAt: '2026-11-02T20:00:00.000Z',
      recipient: 'SELF',
    });
    expect(kodai).toMatchObject({ raidGroup: 'Chambers of Xeric', valueUnknown: true });
    // No GE price and no "sold for": 0.
    expect(manualValues(await splits(a))).toEqual({
      ...NO_MANUAL,
      'Chambers of Xeric': 1_000_000_000,
    });
    // Without a GE price, "sold for" is the only value there is.
    await patched(a, kodai.dropId, { ownValue: 90_000_000 });
    expect(manualValues(await splits(a))).toEqual({
      ...NO_MANUAL,
      'Chambers of Xeric': 1_090_000_000,
    });

    // Per account, and together for `all`.
    await added(b, {
      raid: 'Theatre of Blood',
      itemId: SCYTHE.itemId,
      occurredAt: '2026-11-03T20:00:00.000Z',
      recipient: 'SELF',
    });
    expect(manualValues(await splits(b))).toEqual({
      ...NO_MANUAL,
      'Theatre of Blood': 800_000_000,
    });
    expect(manualValues(await splits('all'))).toEqual({
      ...NO_MANUAL,
      'Chambers of Xeric': 1_090_000_000,
      'Theatre of Blood': 800_000_000,
    });
  });

  it('leaves loot, sessions, the week and `raids` as the plugin recorded them', async () => {
    const f = eventFactory();
    start([
      ...events(f),
      f.loot('2026-11-08T19:00:00.000Z', {
        source: { type: 'EVENT', name: 'Tombs of Amascut' },
        items: [{ ...MASK, haPrice: 0 }],
        ...A,
      }),
    ]);
    const a = idOf(HASH_A);
    const urls = [
      base(a),
      `/api/v1/accounts/${String(a)}/loot`,
      `/api/v1/accounts/${String(a)}/loot/drops`,
      `/api/v1/accounts/${String(a)}/sessions`,
      `/api/v1/accounts/${String(a)}/weekly?week=2026-W45`,
      `/api/v1/accounts/all/loot`,
    ];
    const read = async () => {
      const bodies: unknown[] = [];
      for (const url of urls) {
        const response = await inject({ method: 'GET', url });
        expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
        bodies.push(response.json());
      }
      return bodies;
    };
    const before = await read();
    const sharesBefore = await splits(a);

    await added(a, {
      raid: 'Tombs of Amascut',
      itemId: MASK.itemId,
      occurredAt: '2026-11-08T12:00:00.000Z',
      recipient: 'SELF',
      partySize: 2,
    });
    expect(await read()).toEqual(before);
    // Only the tracker counts it: 10M ÷ 2.
    expect((await splits(a)).total.fromOwnDrops).toBe(sharesBefore.total.fromOwnDrops + 5_000_000);
  });

  it('takes a nickname for a teammate’s drop only', async () => {
    start(events());
    const a = idOf(HASH_A);
    const body = {
      raid: 'Theatre of Blood',
      itemId: SCYTHE.itemId,
      occurredAt: '2026-11-01T20:00:00.000Z',
    };
    // Without a recipient it is a teammate's drop, as before 1.23.0.
    expect(await added(a, { ...body, nickname: 'Nickname A' })).toMatchObject({
      recipient: 'TEAMMATE',
      nickname: 'Nickname A',
    });
    expect(await added(a, { ...body, recipient: 'TEAMMATE' })).toMatchObject({
      recipient: 'TEAMMATE',
    });

    await expectError(
      add(a, { ...body, recipient: 'SELF', nickname: 'Nickname A' }),
      400,
      'body.nickname',
    );
    expect(run?.database.db.select().from(raidManualDrops).all()).toHaveLength(2);
    // An empty nickname is no nickname.
    const own = await added(a, { ...body, recipient: 'SELF', nickname: '  ', note: 'old drop' });
    expect(own).toMatchObject({ recipient: 'SELF', nickname: null, note: 'old drop' });
    await expectError(patch(a, own.dropId, { nickname: 'Nickname A' }), 400, 'body.nickname');
    expect(await patched(a, own.dropId, { note: 'older drop' })).toMatchObject({
      recipient: 'SELF',
      nickname: null,
      note: 'older drop',
    });
  });

  it('flags an own manual drop that may duplicate a detected own purple or a chest purple', async () => {
    const f = eventFactory();
    // 8 Nov: own fang (event) at 19:00, an elder maul only in the CoX chest
    // at 20:00, and a teammate's scythe at 20:00.
    const fang = f.raidSpecialLoot('19:00', { item: FANG, teamSize: 3, ...A });
    const chest = f.loot('20:00', {
      source: { type: 'EVENT', name: 'Chambers of Xeric' },
      items: [
        { itemId: 995, name: 'Coins', quantity: 50_000, gePrice: 1, haPrice: 1 },
        { ...MAUL, haPrice: 0 },
      ],
      ...A,
    });
    const scythe = f.raidSpecialLoot('20:00', {
      raid: 'Theatre of Blood',
      item: SCYTHE,
      recipient: 'TEAMMATE',
      teamSize: 4,
      ...A,
    });
    start([f.sessionStart('18:00', A), fang, chest, scythe]);
    const a = idOf(HASH_A);
    const manual = (raid: string, itemId: number, occurredAt: string, recipient?: string) =>
      added(a, { raid, itemId, occurredAt, ...(recipient ? { recipient } : {}) });
    const none = { possibleDuplicate: false, duplicateOfDropId: null };

    // The detected own fang, two hours either side (another mode of the raid).
    expect(
      await manual(
        'Tombs of Amascut: Expert Mode',
        FANG.itemId,
        '2026-11-08T21:00:00.000Z',
        'SELF',
      ),
    ).toMatchObject({ possibleDuplicate: true, duplicateOfDropId: fang.eventId });
    expect(
      await manual('Tombs of Amascut', FANG.itemId, '2026-11-08T17:00:00.000Z', 'SELF'),
    ).toMatchObject({ possibleDuplicate: true, duplicateOfDropId: fang.eventId });
    expect(
      await manual('Tombs of Amascut', FANG.itemId, '2026-11-08T16:59:59.999Z', 'SELF'),
    ).toMatchObject(none);

    // The maul that is only known from the chest.
    expect(
      await manual('Chambers of Xeric', MAUL.itemId, '2026-11-08T19:30:00.000Z', 'SELF'),
    ).toMatchObject({ possibleDuplicate: true, duplicateOfDropId: `${chest.eventId}.1` });

    // Only drops with the same recipient: an own manual scythe is not the
    // teammate's detected one, and a teammate's manual fang or maul is not yours.
    expect(
      await manual('Theatre of Blood', SCYTHE.itemId, '2026-11-08T20:00:00.000Z', 'SELF'),
    ).toMatchObject(none);
    expect(await manual('Tombs of Amascut', FANG.itemId, '2026-11-08T19:00:00.000Z')).toMatchObject(
      none,
    );
    expect(
      await manual('Chambers of Xeric', MAUL.itemId, '2026-11-08T20:00:00.000Z', 'TEAMMATE'),
    ).toMatchObject(none);
    // A teammate's manual scythe still is, as before.
    expect(
      await manual('Theatre of Blood', SCYTHE.itemId, '2026-11-08T20:00:00.000Z'),
    ).toMatchObject({ possibleDuplicate: true, duplicateOfDropId: scythe.eventId });

    // Only a hint: every drop is listed and counted, and detected drops are never flagged.
    const response = await splits(a);
    expect(response.drops.items).toHaveLength(11);
    expect(
      response.drops.items.filter((drop) => !drop.manual).map((drop) => drop.possibleDuplicate),
    ).toEqual([false, false, false]);
  });

  it('reads a manual drop stored before 1.23.0 as a teammate’s', async () => {
    start(events());
    const a = idOf(HASH_A);
    // As migration 0014 stored it: no recipient given.
    run?.database.sqlite
      .prepare(
        `insert into raid_manual_drops
           (id, account_id, occurred_at, raid, raid_group, item_id, item_name, nickname, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '0193a000-0000-7abc-8def-000000000009',
        a,
        '2026-11-01T20:00:00.000Z',
        'Theatre of Blood',
        'Theatre of Blood',
        SCYTHE.itemId,
        SCYTHE.name,
        'Nickname A',
        NOW.toISOString(),
        NOW.toISOString(),
      );
    const response = await splits(a);
    expect(
      response.drops.items.find((drop) => drop.dropId === '0193a000-0000-7abc-8def-000000000009'),
    ).toMatchObject({ manual: true, recipient: 'TEAMMATE', nickname: 'Nickname A' });
    expect(manualValues(response)).toEqual(NO_MANUAL);
  });

  it('validates a new drop', async () => {
    start(events());
    const a = idOf(HASH_A);
    const valid = {
      raid: 'Theatre of Blood',
      itemId: SCYTHE.itemId,
      occurredAt: '2026-11-08T20:00:00.000Z',
    };
    await expectError(add(a, { ...valid, raid: 'Vorkath' }), 400, 'body.raid');
    // A twisted bow is not from the Theatre of Blood.
    await expectError(add(a, { ...valid, itemId: TBOW.itemId }), 400, 'body.itemId');
    await expectError(
      add(a, { ...valid, occurredAt: '2026-11-10T12:00:00.001Z' }),
      400,
      'body.occurredAt',
    );
    await expectError(add(a, { ...valid, occurredAt: '2026-11-08' }), 400, 'body.occurredAt');
    await expectError(add(a, { ...valid, partySize: 0 }), 400, 'body.partySize');
    await expectError(add(a, { ...valid, nickname: 'x'.repeat(31) }), 400, 'body.nickname');
    await expectError(add(a, { ...valid, recipient: 'PLAYER' }), 400, 'body.recipient');
    // A nickname is only for a teammate's drop.
    await expectError(
      add(a, { ...valid, recipient: 'SELF', nickname: 'Nickname A' }),
      400,
      'body.nickname',
    );
    await expectError(add(a, { raid: valid.raid }), 400);
    await expectError(add(999, valid), 404);
    await expectError(
      inject({ method: 'POST', url: `${base('all')}/drops`, payload: valid }),
      400,
      'params.accountId',
    );
    expect(run?.database.db.select().from(raidManualDrops).all()).toEqual([]);

    // Nothing dropped before Old School launched on 22 February 2013.
    await expectError(
      add(a, { ...valid, occurredAt: '2013-02-21T23:59:59.999Z' }),
      400,
      'body.occurredAt',
    );
    await expectError(
      add(a, { ...valid, occurredAt: '1970-01-01T00:00:00.000Z' }),
      400,
      'body.occurredAt',
    );
    expect(run?.database.db.select().from(raidManualDrops).all()).toEqual([]);

    // Exactly now is allowed.
    expect((await add(a, { ...valid, occurredAt: NOW.toISOString() })).statusCode).toBe(201);
  });

  it('deletes manual drops only', async () => {
    start(events());
    const a = idOf(HASH_A);
    const b = idOf(HASH_B);
    const detected = dropOf(await splits(a), SCYTHE.name);
    const manual = await added(a, {
      raid: 'Theatre of Blood',
      itemId: SCYTHE.itemId,
      occurredAt: '2026-11-01T20:00:00.000Z',
    });

    await expectError(remove(a, detected.dropId), 400, 'params.dropId');
    await expectError(remove(b, manual.dropId), 404);
    expect((await remove(a, manual.dropId)).statusCode).toBe(204);
    await expectError(remove(a, manual.dropId), 404);
    expect((await splits(a)).drops.items).toHaveLength(4);
  });

  it('never writes a manual drop to the raw events', async () => {
    start(events());
    const a = idOf(HASH_A);
    const before = run?.database.sqlite.prepare('select count(*) as n from events').get();
    await added(a, {
      raid: 'Theatre of Blood',
      itemId: SCYTHE.itemId,
      occurredAt: '2026-11-01T20:00:00.000Z',
      nickname: 'Nickname A',
    });
    expect(run?.database.sqlite.prepare('select count(*) as n from events').get()).toEqual(before);
  });
});

describe('rebuild', () => {
  it('keeps the default, the choices and the manual drops', async () => {
    start(events());
    const a = idOf(HASH_A);
    const b = idOf(HASH_B);
    const first = await splits('all');
    await setDefault(b, 'FFA');
    await patched(a, dropOf(first, TBOW.name).dropId, {
      ownValue: 900_000_000,
      nickname: 'Nickname A',
      note: 'sold on day two',
    });
    await patched(a, dropOf(first, MASK.name).dropId, { partySize: 5, mode: 'SPLIT' });
    await patched(a, dropOf(first, FANG.name, a).dropId, { mode: 'FFA' });
    await added(a, {
      raid: 'Theatre of Blood',
      itemId: SCYTHE.itemId,
      occurredAt: '2026-11-08T21:00:00.000Z',
      partySize: 4,
      nickname: 'Nickname B',
    });
    // An own purple from before the plugin, at the newest mask price (10M).
    const own = await added(a, {
      raid: 'Tombs of Amascut',
      itemId: MASK.itemId,
      occurredAt: '2019-03-01T20:00:00.000Z',
      recipient: 'SELF',
      partySize: 2,
      note: 'before the plugin',
    });

    const before = await splits('all');
    // A: fang FFA 24M + mask 10M ÷ 5 = 2M + manual mask 10M ÷ 2 = 5M own;
    // bow 300M + scythe 200M + manual scythe 200M.
    // B (FFA): maul 30M own, teammate's fang 0.
    expect(before.total).toEqual({
      share: 761_000_000,
      fromOwnDrops: 61_000_000,
      fromTeammateDrops: 700_000_000,
    });
    expect(before.drops.items.find((drop) => drop.dropId === own.dropId)).toMatchObject({
      manual: true,
      recipient: 'SELF',
      geValue: 10_000_000,
      share: 5_000_000,
    });
    expect(manualValues(before)).toEqual({ ...NO_MANUAL, 'Tombs of Amascut': 10_000_000 });
    const page = await splits('all', '?limit=3');

    const rebuilt = await inject({ method: 'POST', url: '/api/v1/admin/rebuild' });
    expect(rebuilt.statusCode, rebuilt.body).toBe(200);
    expect(rebuilt.json()).toMatchObject({ failed: 0 });

    expect(await splits('all')).toEqual(before);
    expect(idOf(HASH_A)).toBe(a);
    const next = await splits('all', `?limit=3&cursor=${String(page.drops.nextCursor)}`);
    expect(next.drops.items).toEqual(before.drops.items.slice(3, 6));
  });
});

describe('access', () => {
  it.each(['https://evil.example', 'http://localhost:5555', 'null'])(
    'refuses every change from Origin %s (CSRF)',
    async (origin) => {
      start(events());
      const a = idOf(HASH_A);
      const bow = dropOf(await splits(a), TBOW.name);
      const manual = await added(a, {
        raid: 'Theatre of Blood',
        itemId: SCYTHE.itemId,
        occurredAt: '2026-11-01T20:00:00.000Z',
      });
      const before = await splits(a);
      const headers = { host: 'localhost:4000', origin };

      await expectError(setDefault(a, 'FFA', { headers }), 403);
      await expectError(patch(a, bow.dropId, { ownValue: 1 }, { headers }), 403);
      await expectError(
        add(
          a,
          { raid: 'Theatre of Blood', itemId: SCYTHE.itemId, occurredAt: NOW.toISOString() },
          {
            headers,
          },
        ),
        403,
      );
      await expectError(remove(a, manual.dropId, { headers }), 403);
      expect(await splits(a)).toEqual(before);
    },
  );

  it('accepts changes with a matching Origin and refuses remote requests', async () => {
    start(events());
    const a = idOf(HASH_A);
    const headers = { host: 'localhost:4000', origin: 'http://localhost:4000' };
    expect((await setDefault(a, 'FFA', { headers })).statusCode).toBe(200);
    await expectError(setDefault(a, 'SPLIT', { remoteAddress: '192.168.1.20' }), 403);
    await expectError(
      inject({ method: 'GET', url: `${base(a)}/splits`, remoteAddress: '192.168.1.20' }),
      403,
    );
    expect((await splits(a)).defaults).toEqual([{ accountId: a, mode: 'FFA' }]);
  });
});
