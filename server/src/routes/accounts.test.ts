import {
  accountDetailResponseSchema,
  accountsResponseSchema,
  errorResponseSchema,
  gainsResponseSchema,
  SKILLS,
  xpResponseSchema,
  type Event,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { accounts } from '../db/schema.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  runRebuild,
  sessionIdOf,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';

// Accounts, XP and gains. Small hand-built data in Europe/Oslo; every expected
// number is worked out by hand in the comments.

const TZ = 'Europe/Oslo';
const HASH_A = '1111111111';
const HASH_B = '2222222222';
const HASH_C = '3333333333';

let app: FastifyInstance | undefined;
let run: TestRun | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function start(events: readonly Event[], now = '2026-11-09T12:00:00.000Z'): FastifyInstance {
  run = emptyRun();
  ingestBatch(run, events);
  expect(run.failed).toEqual([]);
  app = buildApp({
    db: run.database,
    config: testConfig({ TZ }),
    dashboard: { now: () => new Date(now) },
  });
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

/**
 * Account A (Test Main, renamed NewName), account B (XP only, no session.start)
 * and account C (session.start only, no XP). Week 2026-W45 is
 * [2026-11-01T23:00Z, 2026-11-08T23:00Z).
 */
function threeAccounts(): Event[] {
  const f = eventFactory();
  const a = { accountHash: HASH_A, sessionId: sessionIdOf(1) };
  const b = { accountHash: HASH_B, sessionId: sessionIdOf(2) };
  const c = { accountHash: HASH_C, sessionId: sessionIdOf(3) };
  return [
    f.sessionStart('2026-11-01T09:59:00.000Z', { displayName: 'Test Main', ...a }),
    // s1, before W45 (Sunday 1 Nov local).
    f.xpSnapshot(
      '2026-11-01T10:00:00.000Z',
      { SLAYER: { xp: 5_000_000, level: 89 }, ATTACK: 100, NEW_SKILL: 0 },
      a,
    ),
    // s2, in W45.
    f.xpSnapshot(
      '2026-11-03T18:00:00.000Z',
      { SLAYER: { xp: 5_200_000, level: 89 }, ATTACK: 100 },
      a,
    ),
    f.sessionStart('2026-11-05T17:00:00.000Z', { displayName: 'NewName', ...a }),
    // s3, in W45. HITPOINTS 0 → 500. NEW_SKILL is unknown: listed, not in totals.
    f.xpSnapshot(
      '2026-11-05T18:00:00.000Z',
      { SLAYER: { xp: 5_346_332, level: 90 }, ATTACK: 100, HITPOINTS: 500, NEW_SKILL: 10 },
      a,
    ),
    f.xpSnapshot('2026-11-04T12:00:00.000Z', { SLAYER: { xp: 100_000, level: 49 } }, b),
    f.xpSnapshot('2026-11-06T12:00:00.000Z', { SLAYER: { xp: 150_000, level: 52 } }, b),
    f.sessionStart('2026-11-02T12:00:00.000Z', {
      displayName: 'Gamma',
      accountType: 'NORMAL',
      ...c,
    }),
  ];
}

/** Account IDs by hash, as path strings (IDs depend on projection order; the API never shows hashes). */
function idsByHash(): Promise<{ a: string; b: string; c: string }> {
  const id = (hash: string) =>
    String(
      run?.database.db.select().from(accounts).where(eq(accounts.accountHash, hash)).get()?.id ?? 0,
    );
  return Promise.resolve({ a: id(HASH_A), b: id(HASH_B), c: id(HASH_C) });
}

const zeroSkill = {
  startXp: 0,
  endXp: 0,
  xpGained: 0,
  startLevel: 1,
  endLevel: 1,
  levelsGained: 0,
};

describe('GET /accounts and /accounts/:accountId', () => {
  it('lists accounts, with null name/type before session.start and null totals before XP', async () => {
    start(threeAccounts());
    const ids = await idsByHash();
    const { accounts: list } = await get('/api/v1/accounts', accountsResponseSchema);
    // Ordered by ID.
    expect(list.map((account) => String(account.id))).toEqual(
      [ids.a, ids.b, ids.c].sort((x, y) => Number(x) - Number(y)),
    );
    expect([...list].sort((x, y) => x.lastSeenAt.localeCompare(y.lastSeenAt)).reverse()).toEqual([
      {
        id: Number(ids.b),
        displayName: null,
        accountType: null,
        firstSeenAt: '2026-11-04T12:00:00.000Z',
        lastSeenAt: '2026-11-06T12:00:00.000Z',
        totalLevel: 52 + 23,
        totalXp: 150_000,
        // XP snapshots only: no session.* event, so no session.
        latestSession: null,
      },
      {
        id: Number(ids.a),
        displayName: 'NewName',
        accountType: 'IRONMAN',
        firstSeenAt: '2026-11-01T09:59:00.000Z',
        lastSeenAt: '2026-11-05T18:00:00.000Z',
        // s3: SLAYER 90 + 23 skills at level 1; 5,346,332 + 100 + 500.
        totalLevel: 113,
        totalXp: 5_346_932,
        // No heartbeat or end: closed by the timeout at its start.
        latestSession: { endedAt: '2026-11-01T09:59:00.000Z', endReason: 'timeout' },
      },
      {
        id: Number(ids.c),
        displayName: 'Gamma',
        accountType: 'NORMAL',
        firstSeenAt: '2026-11-02T12:00:00.000Z',
        lastSeenAt: '2026-11-02T12:00:00.000Z',
        totalLevel: null,
        totalXp: null,
        latestSession: { endedAt: '2026-11-02T12:00:00.000Z', endReason: 'timeout' },
      },
    ]);
  });

  it('gives one account with the same summary as the list', async () => {
    start(threeAccounts());
    const { accounts: list } = await get('/api/v1/accounts', accountsResponseSchema);
    for (const summary of list) {
      const detail = await get(
        `/api/v1/accounts/${String(summary.id)}`,
        accountDetailResponseSchema,
      );
      expect(detail).toEqual({ ...summary, names: detail.names });
    }
  });

  it('gives one account with its name history, oldest first', async () => {
    start(threeAccounts());
    const { a, b } = await idsByHash();
    const detail = await get(`/api/v1/accounts/${a}`, accountDetailResponseSchema);
    expect(detail.names).toEqual([
      {
        displayName: 'Test Main',
        firstSeenAt: '2026-11-01T09:59:00.000Z',
        lastSeenAt: '2026-11-03T18:00:00.000Z',
      },
      {
        displayName: 'NewName',
        firstSeenAt: '2026-11-05T17:00:00.000Z',
        lastSeenAt: '2026-11-05T18:00:00.000Z',
      },
    ]);
    const noName = await get(`/api/v1/accounts/${b}`, accountDetailResponseSchema);
    expect(noName).toMatchObject({ displayName: null, accountType: null, names: [] });
  });

  it('gives 404 for an unknown account and 400 for bad IDs and parameters', async () => {
    start(threeAccounts());
    expect(await getError('/api/v1/accounts/999')).toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    });
    for (const url of [
      '/api/v1/accounts/all',
      '/api/v1/accounts/01',
      '/api/v1/accounts/0',
      '/api/v1/accounts/1?extra=1',
      '/api/v1/accounts?limit=10',
    ]) {
      const { status, body } = await getError(url);
      expect(status, url).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
    const { body } = await getError('/api/v1/accounts/01');
    expect(body.error.details[0]?.path).toBe('params.accountId');
  });
});

describe('GET /accounts/:accountId/gains', () => {
  const W45 = 'from=2026-11-01T23:00:00.000Z&to=2026-11-08T23:00:00.000Z';

  it('gives last snapshot in the period minus last before it, per skill', async () => {
    start(threeAccounts());
    const { a } = await idsByHash();
    const gains = await get(`/api/v1/accounts/${a}/gains?${W45}`, gainsResponseSchema);
    expect(gains.from).toBe('2026-11-01T23:00:00.000Z');
    expect(gains.to).toBe('2026-11-08T23:00:00.000Z');
    // s3 − s1: SLAYER 346,332 and one level, HITPOINTS 500. NEW_SKILL not in total.
    expect(gains.total).toEqual({ xpGained: 346_832, levelsGained: 1 });
    // Every skill is listed, in SKILLS order, then unknown skills.
    expect(gains.skills.map((s) => s.skill)).toEqual([...SKILLS, 'NEW_SKILL']);
    const bySkill = new Map(gains.skills.map((s) => [s.skill, s]));
    expect(bySkill.get('SLAYER')).toEqual({
      skill: 'SLAYER',
      startXp: 5_000_000,
      endXp: 5_346_332,
      xpGained: 346_332,
      startLevel: 89,
      endLevel: 90,
      levelsGained: 1,
    });
    // A skill with no change is listed with 0.
    expect(bySkill.get('ATTACK')).toEqual({
      ...zeroSkill,
      skill: 'ATTACK',
      startXp: 100,
      endXp: 100,
    });
    expect(bySkill.get('HITPOINTS')).toMatchObject({ startXp: 0, endXp: 500, xpGained: 500 });
    expect(bySkill.get('MINING')).toEqual({ ...zeroSkill, skill: 'MINING' });
    expect(bySkill.get('NEW_SKILL')).toMatchObject({ startXp: 0, endXp: 10, xpGained: 10 });
  });

  it('uses the first snapshot in the period when there is none before it', async () => {
    start(threeAccounts());
    const { a } = await idsByHash();
    // [1 Oct, 4 Nov): nothing before, so s1 → s2. s2 has no NEW_SKILL, so it is left out.
    const gains = await get(
      `/api/v1/accounts/${a}/gains?from=2026-10-01T00:00:00.000Z&to=2026-11-04T00:00:00.000Z`,
      gainsResponseSchema,
    );
    expect(gains.total).toEqual({ xpGained: 200_000, levelsGained: 0 });
    expect(gains.skills.map((s) => s.skill)).toEqual([...SKILLS]);
  });

  it('gives 0 for every skill with data only before the period, and nothing with no data', async () => {
    start(threeAccounts());
    const { a, c } = await idsByHash();
    // Default: the current week (now = Monday 9 Nov, 2026-W46). Only s1–s3 before it.
    const current = await get(`/api/v1/accounts/${a}/gains`, gainsResponseSchema);
    expect(current.from).toBe('2026-11-08T23:00:00.000Z');
    expect(current.to).toBe('2026-11-15T23:00:00.000Z');
    expect(current.total).toEqual({ xpGained: 0, levelsGained: 0 });
    expect(current.skills).toHaveLength(SKILLS.length + 1);
    expect(current.skills.find((s) => s.skill === 'SLAYER')).toMatchObject({
      startXp: 5_346_332,
      endXp: 5_346_332,
      xpGained: 0,
    });

    // No snapshot before `to`: no skills at all.
    const before = await get(
      `/api/v1/accounts/${a}/gains?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z`,
      gainsResponseSchema,
    );
    expect(before).toMatchObject({ total: { xpGained: 0, levelsGained: 0 }, skills: [] });
    const noXp = await get(`/api/v1/accounts/${c}/gains?${W45}`, gainsResponseSchema);
    expect(noXp.skills).toEqual([]);
  });

  it('sums accounts for `all`, each with its own start', async () => {
    start(threeAccounts());
    const gains = await get(`/api/v1/accounts/all/gains?${W45}`, gainsResponseSchema);
    const bySkill = new Map(gains.skills.map((s) => [s.skill, s]));
    // SLAYER: A 5,000,000/89 → 5,346,332/90; B (first in period) 100,000/49 → 150,000/52.
    expect(bySkill.get('SLAYER')).toEqual({
      skill: 'SLAYER',
      startXp: 5_100_000,
      endXp: 5_496_332,
      xpGained: 396_332,
      startLevel: 138,
      endLevel: 142,
      levelsGained: 4,
    });
    // ATTACK: A 100 → 100, B 0 → 0. Levels 1 + 1.
    expect(bySkill.get('ATTACK')).toEqual({
      skill: 'ATTACK',
      startXp: 100,
      endXp: 100,
      xpGained: 0,
      startLevel: 2,
      endLevel: 2,
      levelsGained: 0,
    });
    // C has no XP and adds nothing. NEW_SKILL only from A.
    expect(bySkill.get('NEW_SKILL')).toMatchObject({ startXp: 0, endXp: 10, startLevel: 1 });
    expect(gains.total).toEqual({ xpGained: 396_832, levelsGained: 4 });
  });

  it('uses the current local period for each preset', async () => {
    start(threeAccounts(), '2026-11-05T23:30:00.000Z'); // Friday 6 Nov 00:30 local
    const { a } = await idsByHash();
    const day = await get(`/api/v1/accounts/${a}/gains?period=day`, gainsResponseSchema);
    expect([day.from, day.to]).toEqual(['2026-11-05T23:00:00.000Z', '2026-11-06T23:00:00.000Z']);
    const week = await get(`/api/v1/accounts/${a}/gains?period=week`, gainsResponseSchema);
    expect(week.total.xpGained).toBe(346_832);
    const month = await get(`/api/v1/accounts/${a}/gains?period=month`, gainsResponseSchema);
    expect([month.from, month.to]).toEqual([
      '2026-10-31T23:00:00.000Z',
      '2026-11-30T23:00:00.000Z',
    ]);
    // Nothing before November, so s1 is the start.
    expect(month.total.xpGained).toBe(346_832);
    const year = await get(`/api/v1/accounts/${a}/gains?period=year`, gainsResponseSchema);
    expect(year.from).toBe('2025-12-31T23:00:00.000Z');
  });

  it('counts days and weeks in local time across DST changes', async () => {
    const f = eventFactory();
    const autumn = { accountHash: HASH_A };
    const spring = { accountHash: HASH_B, sessionId: sessionIdOf(2) };
    start([
      // Summer time ends on Sunday 25 October 2026 (a 25-hour day).
      f.xpSnapshot('2026-10-24T12:00:00.000Z', { SLAYER: 1000 }, autumn), // Sat 14:00
      f.xpSnapshot('2026-10-24T23:30:00.000Z', { SLAYER: 1500 }, autumn), // Sun 01:30
      f.xpSnapshot('2026-10-25T22:30:00.000Z', { SLAYER: 1800 }, autumn), // Sun 23:30
      f.xpSnapshot('2026-10-25T23:30:00.000Z', { SLAYER: 2500 }, autumn), // Mon 00:30
      // Summer time starts on Sunday 29 March 2026, the last day of 2026-W13.
      f.xpSnapshot('2026-03-20T12:00:00.000Z', { ATTACK: 100 }, spring),
      f.xpSnapshot('2026-03-29T21:30:00.000Z', { ATTACK: 400 }, spring), // Sun 23:30 CEST
      f.xpSnapshot('2026-03-29T22:30:00.000Z', { ATTACK: 900 }, spring), // Mon 00:30, W14
    ]);
    const { a, b } = await idsByHash();
    const slayer = async (query: string) => {
      const gains = await get(`/api/v1/accounts/${a}/gains?${query}`, gainsResponseSchema);
      return gains.skills.find((s) => s.skill === 'SLAYER')?.xpGained;
    };
    // Sunday 25 Oct local = [24 Oct 22:00Z, 25 Oct 23:00Z): 1000 (before) → 1800.
    expect(await slayer('from=2026-10-24T22:00:00.000Z&to=2026-10-25T23:00:00.000Z')).toBe(800);
    // Saturday: only the 14:00 snapshot, which is also the start.
    expect(await slayer('from=2026-10-23T22:00:00.000Z&to=2026-10-24T22:00:00.000Z')).toBe(0);
    // 2026-W13 as from/to for the spring account: 100 → 400.
    const w13 = await get(
      `/api/v1/accounts/${b}/gains?from=2026-03-22T23:00:00.000Z&to=2026-03-29T22:00:00.000Z`,
      gainsResponseSchema,
    );
    expect(w13.total.xpGained).toBe(300);

    // Same with the day preset, with the clock late on Sunday.
    await app?.close();
    start(
      [
        f.xpSnapshot('2026-10-24T12:00:00.000Z', { SLAYER: 1000 }, autumn),
        f.xpSnapshot('2026-10-24T23:30:00.000Z', { SLAYER: 1500 }, autumn),
        f.xpSnapshot('2026-10-25T22:30:00.000Z', { SLAYER: 1800 }, autumn),
        f.xpSnapshot('2026-10-25T23:30:00.000Z', { SLAYER: 2500 }, autumn),
      ],
      '2026-10-25T22:45:00.000Z',
    );
    const day = await get(
      `/api/v1/accounts/${(await idsByHash()).a}/gains?period=day`,
      gainsResponseSchema,
    );
    expect([day.from, day.to]).toEqual(['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);
    expect(day.skills.find((s) => s.skill === 'SLAYER')?.xpGained).toBe(800);

    // 2026-W13 = [22 Mar 23:00Z, 29 Mar 22:00Z): 100 → 400. The 22:30Z snapshot is in W14.
    await app?.close();
    start(
      [
        f.xpSnapshot('2026-03-20T12:00:00.000Z', { ATTACK: 100 }, spring),
        f.xpSnapshot('2026-03-29T21:30:00.000Z', { ATTACK: 400 }, spring),
        f.xpSnapshot('2026-03-29T22:30:00.000Z', { ATTACK: 900 }, spring),
      ],
      '2026-03-26T12:00:00.000Z',
    );
    const week = await get(
      `/api/v1/accounts/${(await idsByHash()).b}/gains?period=week`,
      gainsResponseSchema,
    );
    expect([week.from, week.to]).toEqual(['2026-03-22T23:00:00.000Z', '2026-03-29T22:00:00.000Z']);
    expect(week.total.xpGained).toBe(300);
  });

  it('never gives negative gains', async () => {
    const f = eventFactory();
    start([
      f.xpSnapshot(
        '2026-11-02T12:00:00.000Z',
        { SLAYER: { xp: 2000, level: 10 } },
        { accountHash: HASH_A },
      ),
      f.xpSnapshot(
        '2026-11-03T12:00:00.000Z',
        { SLAYER: { xp: 1500, level: 9 } },
        { accountHash: HASH_A },
      ),
    ]);
    const { a } = await idsByHash();
    const gains = await get(`/api/v1/accounts/${a}/gains?${W45}`, gainsResponseSchema);
    expect(gains.skills.find((s) => s.skill === 'SLAYER')).toMatchObject({
      startXp: 1500,
      endXp: 1500,
      xpGained: 0,
      levelsGained: 0,
    });
  });

  it('treats XP up with level down as no gain, in both gains and the XP series', async () => {
    const f = eventFactory();
    const a = { accountHash: HASH_A };
    start([
      f.xpSnapshot('2026-11-02T12:00:00.000Z', { SLAYER: { xp: 2000, level: 10 } }, a),
      f.xpSnapshot('2026-11-03T12:00:00.000Z', { SLAYER: { xp: 2500, level: 9 } }, a),
    ]);
    const { a: id } = await idsByHash();
    const gains = await get(`/api/v1/accounts/${id}/gains?${W45}`, gainsResponseSchema);
    expect(gains.skills.find((s) => s.skill === 'SLAYER')).toMatchObject({
      startXp: 2500,
      xpGained: 0,
      levelsGained: 0,
    });
    const xp = await get(
      `/api/v1/accounts/${id}/xp?skill=SLAYER&bucket=week&${W45}`,
      xpResponseSchema,
    );
    expect(xp.points).toEqual([
      { period: '2026-W45', start: '2026-11-01T23:00:00.000Z', xp: 2500, level: 9, gained: 0 },
    ]);
  });

  it('rejects bad queries', async () => {
    start(threeAccounts());
    for (const query of [
      'period=decade',
      'from=2026-11-01T00:00:00.000Z',
      'to=2026-11-01T00:00:00.000Z',
      'from=2026-11-02T00:00:00.000Z&to=2026-11-01T00:00:00.000Z',
      'from=2026-11-01&to=2026-11-02',
      'skill=SLAYER',
    ]) {
      const { status, body } = await getError(`/api/v1/accounts/all/gains?${query}`);
      expect(status, query).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await getError('/api/v1/accounts/999/gains')).status).toBe(404);
  });
});

describe('GET /accounts/:accountId/xp', () => {
  it('gives the value at the end of each week, carried forward', async () => {
    start(threeAccounts());
    const { a } = await idsByHash();
    const xp = await get(`/api/v1/accounts/${a}/xp?skill=SLAYER&bucket=week`, xpResponseSchema);
    // From s1 (Sunday 1 Nov, W44) to now (Monday 9 Nov, W46).
    expect(xp).toEqual({
      skill: 'SLAYER',
      bucket: 'week',
      points: [
        {
          period: '2026-W44',
          start: '2026-10-25T23:00:00.000Z',
          xp: 5_000_000,
          level: 89,
          gained: 0,
        },
        {
          period: '2026-W45',
          start: '2026-11-01T23:00:00.000Z',
          xp: 5_346_332,
          level: 90,
          gained: 346_332,
        },
        {
          period: '2026-W46',
          start: '2026-11-08T23:00:00.000Z',
          xp: 5_346_332,
          level: 90,
          gained: 0,
        },
      ],
    });
  });

  it('clips the first and last bucket to [from, to)', async () => {
    start(threeAccounts());
    const { a } = await idsByHash();
    const xp = await get(
      `/api/v1/accounts/${a}/xp?skill=SLAYER&from=2026-11-03T00:00:00.000Z&to=2026-11-06T00:00:00.000Z`,
      xpResponseSchema,
    );
    expect(xp.bucket).toBe('day');
    expect(xp.points.map(({ period, xp: value, gained }) => [period, value, gained])).toEqual([
      ['2026-11-03', 5_200_000, 200_000], // s1 (before) → s2
      ['2026-11-04', 5_200_000, 0],
      ['2026-11-05', 5_346_332, 146_332], // s2 → s3
      ['2026-11-06', 5_346_332, 0], // only [05 23:00Z, 06 00:00Z)
    ]);
  });

  it('gives total XP and level without a skill', async () => {
    start(threeAccounts());
    const { a } = await idsByHash();
    const xp = await get(`/api/v1/accounts/${a}/xp?bucket=month`, xpResponseSchema);
    expect(xp).toEqual({
      skill: null,
      bucket: 'month',
      points: [
        // s1 total 5,000,100 → s3 total 5,346,932.
        {
          period: '2026-11',
          start: '2026-10-31T23:00:00.000Z',
          xp: 5_346_932,
          level: 113,
          gained: 346_832,
        },
      ],
    });
  });

  it('sums accounts for `all`, from the first bucket any account has data', async () => {
    start(threeAccounts());
    const xp = await get('/api/v1/accounts/all/xp?skill=SLAYER&bucket=week', xpResponseSchema);
    expect(xp.points).toEqual([
      // Only A has a value in W44.
      {
        period: '2026-W44',
        start: '2026-10-25T23:00:00.000Z',
        xp: 5_000_000,
        level: 89,
        gained: 0,
      },
      // A 5,346,332 + B 150,000; gained 346,332 + 50,000 (B from its first snapshot).
      {
        period: '2026-W45',
        start: '2026-11-01T23:00:00.000Z',
        xp: 5_496_332,
        level: 142,
        gained: 396_332,
      },
      {
        period: '2026-W46',
        start: '2026-11-08T23:00:00.000Z',
        xp: 5_496_332,
        level: 142,
        gained: 0,
      },
    ]);
  });

  it('uses local days across the autumn DST change', async () => {
    const f = eventFactory();
    start(
      [
        f.xpSnapshot('2026-10-24T12:00:00.000Z', { SLAYER: 1000 }),
        f.xpSnapshot('2026-10-24T23:30:00.000Z', { SLAYER: 1500 }),
        f.xpSnapshot('2026-10-25T22:30:00.000Z', { SLAYER: 1800 }),
        f.xpSnapshot('2026-10-25T23:30:00.000Z', { SLAYER: 2500 }),
      ],
      '2026-10-26T12:00:00.000Z',
    );
    const xp = await get('/api/v1/accounts/all/xp?skill=SLAYER', xpResponseSchema);
    expect(xp.points).toEqual([
      { period: '2026-10-24', start: '2026-10-23T22:00:00.000Z', xp: 1000, level: 1, gained: 0 },
      { period: '2026-10-25', start: '2026-10-24T22:00:00.000Z', xp: 1800, level: 1, gained: 800 },
      { period: '2026-10-26', start: '2026-10-25T23:00:00.000Z', xp: 2500, level: 1, gained: 700 },
    ]);
  });

  it('starts at the first snapshot when `from` is much earlier', async () => {
    start(threeAccounts());
    const { a } = await idsByHash();
    const all = await get(`/api/v1/accounts/${a}/xp`, xpResponseSchema);
    const started = Date.now();
    const early = await get(
      `/api/v1/accounts/${a}/xp?from=1000-01-01T00:00:00.000Z`,
      xpResponseSchema,
    );
    // Without the limit this builds ~375,000 empty days and takes seconds.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(early).toEqual(all);
  });

  it('gives no points without data, and none in the future', async () => {
    start(threeAccounts());
    const { a, c } = await idsByHash();
    expect((await get(`/api/v1/accounts/${c}/xp`, xpResponseSchema)).points).toEqual([]);
    expect((await get(`/api/v1/accounts/${a}/xp?skill=FOO_BAR`, xpResponseSchema)).points).toEqual(
      [],
    );
    // `to` after now (9 Nov 12:00Z) stops at now.
    const future = await get(
      `/api/v1/accounts/${a}/xp?bucket=month&to=2027-06-01T00:00:00.000Z`,
      xpResponseSchema,
    );
    expect(future.points.map((p) => p.period)).toEqual(['2026-11']);
    const later = await get(
      `/api/v1/accounts/${a}/xp?from=2026-12-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`,
      xpResponseSchema,
    );
    expect(later.points).toEqual([]);
  });

  it('rejects bad queries', async () => {
    start(threeAccounts());
    for (const query of ['bucket=year', 'skill=slayer', 'skill=', 'limit=5', 'period=week']) {
      const { status, body } = await getError(`/api/v1/accounts/all/xp?${query}`);
      expect(status, query).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
    const { body } = await getError('/api/v1/accounts/all/xp?bucket=year');
    expect(body.error.details[0]?.path).toBe('query.bucket');
  });
});

describe('latestSession in GET /accounts', () => {
  // TEST_NOW is 2026-11-09T12:00Z; sessions are kept within the timeout so
  // that an open one stays open.
  const a = (n: number) => ({ accountHash: HASH_A, sessionId: sessionIdOf(n) });

  /** Three sessions on A (logout, hop, then open), one ended session on C, none on B. */
  function manySessions(f = eventFactory()): Event[] {
    const c = { accountHash: HASH_C, sessionId: sessionIdOf(9) };
    return [
      f.sessionStart('2026-11-09T09:00:00.000Z', a(1)),
      f.heartbeat('2026-11-09T09:01:00.000Z', a(1)),
      f.sessionEnd('2026-11-09T10:00:00.000Z', { reason: 'logout', ...a(1) }),
      f.sessionStart('2026-11-09T11:00:00.000Z', a(2)),
      f.sessionEnd('2026-11-09T11:30:00.000Z', { reason: 'hop', ...a(2) }),
      f.sessionStart('2026-11-09T11:30:10.000Z', a(3)),
      f.heartbeat('2026-11-09T11:59:00.000Z', a(3)),
      f.sessionStart('2026-11-09T08:00:00.000Z', { displayName: 'Gamma', ...c }),
      f.sessionEnd('2026-11-09T08:30:00.000Z', { reason: 'client_closed', ...c }),
      f.xpSnapshot('2026-11-09T09:00:00.000Z', { SLAYER: 100 }, { accountHash: HASH_B }),
    ];
  }

  async function latestByHash() {
    const ids = await idsByHash();
    const { accounts: list } = await get('/api/v1/accounts', accountsResponseSchema);
    const of = (id: string) => list.find((account) => String(account.id) === id)?.latestSession;
    return { a: of(ids.a), b: of(ids.b), c: of(ids.c) };
  }

  it('gives the newest session of each account by start time, or null without sessions', async () => {
    start(manySessions());
    expect(await latestByHash()).toEqual({
      a: { endedAt: null, endReason: null },
      b: null,
      c: { endedAt: '2026-11-09T08:30:00.000Z', endReason: 'client_closed' },
    });
  });

  it('follows the newest session as it ends, also when events arrive out of order', async () => {
    // One factory, so the extra end gets an event ID of its own.
    const f = eventFactory();
    const events = manySessions(f);
    start([...events.slice(6), ...events.slice(0, 6)]);
    expect((await latestByHash()).a).toEqual({ endedAt: null, endReason: null });

    await app?.close();
    start([...events, f.sessionEnd('2026-11-09T11:59:30.000Z', { reason: 'logout', ...a(3) })]);
    expect((await latestByHash()).a).toEqual({
      endedAt: '2026-11-09T11:59:30.000Z',
      endReason: 'logout',
    });

    await app?.close();
    start([...events, f.sessionEnd('2026-11-09T11:59:30.000Z', { reason: 'hop', ...a(3) })]);
    expect((await latestByHash()).a).toEqual({
      endedAt: '2026-11-09T11:59:30.000Z',
      endReason: 'hop',
    });
  });

  it('is the same after a full rebuild of the derived tables', async () => {
    start(manySessions());
    const before = await get('/api/v1/accounts', accountsResponseSchema);
    const rebuilt = runRebuild(manySessions());
    expect(rebuilt.failed).toEqual([]);
    await app?.close();
    app = buildApp({
      db: rebuilt.database,
      config: testConfig({ TZ }),
      dashboard: { now: () => new Date('2026-11-09T12:00:00.000Z') },
    });
    run = rebuilt;
    expect(await get('/api/v1/accounts', accountsResponseSchema)).toEqual(before);
  });
});
