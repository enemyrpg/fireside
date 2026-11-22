import {
  diariesResponseSchema,
  errorResponseSchema,
  questsResponseSchema,
  type Event,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { accounts } from '../db/schema.js';
import { PROJECTIONS } from '../projections/index.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  TEST_ACCOUNT_HASH,
  TEST_NOW,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';

// Quests and diaries per account. Every response is also checked against its
// contract schema (totals, order, dates only on finished entries).

const HASH_B = '2222222222';
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

async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
  expect(response.statusCode, response.body).toBe(200);
  return schema.parse(response.json());
}

async function status(url: string): Promise<[number, string]> {
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
  return [response.statusCode, errorResponseSchema.parse(response.json()).error.code];
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

const quests = (hash?: string) =>
  get(`/api/v1/accounts/${String(idOf(hash))}/quests`, questsResponseSchema);
const diaries = (hash?: string) =>
  get(`/api/v1/accounts/${String(idOf(hash))}/diaries`, diariesResponseSchema);

describe('GET /accounts/:accountId/quests', () => {
  it('gives the latest snapshot sorted by name, with quests and miniquests counted apart', async () => {
    const f = eventFactory();
    start([f.fromFixture('quests-snapshot.json', '19:00')]);
    const body = await quests();
    expect(body).toMatchObject({
      accountId: idOf(),
      updatedAt: at('19:00'),
      questPoints: 4,
      totals: { total: 4, finished: 2, inProgress: 1, notStarted: 1 },
      miniquestTotals: { total: 2, finished: 1, inProgress: 0, notStarted: 1 },
    });
    expect(body.quests.map((quest) => [quest.name, quest.kind, quest.state])).toEqual([
      ["Alfred Grimhand's Barcrawl", 'MINIQUEST', 'FINISHED'],
      ['Bear Your Soul', 'MINIQUEST', 'NOT_STARTED'],
      ["Cook's Assistant", 'QUEST', 'FINISHED'],
      ['Desert Treasure II - The Fallen Empire', 'QUEST', 'NOT_STARTED'],
      ['Dragon Slayer I', 'QUEST', 'FINISHED'],
      ['Dragon Slayer II', 'QUEST', 'IN_PROGRESS'],
    ]);
  });

  it('counts an entry without kind as a quest and shows an unknown quest by name', async () => {
    const f = eventFactory();
    start([
      f.questsSnapshot('19:00', {
        questPoints: 1,
        entries: [
          { quest: 'SOME_NEW_QUEST_2', name: 'Some New Quest 2', state: 'IN_PROGRESS' },
          { quest: 'COOKS_ASSISTANT', name: "Cook's Assistant", state: 'FINISHED' },
        ],
      }),
    ]);
    const body = await quests();
    expect(body.totals).toEqual({ total: 2, finished: 1, inProgress: 1, notStarted: 0 });
    expect(body.miniquestTotals.total).toBe(0);
    expect(body.quests.map((quest) => [quest.quest, quest.name, quest.kind])).toEqual([
      ['COOKS_ASSISTANT', "Cook's Assistant", 'QUEST'],
      ['SOME_NEW_QUEST_2', 'Some New Quest 2', 'QUEST'],
    ]);
  });

  it('dates what was first seen as finished after the first snapshot only', async () => {
    const f = eventFactory();
    start([
      f.questsSnapshot('17:00', { quests: { A: 'FINISHED', B: 'IN_PROGRESS', C: 'NOT_STARTED' } }),
      f.questsSnapshot('18:00', { quests: { A: 'FINISHED', B: 'FINISHED', C: 'IN_PROGRESS' } }),
      f.questsSnapshot('19:00', { quests: { A: 'FINISHED', B: 'FINISHED', C: 'FINISHED' } }),
    ]);
    const body = await quests();
    expect(body.updatedAt).toBe(at('19:00'));
    expect(body.quests.map((quest) => [quest.quest, quest.finishedAt])).toEqual([
      ['A', null], // finished before tracking started
      ['B', at('18:00')],
      ['C', at('19:00')],
    ]);
  });

  it('moves the baseline when an older snapshot arrives late', async () => {
    const f = eventFactory();
    const older = f.questsSnapshot('16:00', { quests: { A: 'NOT_STARTED', B: 'FINISHED' } });
    const newer = f.questsSnapshot('17:00', { quests: { A: 'FINISHED', B: 'FINISHED' } });
    start([newer]);
    expect((await quests()).quests.map((quest) => quest.finishedAt)).toEqual([null, null]);
    await app?.close();
    start([newer], [older]);
    const body = await quests();
    // The late snapshot is the baseline now; the states are still the newest.
    expect(body.updatedAt).toBe(at('17:00'));
    expect(body.quests.map((quest) => [quest.quest, quest.state, quest.finishedAt])).toEqual([
      ['A', 'FINISHED', at('17:00')],
      ['B', 'FINISHED', null],
    ]);
  });

  it('shows no date on a quest that is no longer finished', async () => {
    const f = eventFactory();
    start([
      f.questsSnapshot('17:00', { quests: { A: 'NOT_STARTED' } }),
      f.questsSnapshot('18:00', { quests: { A: 'FINISHED' } }),
      f.questsSnapshot('19:00', { quests: { A: 'IN_PROGRESS' } }),
    ]);
    expect((await quests()).quests).toEqual([
      { quest: 'A', name: 'Name of A', kind: 'QUEST', state: 'IN_PROGRESS', finishedAt: null },
    ]);
  });

  it('has no data before the first snapshot, also for an account with diaries only', async () => {
    const f = eventFactory();
    start([f.diariesSnapshot('19:00', { diaries: { ARDOUGNE: ['EASY'] } })]);
    const zero = { total: 0, finished: 0, inProgress: 0, notStarted: 0 };
    expect(await quests()).toEqual({
      accountId: idOf(),
      updatedAt: null,
      questPoints: 0,
      totals: zero,
      miniquestTotals: zero,
      quests: [],
    });
  });

  it('keeps accounts apart', async () => {
    const f = eventFactory();
    start([
      f.questsSnapshot('18:00', { questPoints: 5, quests: { A: 'FINISHED' } }),
      f.questsSnapshot('19:00', {
        questPoints: 1,
        quests: { B: 'IN_PROGRESS' },
        accountHash: HASH_B,
      }),
    ]);
    expect((await quests()).quests.map((quest) => quest.quest)).toEqual(['A']);
    const b = await quests(HASH_B);
    expect([b.questPoints, b.quests.map((quest) => quest.quest)]).toEqual([1, ['B']]);
  });
});

describe('GET /accounts/:accountId/diaries', () => {
  it('gives regions by name with tiers easiest first and totals', async () => {
    const f = eventFactory();
    start([
      f.diariesSnapshot('19:00', {
        diaries: {
          WESTERN: ['EASY'],
          KOUREND: ['EASY', 'MEDIUM', 'HARD', 'ELITE'],
          ARDOUGNE: ['EASY', 'MEDIUM'],
          NEW_REGION: [],
        },
      }),
    ]);
    const body = await diaries();
    expect(body.updatedAt).toBe(at('19:00'));
    expect(body.totals).toEqual({ tiers: 16, completed: 7, regionsCompleted: 1 });
    expect(body.regions.map((region) => [region.region, region.name, region.completed])).toEqual([
      ['ARDOUGNE', 'Ardougne', 2],
      ['KOUREND', 'Kourend & Kebos', 4],
      ['NEW_REGION', 'New Region', 0],
      ['WESTERN', 'Western Provinces', 1],
    ]);
    expect(body.regions[0]?.tiers).toEqual([
      { tier: 'EASY', completed: true, completedAt: null },
      { tier: 'MEDIUM', completed: true, completedAt: null },
      { tier: 'HARD', completed: false, completedAt: null },
      { tier: 'ELITE', completed: false, completedAt: null },
    ]);
  });

  it('dates tiers first seen as completed after the first snapshot', async () => {
    const f = eventFactory();
    start([
      f.diariesSnapshot('17:00', { diaries: { ARDOUGNE: ['EASY'] } }),
      f.diariesSnapshot('18:00', { diaries: { ARDOUGNE: ['EASY', 'MEDIUM'] } }),
      f.diariesSnapshot('19:00', { diaries: { ARDOUGNE: ['EASY', 'MEDIUM'] } }),
    ]);
    const body = await diaries();
    expect(body.regions[0]?.tiers.map((tier) => tier.completedAt)).toEqual([
      null,
      at('18:00'),
      null,
      null,
    ]);
  });

  it('lists only the tiers of the snapshot and never counts such a region as completed', async () => {
    const f = eventFactory();
    start([
      f.diariesSnapshot('19:00', {
        entries: [
          { region: 'NEW_REGION', tier: 'ELITE', completed: true },
          { region: 'NEW_REGION', tier: 'EASY', completed: true },
        ],
      }),
    ]);
    const body = await diaries();
    expect(body.totals).toEqual({ tiers: 2, completed: 2, regionsCompleted: 0 });
    expect(body.regions[0]?.tiers.map((tier) => tier.tier)).toEqual(['EASY', 'ELITE']);
  });

  it('has no data before the first snapshot', async () => {
    const f = eventFactory();
    start([f.questsSnapshot('19:00', { quests: { A: 'FINISHED' } })]);
    expect(await diaries()).toEqual({
      accountId: idOf(),
      updatedAt: null,
      totals: { tiers: 0, completed: 0, regionsCompleted: 0 },
      regions: [],
    });
  });
});

describe('quests and diaries: requests', () => {
  it.each(['quests', 'diaries'])(
    '%s: 404 for an unknown account, 400 for all and parameters',
    async (path) => {
      const f = eventFactory();
      start([f.questsSnapshot('19:00')]);
      expect(await status(`/api/v1/accounts/999/${path}`)).toEqual([404, 'NOT_FOUND']);
      expect(await status(`/api/v1/accounts/all/${path}`)).toEqual([400, 'VALIDATION_ERROR']);
      expect(await status(`/api/v1/accounts/abc/${path}`)).toEqual([400, 'VALIDATION_ERROR']);
      expect(await status(`/api/v1/accounts/${String(idOf())}/${path}?kind=QUEST`)).toEqual([
        400,
        'VALIDATION_ERROR',
      ]);
    },
  );

  it('is local only, like the rest of the dashboard API', async () => {
    const f = eventFactory();
    start([f.questsSnapshot('19:00')]);
    const response = await app?.inject({
      method: 'GET',
      url: `/api/v1/accounts/${String(idOf())}/quests`,
      remoteAddress: '192.168.1.20',
    });
    expect(response?.statusCode).toBe(403);
  });
});
