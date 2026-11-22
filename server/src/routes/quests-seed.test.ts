import {
  accountsResponseSchema,
  diariesResponseSchema,
  questsResponseSchema,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { PROJECTIONS, rebuildProjections } from '../projections/index.js';
import { diariesProjection, questsProjection } from '../projections/quests.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a seed run: every account has quests and diaries that
// move on over time, and a rebuild gives identical tables.

const OPTIONS = {
  seed: 3,
  accounts: 3,
  months: 2,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

describe('quests and diaries on seed data', () => {
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

  async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return schema.parse(response.json());
  }
  const quests = (id: number) => get(`/api/v1/accounts/${String(id)}/quests`, questsResponseSchema);
  const diaries = (id: number) =>
    get(`/api/v1/accounts/${String(id)}/diaries`, diariesResponseSchema);

  it('has quests in every state and miniquests for every account', async () => {
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      const body = await quests(id);
      expect(body.updatedAt).not.toBeNull();
      expect(body.questPoints).toBeGreaterThan(0);
      expect(body.totals.total).toBeGreaterThan(30);
      expect(body.totals.finished).toBeGreaterThan(0);
      expect(body.totals.notStarted).toBeGreaterThan(0);
      expect(body.miniquestTotals.total).toBeGreaterThan(3);
    }
  });

  it('has quests finished before tracking (no date) and during it (dated)', async () => {
    const all = (await Promise.all(ids.map(quests))).flatMap((body) => body.quests);
    const finished = all.filter((quest) => quest.state === 'FINISHED');
    const dated = finished.filter((quest) => quest.finishedAt !== null);
    expect(dated.length).toBeGreaterThan(2);
    expect(finished.length - dated.length).toBeGreaterThan(20);
    expect(new Set(dated.map((quest) => quest.finishedAt)).size).toBeGreaterThan(2);
    expect(all.some((quest) => quest.state === 'IN_PROGRESS')).toBe(true);
  });

  it('has diaries for every account, with tiers completed during tracking', async () => {
    const bodies = await Promise.all(ids.map(diaries));
    for (const body of bodies) {
      expect(body.updatedAt).not.toBeNull();
      expect(body.totals.tiers).toBe(48);
      expect(body.regions).toHaveLength(12);
    }
    expect(bodies.some((body) => body.totals.completed > 0)).toBe(true);
    const dated = bodies.flatMap((body) =>
      body.regions.flatMap((region) => region.tiers.filter((tier) => tier.completedAt !== null)),
    );
    expect(dated.length).toBeGreaterThan(0);
  });

  it('gives identical tables after a rebuild', async () => {
    const snapshot = () => ({
      quests: questsProjection.snapshot(database.db),
      diaries: diariesProjection.snapshot(database.db),
    });
    const before = snapshot();
    const responses = await Promise.all(ids.map(quests));
    const result = rebuildProjections(database.db, {
      projections: PROJECTIONS,
      now: () => OPTIONS.until,
    });
    expect(result.failed).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(await Promise.all(ids.map(quests))).toEqual(responses);
  }, 240_000);
});
