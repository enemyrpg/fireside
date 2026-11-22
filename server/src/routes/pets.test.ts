import { errorResponseSchema, petsResponseSchema, type Event, type Pet } from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { storeExternalSnapshot } from '../clog/project.js';
import { clogBody } from '../clog/testing.js';
import { accounts } from '../db/schema.js';
import { PROJECTIONS } from '../projections/index.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  TEST_ACCOUNT_HASH,
  TEST_NOW,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';

// The pets of an account, from the collection log and from chat. Every response
// is also checked against its contract schema (order, one row per pet, KC only
// for an activity, XP only for a skill).

const HASH_B = '2222222222';
const B = { accountHash: HASH_B, sessionId: sessionIdOf(2) };
const at = (time: string) => `2026-11-08T${time}:00.000Z`;

let app: FastifyInstance | undefined;
let run: TestRun | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Ingests each batch in turn, so tests can send events out of order. */
function start(...batches: (readonly Event[])[]): void {
  run = emptyRun();
  for (const batch of batches) ingestBatch(run, batch, PROJECTIONS, TEST_NOW);
  expect(run.failed).toEqual([]);
  app = buildApp({ db: run.database, config: testConfig({}) });
}

function idOf(hash = TEST_ACCOUNT_HASH): number {
  const row = run?.database.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.accountHash, hash))
    .get();
  expect(row, hash).toBeDefined();
  return row?.id ?? 0;
}

let hashCounter = 0;
/** Stores a collection log for the account, as a sync would. */
function clog(quantities: Record<number, number>, fetchedAt: string, hash?: string): void {
  hashCounter += 1;
  const accountId = idOf(hash);
  run?.database.db.transaction((tx) => {
    storeExternalSnapshot(tx, {
      source: 'RUNEPROFILE',
      kind: 'COLLECTION_LOG',
      accountId,
      fetchedAt,
      contentHash: `sha256:${hashCounter.toString(16).padStart(64, '0')}`,
      body: clogBody(quantities),
    });
  });
}

async function pets(scope: number | 'all' = idOf()): Promise<Pet[]> {
  const url = `/api/v1/accounts/${String(scope)}/pets`;
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
  expect(response.statusCode, response.body).toBe(200);
  return petsResponseSchema.parse(response.json()).pets;
}

async function request(method: 'GET' | 'POST' | 'DELETE', url: string): Promise<[number, string]> {
  const response = await app!.inject({ method, url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
  return [response.statusCode, errorResponseSchema.parse(response.json()).error.code];
}

describe('GET /accounts/:accountId/pets', () => {
  it('is empty for an account without pets', async () => {
    const f = eventFactory();
    start([f.sessionStart('18:00')]);
    expect(await pets()).toEqual([]);
    expect(await pets('all')).toEqual([]);
  });

  it('gives a chat pet with the KC at the time, unconfirmed', async () => {
    const f = eventFactory();
    start([
      f.sessionStart('18:00'),
      f.kc('18:30', { killCount: 1203 }),
      f.kc('19:00', { killCount: 1204 }),
      f.petDrop('19:00'),
      f.kc('19:10', { killCount: 1205 }),
    ]);
    expect(await pets()).toEqual([
      {
        accountId: idOf(),
        itemId: 21992,
        name: 'Vorki',
        obtainedAt: at('19:00'),
        approximate: false,
        source: { type: 'ACTIVITY', name: 'Vorkath' },
        killCount: 1204,
        xp: null,
        confirmed: false,
        origin: 'CHAT',
      },
    ]);
  });

  it('counts a KC line up to two seconds after the pet line, not later', async () => {
    const f = eventFactory();
    start([
      f.sessionStart('18:00'),
      f.kc('18:30', { killCount: 10 }),
      f.petDrop('2026-11-08T19:00:00.000Z'),
      f.kc('2026-11-08T19:00:02.000Z', { killCount: 11 }),
      f.kc('2026-11-08T19:00:02.001Z', { killCount: 12 }),
    ]);
    expect((await pets())[0]?.killCount).toBe(11);
  });

  it('finds a KC event that arrives after the pet drop was stored', async () => {
    const f = eventFactory();
    const kc = f.kc('19:00', { killCount: 77 });
    start([f.sessionStart('18:00'), f.petDrop('19:00')], [kc]);
    expect((await pets())[0]?.killCount).toBe(77);
  });

  it('uses the KC of a loot event, and the normalized boss name', async () => {
    const f = eventFactory();
    start([
      f.sessionStart('18:00'),
      f.loot('19:00', { source: { type: 'NPC', name: 'Zulrah' }, killCount: 500 }),
      f.petDrop('19:00', {
        pet: { itemId: 12921, name: 'Pet snakeling' },
        source: { type: 'ACTIVITY', name: '  zulrah ' },
      }),
    ]);
    expect(await pets()).toMatchObject([{ name: 'Pet snakeling', killCount: 500 }]);
  });

  it('has no KC without KC data for the source, or of another account', async () => {
    const f = eventFactory();
    start([
      f.sessionStart('18:00'),
      f.sessionStart('18:00', { ...B, displayName: 'Other' }),
      f.kc('18:30', { killCount: 5, ...B }),
      f.kc('18:30', { killCount: 9, boss: 'Zulrah' }),
      f.petDrop('19:00'),
    ]);
    expect(await pets()).toMatchObject([{ source: { name: 'Vorkath' }, killCount: null }]);
  });

  it('gives the XP of a skill source from the last snapshot before the drop', async () => {
    const f = eventFactory();
    const beaver = {
      message: 'BACKPACK' as const,
      pet: { itemId: 13322, name: 'Beaver' },
      source: { type: 'SKILL' as const, name: 'WOODCUTTING' },
    };
    start([
      f.sessionStart('18:00'),
      f.xpSnapshot('18:50', { WOODCUTTING: 9_000_000 }),
      f.xpSnapshot('18:55', { WOODCUTTING: 9_840_112 }),
      f.petDrop('18:58', beaver),
      f.xpSnapshot('19:00', { WOODCUTTING: 9_900_000 }),
    ]);
    expect(await pets()).toMatchObject([
      { name: 'Beaver', source: beaver.source, xp: 9_840_112, killCount: null },
    ]);
  });

  it('uses the first XP snapshot after the drop when there is none before', async () => {
    const f = eventFactory();
    const source = { type: 'SKILL' as const, name: 'WOODCUTTING' };
    start([
      f.sessionStart('18:00'),
      f.petDrop('18:58', { source }),
      f.xpSnapshot('19:00', { WOODCUTTING: 123 }),
    ]);
    expect((await pets())[0]?.xp).toBe(123);
  });

  it('has no XP for a skill no snapshot has, and no KC or XP without a source', async () => {
    const f = eventFactory();
    start([
      f.sessionStart('18:00'),
      f.xpSnapshot('18:55', { WOODCUTTING: 5 }),
      f.petDrop('19:00', { source: { type: 'SKILL', name: 'NEW_SKILL' } }),
      f.petDrop('19:01', { pet: { itemId: 13322, name: 'Beaver' }, source: null }),
    ]);
    expect(await pets()).toMatchObject([
      { name: 'Beaver', source: null, killCount: null, xp: null },
      { name: 'Vorki', source: { type: 'SKILL', name: 'NEW_SKILL' }, killCount: null, xp: null },
    ]);
  });

  it('never shows a duplicate message or a drop without a guessed pet', async () => {
    const f = eventFactory();
    start([
      f.sessionStart('18:00'),
      f.petDrop('19:00', { message: 'DUPLICATE' }),
      f.petDrop('19:05', { pet: null }),
    ]);
    expect(await pets()).toEqual([]);
  });

  it('merges the collection log: confirmed chat pets, and pets only it knows', async () => {
    const f = eventFactory();
    start([f.sessionStart('18:00'), f.kc('19:00', { killCount: 1204 }), f.petDrop('19:00')]);
    clog({ 13262: 1 }, '2026-11-07T10:00:00.000Z');
    clog({ 13262: 1, 21992: 1, 4151: 2 }, '2026-11-09T10:00:00.000Z');
    expect(await pets()).toEqual([
      {
        accountId: idOf(),
        itemId: 21992,
        name: 'Vorki',
        obtainedAt: at('19:00'),
        approximate: false,
        source: { type: 'ACTIVITY', name: 'Vorkath' },
        killCount: 1204,
        xp: null,
        confirmed: true,
        origin: 'CHAT',
      },
      {
        accountId: idOf(),
        itemId: 13262,
        name: 'Abyssal orphan',
        obtainedAt: null,
        approximate: false,
        source: null,
        killCount: null,
        xp: null,
        confirmed: true,
        origin: 'CLOG',
      },
    ]);
  });

  it('marks the time of a pet first seen in a later sync as approximate', async () => {
    const f = eventFactory();
    start([f.sessionStart('18:00')]);
    clog({}, '2026-11-07T10:00:00.000Z');
    clog({ 21992: 1 }, '2026-11-09T10:00:00.000Z');
    expect(await pets()).toMatchObject([
      { itemId: 21992, obtainedAt: '2026-11-09T10:00:00.000Z', approximate: true, origin: 'CLOG' },
    ]);
  });

  it('lists every account for all, newest first and pets without a time last', async () => {
    const f = eventFactory();
    start([
      f.sessionStart('18:00'),
      f.sessionStart('18:00', { ...B, displayName: 'Other' }),
      f.petDrop('19:00'),
      f.petDrop('20:00', B),
      f.petDrop('18:30', { ...B, pet: { itemId: 13322, name: 'Beaver' }, source: null }),
    ]);
    clog({ 13262: 1 }, '2026-11-07T10:00:00.000Z');
    clog({ 13262: 1 }, '2026-11-07T10:00:00.000Z', HASH_B);
    const [a, b] = [idOf(), idOf(HASH_B)];
    expect((await pets('all')).map((pet) => [pet.accountId, pet.name, pet.obtainedAt])).toEqual([
      [b, 'Vorki', at('20:00')],
      [a, 'Vorki', at('19:00')],
      [b, 'Beaver', at('18:30')],
      [a, 'Abyssal orphan', null],
      [b, 'Abyssal orphan', null],
    ]);
    expect((await pets(b)).map((pet) => pet.name)).toEqual(['Vorki', 'Beaver', 'Abyssal orphan']);
  });

  it('gives the same answer after a rebuild', async () => {
    const f = eventFactory();
    start([f.sessionStart('18:00'), f.kc('19:00', { killCount: 3 }), f.petDrop('19:00')]);
    clog({ 13262: 1 }, '2026-11-07T10:00:00.000Z');
    clog({ 13262: 1, 21992: 1 }, '2026-11-09T10:00:00.000Z');
    const before = await pets('all');
    expect(before).toHaveLength(2);
    const response = await app!.inject({ method: 'POST', url: '/api/v1/admin/rebuild' }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
    expect(response.statusCode, response.body).toBe(200);
    expect(await pets('all')).toEqual(before);
  });

  it('answers 404 for an unknown account and 400 for bad input', async () => {
    const f = eventFactory();
    start([f.sessionStart('18:00')]);
    expect(await request('GET', '/api/v1/accounts/999/pets')).toEqual([404, 'NOT_FOUND']);
    expect(await request('GET', '/api/v1/accounts/abc/pets')).toEqual([400, 'VALIDATION_ERROR']);
    expect(await request('GET', `/api/v1/accounts/${String(idOf())}/pets?sort=az`)).toEqual([
      400,
      'VALIDATION_ERROR',
    ]);
  });

  it('has no way to add or remove a pet', async () => {
    const f = eventFactory();
    start([f.sessionStart('18:00'), f.petDrop('19:00')]);
    const base = `/api/v1/accounts/${String(idOf())}/pets`;
    expect((await request('POST', base))[0]).toBe(404);
    expect((await request('DELETE', base))[0]).toBe(404);
    expect((await request('DELETE', `${base}/21992`))[0]).toBe(404);
    expect((await request('GET', '/api/v1/pets'))[0]).toBe(404);
    expect(await pets()).toHaveLength(1);
  });
});
