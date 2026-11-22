import {
  accountsResponseSchema,
  calendarResponseSchema,
  screentimeHeatmapResponseSchema,
  screentimeResponseSchema,
  screentimeWorldsResponseSchema,
} from '@fireside/shared';
import { count } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { sessionHeartbeats } from '../db/schema.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a small seed run (about five weeks, over the October DST
// change): every response matches the shared schemas, and screen time,
// calendar, worlds and heatmap all count the same heartbeats.

const OPTIONS = {
  seed: 11,
  accounts: 2,
  months: 1.2,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

// Local weeks and a month in Oslo, incl. W43 with the 25-hour Sunday.
const RANGES = [
  'from=2026-10-18T22:00:00.000Z&to=2026-10-25T23:00:00.000Z', // W43
  'from=2026-10-25T23:00:00.000Z&to=2026-11-01T23:00:00.000Z', // W44
  'from=2026-09-30T22:00:00.000Z&to=2026-10-31T23:00:00.000Z', // October
  'from=2026-09-01T00:00:00.000Z&to=2026-11-04T00:00:00.000Z', // everything
];

describe('screen time on seed data', () => {
  let app: FastifyInstance;
  let database: Database;
  let accountIds: number[] = [];

  beforeAll(async () => {
    const fixture = await loadSeedFixture(OPTIONS, { TZ: OPTIONS.timeZone });
    const { config, result } = fixture;
    database = fixture.database;
    expect(result.failed).toEqual([]);
    app = buildApp({ db: database, config, dashboard: { now: () => OPTIONS.until } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    accountIds = accountsResponseSchema.parse(response.json()).accounts.map((a) => a.id);
  }, SEED_FIXTURE_HOOK_TIMEOUT_MS);
  afterAll(() => app.close());

  async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return schema.parse(response.json());
  }
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

  it('counts every heartbeat once', async () => {
    const heartbeats = database.db.select({ n: count() }).from(sessionHeartbeats).get()?.n ?? 0;
    expect(heartbeats).toBeGreaterThan(1000);
    const all = await get(
      `/api/v1/accounts/all/screentime?${RANGES[3] ?? ''}`,
      screentimeResponseSchema,
    );
    expect(all.totals.playedSeconds).toBe(heartbeats * 60);
    expect(all.totals.afkSeconds).toBeGreaterThan(0);
  });

  it('agrees with the calendar, worlds and heatmap, per account and for all', async () => {
    for (const range of RANGES) {
      const played = new Map<number | 'all', number>();
      for (const account of [...accountIds, 'all'] as const) {
        const base = `/api/v1/accounts/${String(account)}`;
        for (const bucket of ['day', 'week', 'month']) {
          const screen = await get(
            `${base}/screentime?${range}&bucket=${bucket}`,
            screentimeResponseSchema,
          );
          played.set(account, screen.totals.playedSeconds);
        }
        const screen = await get(`${base}/screentime?${range}`, screentimeResponseSchema);
        const calendar = await get(`${base}/calendar?${range}`, calendarResponseSchema);
        const worlds = await get(
          `${base}/screentime/worlds?${range}`,
          screentimeWorldsResponseSchema,
        );
        const heatmap = await get(
          `${base}/screentime/heatmap?${range}`,
          screentimeHeatmapResponseSchema,
        );
        const total = screen.totals.playedSeconds;
        expect(sum(calendar.days.map((d) => d.playedSeconds))).toBe(total);
        expect(sum(calendar.days.map((d) => d.activeSeconds))).toBe(screen.totals.activeSeconds);
        // Day buckets are the calendar days plus empty ones.
        expect(
          screen.buckets
            .filter((b) => b.activeSeconds + b.afkSeconds > 0)
            .map((b) => [b.period, b.activeSeconds, b.afkSeconds]),
        ).toEqual(calendar.days.map((d) => [d.date, d.activeSeconds, d.afkSeconds]));
        expect(sum(worlds.worlds.map((w) => w.seconds))).toBe(total);
        expect(sum(worlds.locations.map((l) => l.seconds))).toBe(total);
        expect(sum(heatmap.cells.map((c) => c.seconds))).toBe(total);
      }
      expect(sum(accountIds.map((id) => played.get(id) ?? 0))).toBe(played.get('all'));
    }
  });

  it('answers with the default range', async () => {
    for (const path of ['screentime', 'screentime/worlds', 'screentime/heatmap']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/accounts/all/${path}` });
      expect(response.statusCode, response.body).toBe(200);
    }
    const screen = await get('/api/v1/accounts/all/screentime', screentimeResponseSchema);
    expect(screen.buckets).toHaveLength(30);
    expect(screen.totals.playedSeconds).toBeGreaterThan(0);
    expect(screen.previous).not.toBeNull();
  });
});
