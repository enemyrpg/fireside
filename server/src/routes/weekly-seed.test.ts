import {
  accountsResponseSchema,
  bankHistoryResponseSchema,
  gainsResponseSchema,
  isoWeekRange,
  lootResponseSchema,
  screentimeResponseSchema,
  weeklyResponseSchema,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { weeklySummaries } from '../db/schema.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a small seed run (about five weeks, over the October DST change):
// every week validates against the shared schema, and play time, XP and loot
// agree with screen time, gains and loot for the same week. The bank section
// agrees with `bank/history`, and the seed has pets,
// collection log items and finished quests in some week.

const OPTIONS = {
  seed: 11,
  accounts: 2,
  months: 1.2,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

/** From before the seed starts to the current week (2026-W45). W43 has the 25-hour Sunday. */
const WEEKS = Array.from({ length: 9 }, (_, i) => `2026-W${String(37 + i)}`);

describe('weekly summary on seed data', () => {
  let app: FastifyInstance;
  let database: Database;
  let accountIds: number[] = [];
  let firstSeen = new Map<number, string>();

  beforeAll(async () => {
    const fixture = await loadSeedFixture(OPTIONS, { TZ: OPTIONS.timeZone });
    const { config, result } = fixture;
    database = fixture.database;
    expect(result.failed).toEqual([]);
    app = buildApp({ db: database, config, dashboard: { now: () => OPTIONS.until } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    const list = accountsResponseSchema.parse(response.json()).accounts;
    accountIds = list.map((a) => a.id);
    firstSeen = new Map(list.map((a) => [a.id, a.firstSeenAt]));
  }, SEED_FIXTURE_HOOK_TIMEOUT_MS);
  afterAll(() => app.close());

  async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return schema.parse(response.json());
  }

  it('agrees with screen time, gains and loot for every week, per account and for all', async () => {
    let withContent = 0;
    const seen = { pets: 0, bank: 0, collectionLog: 0, quests: 0 };
    for (const account of [...accountIds, 'all'] as const) {
      const base = `/api/v1/accounts/${String(account)}`;
      let previousPlayed = 0;
      for (const week of WEEKS) {
        const body = await get(`${base}/weekly?week=${week}`, weeklyResponseSchema);
        expect(body.complete, week).toBe(week !== '2026-W45');
        const range = `from=${body.start}&to=${body.end}`;

        const screen = await get(
          `${base}/screentime?${range}&bucket=week`,
          screentimeResponseSchema,
        );
        expect(body.playtime?.playedSeconds ?? 0, week).toBe(screen.totals.playedSeconds);
        expect(body.playtime?.afkSeconds ?? 0, week).toBe(screen.totals.afkSeconds);
        if (body.playtime) {
          expect(body.playtime.previousWeekPlayedSeconds, week).toBe(previousPlayed);
          withContent += 1;
        }
        previousPlayed = screen.totals.playedSeconds;

        // The Weekly page's own call: seven days whose active and AFK time add
        // up to the weekly tiles, also in the 25-hour DST week.
        const days = await get(`${base}/screentime?${range}&bucket=day`, screentimeResponseSchema);
        expect(days.buckets, week).toHaveLength(7);
        expect(body.playtime?.activeSeconds ?? 0, week).toBe(days.totals.activeSeconds);
        expect(body.playtime?.afkSeconds ?? 0, week).toBe(days.totals.afkSeconds);
        const sum = (key: 'activeSeconds' | 'afkSeconds') =>
          days.buckets.reduce((total, bucket) => total + bucket[key], 0);
        expect(sum('activeSeconds'), week).toBe(days.totals.activeSeconds);
        expect(sum('afkSeconds'), week).toBe(days.totals.afkSeconds);

        const gains = await get(`${base}/gains?${range}`, gainsResponseSchema);
        expect(body.xp?.xpGained ?? 0, week).toBe(gains.total.xpGained);
        expect(body.xp?.levelsGained ?? 0, week).toBe(gains.total.levelsGained);

        const loot = await get(`${base}/loot?${range}`, lootResponseSchema);
        expect(body.loot?.geValue ?? 0, week).toBe(loot.totals.geValue);

        // Net worth per day is the same as on the Bank page's chart.
        const history = await get(`${base}/bank/history?${range}`, bankHistoryResponseSchema);
        expect(body.bank?.days ?? [], week).toEqual(
          history.days.map(({ date, geValue }) => ({ date, geValue })),
        );
        for (const section of ['pets', 'bank', 'collectionLog', 'quests'] as const) {
          if (body[section]) seen[section] += 1;
        }
      }
    }
    expect(withContent).toBeGreaterThan(8);
    for (const [section, weeks] of Object.entries(seen)) {
      expect(weeks, section).toBeGreaterThan(0);
    }
  });

  it('serves stored weeks unchanged on the next read', async () => {
    const stored = database.db.select().from(weeklySummaries).all();
    // Every complete week that ends after the account's first event; the
    // current week and weeks before the account existed are never stored.
    const expected = accountIds.flatMap((id) =>
      WEEKS.slice(0, -1)
        .filter(
          (week) => isoWeekRange(week, OPTIONS.timeZone).end > Date.parse(firstSeen.get(id) ?? ''),
        )
        .map((week) => `${String(id)} ${week}`),
    );
    expect(stored.map((row) => `${String(row.accountId)} ${row.isoWeek}`).sort()).toEqual(
      expected.sort(),
    );
    // The seed starts after 2026-W37, so not every week is stored.
    expect(expected.length).toBeGreaterThan(accountIds.length * 4);
    expect(expected.length).toBeLessThan(accountIds.length * (WEEKS.length - 1));
    for (const account of [...accountIds, 'all'] as const) {
      const url = `/api/v1/accounts/${String(account)}/weekly?week=2026-W43`;
      expect(await get(url, weeklyResponseSchema)).toEqual(await get(url, weeklyResponseSchema));
    }
  });
});
