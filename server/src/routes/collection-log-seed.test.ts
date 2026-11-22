import {
  accountsResponseSchema,
  collectionLogResponseSchema,
  collectionLogStatusResponseSchema,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { buildApp } from '../app.js';
import { clogTablesSnapshot } from '../clog/project.js';
import type { Database } from '../db/index.js';
import { accountClogSources, events, externalSnapshots } from '../db/schema.js';
import type { SeedData } from '../seed/generator/generate.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a seed run: two accounts have a collection log that grows
// over time, stored as raw external data (never as events), with no source
// turned on. A rebuild gives identical tables and answers.

const OPTIONS = {
  seed: 3,
  accounts: 3,
  months: 2,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

describe('collection log on seed data', () => {
  let app: FastifyInstance;
  let database: Database;
  let data: SeedData;
  let ids: number[] = [];

  beforeAll(async () => {
    // RuneProfile on in `.env`: a seed account must still never be looked up.
    const fixture = await loadSeedFixture(OPTIONS, {
      TZ: OPTIONS.timeZone,
      RUNEPROFILE_ENABLED: 'true',
      USER_AGENT_CONTACT: 'you@example.com',
    });
    const { config, result } = fixture;
    ({ data, database } = fixture);
    expect(result.rejected).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.externalSnapshots).toBe(
      data.collectionLogs.reduce((sum, log) => sum + log.snapshots.length, 0),
    );
    app = buildApp({ db: database, config, dashboard: { now: () => OPTIONS.until } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    const accounts = accountsResponseSchema.parse(response.json()).accounts;
    // Main, iron, alt.
    ids = data.accounts.map(
      (seeded) => accounts.find((account) => account.displayName === seeded.displayName)?.id ?? 0,
    );
  }, SEED_FIXTURE_HOOK_TIMEOUT_MS);
  afterAll(() => app.close());

  async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return schema.parse(response.json());
  }
  const log = (id: number) =>
    get(`/api/v1/accounts/${String(id)}/collection-log`, collectionLogResponseSchema);
  const status = (id: number) =>
    get(`/api/v1/accounts/${String(id)}/collection-log/status`, collectionLogStatusResponseSchema);

  it('gives the main and the iron a collection log with the counts of the seed', async () => {
    for (const [index, seeded] of data.collectionLogs.entries()) {
      const body = await log(ids[index] ?? 0);
      expect(body).toMatchObject({ obtained: seeded.obtained, total: seeded.total });
      expect(body.tabs.map((tab) => tab.name)).toEqual([
        'Bosses',
        'Raids',
        'Clues',
        'Minigames',
        'Other',
      ]);
      expect(body.updatedAt).toBe(
        seeded.snapshots.findLast((s) => s.kind === 'COLLECTION_LOG')?.fetchedAt,
      );
      const { tabs, ...rest } = body;
      expect(tabs.length).toBe(5);
      expect(await status(ids[index] ?? 0)).toEqual(rest);
    }
  });

  it('has items from before tracking, with an approximate date and with an exact one', async () => {
    for (const id of ids.slice(0, 2)) {
      const items = (await log(id)).tabs
        .flatMap((tab) => tab.pages.flatMap((page) => page.items))
        .filter((item) => item.obtained);
      expect(items.some((item) => item.firstSeenAt === null)).toBe(true);
      expect(items.some((item) => item.firstSeenAt !== null && item.approximate)).toBe(true);
      expect(items.some((item) => item.firstSeenAt !== null && !item.approximate)).toBe(true);
      expect(items.some((item) => item.quantity > 1)).toBe(true);
    }
  });

  it('has a completed page, an untouched page and missing items', async () => {
    const pages = (await log(ids[0] ?? 0)).tabs.flatMap((tab) => tab.pages);
    expect(pages.find((page) => page.name === 'Giant Mole')).toMatchObject({
      obtained: 3,
      total: 3,
    });
    expect(pages.find((page) => page.name === 'Corporeal Beast')).toMatchObject({ obtained: 0 });
    expect(pages.some((page) => page.obtained > 0 && page.obtained < page.total)).toBe(true);
  });

  it('leaves the third account without a collection log', async () => {
    expect(await status(ids[2] ?? 0)).toEqual({
      accountId: ids[2],
      source: null,
      sourceAvailable: true,
      sync: null,
      updatedAt: null,
      obtained: null,
      total: null,
    });
  });

  it('turns no source on and adds no events, so nothing is ever looked up', async () => {
    const { db } = database;
    expect(db.select().from(accountClogSources).all()).toEqual([]);
    expect(db.select().from(events).all()).toHaveLength(data.events.length);
    for (const id of ids.slice(0, 2)) {
      expect(await status(id)).toMatchObject({ source: null, sync: null });
      const sync = await app.inject({
        method: 'POST',
        url: `/api/v1/accounts/${String(id)}/collection-log/sync`,
      });
      expect(sync.statusCode).toBe(409);
    }
  });

  it('is rebuilt from the raw rows to the same tables and answers', async () => {
    const { db } = database;
    const before = {
      tables: clogTablesSnapshot(db),
      logs: await Promise.all(ids.map(log)),
      raw: db.select().from(externalSnapshots).all().length,
    };
    expect(before.tables.items.length).toBeGreaterThan(0);
    rebuildDerivedTables(db, { now: () => data.until });
    expect(clogTablesSnapshot(db)).toEqual(before.tables);
    expect(await Promise.all(ids.map(log))).toEqual(before.logs);
    expect(db.select().from(externalSnapshots).all()).toHaveLength(before.raw);
  }, 240_000);
});
