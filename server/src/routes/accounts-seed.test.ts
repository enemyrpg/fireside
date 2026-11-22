import {
  accountDetailResponseSchema,
  accountsResponseSchema,
  gainsResponseSchema,
  xpResponseSchema,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a small seed run: every response matches the shared
// schemas, and the XP series agrees with gains over the same range.

const OPTIONS = {
  seed: 7,
  accounts: 2,
  months: 0.5,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

describe('accounts, XP and gains on seed data', () => {
  let app: FastifyInstance;
  let ids: string[] = [];

  beforeAll(async () => {
    const { database, config, result } = await loadSeedFixture(OPTIONS, { TZ: OPTIONS.timeZone });
    expect(result.failed).toEqual([]);
    app = buildApp({ db: database, config, dashboard: { now: () => OPTIONS.until } });
  }, SEED_FIXTURE_HOOK_TIMEOUT_MS);
  afterAll(() => app.close());

  async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return schema.parse(response.json());
  }

  it('lists the seed accounts with names and totals', async () => {
    const { accounts } = await get('/api/v1/accounts', accountsResponseSchema);
    expect(accounts).toHaveLength(OPTIONS.accounts);
    for (const account of accounts) {
      expect(account.displayName).not.toBeNull();
      expect(account.totalXp).toBeGreaterThan(0);
      const detail = await get(
        `/api/v1/accounts/${String(account.id)}`,
        accountDetailResponseSchema,
      );
      expect(detail.names.length).toBeGreaterThan(0);
    }
    ids = [...accounts.map((account) => String(account.id)), 'all'];
  });

  it('ends each XP series at the account total from /accounts', async () => {
    const { accounts } = await get('/api/v1/accounts', accountsResponseSchema);
    for (const account of accounts) {
      const xp = await get(
        `/api/v1/accounts/${String(account.id)}/xp?bucket=month`,
        xpResponseSchema,
      );
      expect(xp.points.length).toBeGreaterThan(0);
      expect(xp.points.at(-1)).toMatchObject({ xp: account.totalXp, level: account.totalLevel });
    }
    const all = await get('/api/v1/accounts/all/xp?bucket=month', xpResponseSchema);
    const sum = accounts.reduce((total, account) => total + (account.totalXp ?? 0), 0);
    expect(all.points.at(-1)?.xp).toBe(sum);
  });

  it('gives valid XP series and gains for every account and `all`', async () => {
    for (const id of ids) {
      for (const bucket of ['day', 'week', 'month']) {
        await get(`/api/v1/accounts/${id}/xp?bucket=${bucket}`, xpResponseSchema);
        await get(`/api/v1/accounts/${id}/xp?bucket=${bucket}&skill=SLAYER`, xpResponseSchema);
      }
      for (const period of ['day', 'week', 'month', 'year']) {
        await get(`/api/v1/accounts/${id}/gains?period=${period}`, gainsResponseSchema);
      }
    }
  });

  it('sums daily XP gains to the gains over the same range', async () => {
    // Local midnights in Oslo (CET): 20 Oct to 3 Nov, across the DST change.
    const range = 'from=2026-10-19T22:00:00.000Z&to=2026-11-02T23:00:00.000Z';
    for (const id of ids) {
      const gains = await get(`/api/v1/accounts/${id}/gains?${range}`, gainsResponseSchema);
      const daily = await get(`/api/v1/accounts/${id}/xp?bucket=day&${range}`, xpResponseSchema);
      const sum = daily.points.reduce((total, point) => total + point.gained, 0);
      expect(gains.total.xpGained).toBeGreaterThan(0);
      expect(sum, id).toBe(gains.total.xpGained);

      const slayer = await get(
        `/api/v1/accounts/${id}/xp?bucket=week&skill=SLAYER&${range}`,
        xpResponseSchema,
      );
      const slayerGain = gains.skills.find((skill) => skill.skill === 'SLAYER')?.xpGained ?? 0;
      expect(slayer.points.reduce((total, point) => total + point.gained, 0)).toBe(slayerGain);
    }
  });
});
