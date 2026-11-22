import { accountsResponseSchema, petsResponseSchema, type Pet } from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a seed run: pets from the seed's collection logs and its
// `pet.drop` events, in every state the trophy case shows, and a rebuild
// gives the same answer.

const OPTIONS = {
  seed: 3,
  accounts: 3,
  months: 2,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

describe('pets on seed data', () => {
  let app: FastifyInstance;
  let database: Database;
  let ids: number[] = [];

  beforeAll(async () => {
    const fixture = await loadSeedFixture(OPTIONS, { TZ: OPTIONS.timeZone });
    const { config, result } = fixture;
    database = fixture.database;
    expect(result.rejected).toEqual([]);
    expect(result.failed).toEqual([]);
    app = buildApp({ db: database, config, dashboard: { now: () => OPTIONS.until } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    ids = accountsResponseSchema.parse(response.json()).accounts.map((account) => account.id);
  }, SEED_FIXTURE_HOOK_TIMEOUT_MS);
  afterAll(() => app.close());

  async function pets(scope: number | 'all'): Promise<Pet[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/accounts/${String(scope)}/pets`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return petsResponseSchema.parse(response.json()).pets;
  }
  const named = (list: Pet[], name: string) => list.find((pet) => pet.name === name);

  it('Seed Main has Vorki from chat with the KC at the time, confirmed, counted once', async () => {
    const main = await pets(ids[0] ?? 0);
    expect(main.map((pet) => pet.name).sort()).toEqual([
      'Baby mole',
      'Heron',
      'Pet snakeling',
      'Phoenix',
      'Vorki',
    ]);
    const vorki = named(main, 'Vorki');
    expect(vorki).toMatchObject({
      origin: 'CHAT',
      confirmed: true,
      approximate: false,
      source: { type: 'ACTIVITY', name: 'Vorkath' },
      xp: null,
    });
    expect(vorki?.killCount).toBeGreaterThan(0);
    // The newest dated pet is first; the rest are only in the collection log.
    for (const pet of main.filter((p) => p.name !== 'Vorki')) {
      expect(pet).toMatchObject({ origin: 'CLOG', confirmed: true, source: null, killCount: null });
    }
  });

  it('Seed Iron has a confirmed skilling pet with XP and an unconfirmed one', async () => {
    const iron = await pets(ids[1] ?? 0);
    expect(named(iron, 'Rock golem')).toMatchObject({
      origin: 'CHAT',
      confirmed: true,
      source: { type: 'SKILL', name: 'MINING' },
      killCount: null,
    });
    expect(named(iron, 'Rock golem')?.xp).toBeGreaterThan(0);
    expect(named(iron, 'Beaver')).toMatchObject({ origin: 'CHAT', confirmed: false });
    expect(named(iron, 'Tiny tempor')).toMatchObject({ origin: 'CLOG', confirmed: true });
    expect(iron).toHaveLength(3);
  });

  it('the third account has no pets, and all lists every account’s', async () => {
    expect(await pets(ids[2] ?? 0)).toEqual([]);
    const all = await pets('all');
    expect(all).toHaveLength(8);
    expect(new Set(all.map((pet) => pet.accountId))).toEqual(new Set(ids.slice(0, 2)));
  });

  it('gives the same pets after a rebuild', async () => {
    const before = await pets('all');
    rebuildDerivedTables(database.db, { now: () => OPTIONS.until });
    expect(await pets('all')).toEqual(before);
  }, 240_000);
});
