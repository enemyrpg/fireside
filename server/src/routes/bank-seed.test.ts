import {
  accountsResponseSchema,
  bankHistoryResponseSchema,
  bankResponseSchema,
  bankSummaryResponseSchema,
  isBankFiller,
  potionStorageResponseSchema,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { bankProjection, potionStorageProjection } from '../projections/bank.js';
import { PROJECTIONS, rebuildProjections } from '../projections/index.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a seed run: every account has a bank that
// changes over time, the endpoints agree with each other, and a rebuild gives
// identical tables (items only for each account's latest snapshot).

const OPTIONS = {
  seed: 3,
  accounts: 3,
  months: 1,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

describe('bank on seed data', () => {
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

  it('has a bank with tabs, placeholders and cash for every account', async () => {
    const body = await get('/api/v1/accounts/all/bank', bankResponseSchema);
    expect(body.banks.map((bank) => bank.accountId)).toEqual(ids);
    for (const bank of body.banks) {
      expect(bank.items.length).toBeGreaterThan(5);
      expect(bank.totals.cashValue).toBeGreaterThan(0);
    }
    const tabbed = body.banks.filter((bank) => bank.tabs.length > 1);
    expect(tabbed.length).toBeGreaterThanOrEqual(2);
    expect(body.banks.some((bank) => bank.items.some((item) => item.placeholder))).toBe(true);
  });

  it('has a history that changes, ending at the summary', async () => {
    const all = await get('/api/v1/accounts/all/bank/history', bankHistoryResponseSchema);
    expect(all.days.length).toBeGreaterThan(20);
    expect(new Set(all.days.map((day) => day.geValue)).size).toBeGreaterThan(5);
    const summary = await get('/api/v1/accounts/all/bank/summary', bankSummaryResponseSchema);
    expect(all.days.at(-1)).toMatchObject({
      geValue: summary.geValue,
      cashValue: summary.cashValue,
      potionStorageGeValue: summary.potionStorageGeValue,
    });
  });

  it('has the HA value of inventory and equipment in the history (1.20.0)', async () => {
    const bank = await get('/api/v1/accounts/all/bank', bankResponseSchema);
    const all = await get('/api/v1/accounts/all/bank/history', bankHistoryResponseSchema);
    const sum = (key: 'inventory' | 'equipment') =>
      bank.banks.reduce((total, entry) => total + entry[key].haValue, 0);
    expect(all.days.at(-1)).toMatchObject({
      inventoryHaValue: sum('inventory'),
      equipmentHaValue: sum('equipment'),
    });
    expect(sum('equipment')).toBeGreaterThan(0);
  });

  it('has bank fillers and quiver ammo to show', async () => {
    const body = await get('/api/v1/accounts/all/bank', bankResponseSchema);
    const fillers = body.banks.flatMap((bank) =>
      bank.items.filter((item) => isBankFiller(item.itemId)),
    );
    expect(fillers).toHaveLength(4);
    for (const filler of fillers) {
      expect(filler).toMatchObject({ quantity: 1, placeholder: false, geValue: 0, haValue: 0 });
    }
    const slots = body.banks.flatMap((bank) => bank.equipment.items.map((item) => item.slot));
    expect(slots).toContain('QUIVER_AMMO');
  });

  it('sums the accounts for all', async () => {
    const parts = await Promise.all(
      ids.map((id) =>
        get(`/api/v1/accounts/${String(id)}/bank/summary`, bankSummaryResponseSchema),
      ),
    );
    const all = await get('/api/v1/accounts/all/bank/summary', bankSummaryResponseSchema);
    expect(all.geValue).toBe(parts.reduce((sum, part) => sum + part.geValue, 0));
    expect(all.cashValue).toBe(parts.reduce((sum, part) => sum + part.cashValue, 0));
  });

  it('has potion storage for the accounts that use it', async () => {
    const body = await get('/api/v1/accounts/all/potion-storage', potionStorageResponseSchema);
    expect(body.storages.length).toBeGreaterThanOrEqual(1);
    expect(body.totals.geValue).toBeGreaterThan(0);
  });

  it('gives identical tables after a rebuild', () => {
    const before = [
      bankProjection.snapshot(database.db),
      potionStorageProjection.snapshot(database.db),
    ];
    const result = rebuildProjections(database.db, {
      projections: PROJECTIONS,
      now: () => OPTIONS.until,
    });
    expect(result.failed).toEqual([]);
    expect([
      bankProjection.snapshot(database.db),
      potionStorageProjection.snapshot(database.db),
    ]).toEqual(before);
    const { items } = before[0] as { items: { eventId: string }[] };
    // Items for the latest snapshot of each account only.
    expect(new Set(items.map((item) => item.eventId)).size).toBe(ids.length);
  }, 240_000);
});
