import {
  accountsResponseSchema,
  dropsResponseSchema,
  kcResponseSchema,
  sessionDetailResponseSchema,
  sessionsResponseSchema,
  lootResponseSchema,
  type Drop,
} from '@fireside/shared';
import { count } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { lootItems } from '../db/schema.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a small seed run: every response matches the shared
// schemas, and loot totals agree between grouping by source, by day and the
// single drops.

const OPTIONS = {
  seed: 7,
  accounts: 2,
  months: 0.5,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

describe('loot, drops and KC on seed data', () => {
  let app: FastifyInstance;
  let database: Database;
  let ids: string[] = [];

  beforeAll(async () => {
    const fixture = await loadSeedFixture(OPTIONS, { TZ: OPTIONS.timeZone });
    const { config, result } = fixture;
    database = fixture.database;
    expect(result.failed).toEqual([]);
    app = buildApp({ db: database, config, dashboard: { now: () => OPTIONS.until } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    const { accounts } = accountsResponseSchema.parse(response.json());
    ids = [...accounts.map((account) => String(account.id)), 'all'];
  }, SEED_FIXTURE_HOOK_TIMEOUT_MS);
  afterAll(() => app.close());

  async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return schema.parse(response.json());
  }

  async function allDrops(id: string, query = ''): Promise<Drop[]> {
    const drops: Drop[] = [];
    let cursor: string | null = null;
    do {
      const page: z.infer<typeof dropsResponseSchema> = await get(
        `/api/v1/accounts/${id}/loot/drops?limit=100${query}${cursor ? `&cursor=${cursor}` : ''}`,
        dropsResponseSchema,
      );
      drops.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return drops;
  }

  it('gives the same totals grouped by source, by day and summed over drops', async () => {
    for (const id of ids) {
      const bySource = await get(`/api/v1/accounts/${id}/loot`, lootResponseSchema);
      const byDay = await get(`/api/v1/accounts/${id}/loot?groupBy=day`, lootResponseSchema);
      expect(bySource.totals.lootCount, id).toBeGreaterThan(0);
      expect(byDay.totals).toEqual(bySource.totals);
      expect(byDay.groups.reduce((sum, group) => sum + group.lootCount, 0)).toBe(
        byDay.totals.lootCount,
      );

      const drops = await allDrops(id);
      expect(drops.reduce((sum, drop) => sum + drop.geValue, 0)).toBe(bySource.totals.geValue);
      expect(new Set(drops.map((drop) => drop.lootEventId)).size).toBe(bySource.totals.lootCount);
    }
  });

  it('pages through every drop exactly once, newest first', async () => {
    const drops = await allDrops('all');
    expect(drops).toHaveLength(database.db.select({ n: count() }).from(lootItems).get()?.n ?? 0);
    expect(
      drops.every((drop, i) => i === 0 || drop.occurredAt <= (drops[i - 1]?.occurredAt ?? '')),
    ).toBe(true);
    // One loot event's items are adjacent: its ID never comes back after another event.
    const eventOrder = drops
      .map((drop) => drop.lootEventId)
      .filter((id, i, all) => id !== all[i - 1]);
    expect(new Set(eventOrder).size).toBe(eventOrder.length);

    const big = await allDrops('all', '&minValue=100000');
    expect(big.every((drop) => drop.geValue >= 100_000)).toBe(true);
    expect(big).toEqual(drops.filter((drop) => drop.geValue >= 100_000));
  });

  it('gives valid KC, with `all` summing the accounts', async () => {
    const perAccount = await Promise.all(
      ids.slice(0, -1).map((id) => get(`/api/v1/accounts/${id}/kc`, kcResponseSchema)),
    );
    const all = await get('/api/v1/accounts/all/kc', kcResponseSchema);
    expect(all.bosses.length).toBeGreaterThan(0);
    for (const boss of all.bosses) {
      const sum = perAccount
        .flatMap((kc) => kc.bosses)
        .filter((other) => other.boss === boss.boss)
        .reduce((total, other) => total + other.killCount, 0);
      expect(boss.killCount, boss.boss).toBe(sum);
      const gained = perAccount
        .flatMap((kc) => kc.bosses)
        .filter((other) => other.boss === boss.boss)
        .reduce((total, other) => total + other.gainedLast30Days, 0);
      expect(boss.gainedLast30Days, boss.boss).toBe(gained);
      // One entry per account that has the boss, with that account's KC.
      const expected = perAccount.flatMap((kc, index) =>
        kc.bosses
          .filter((other) => other.boss === boss.boss)
          .map((other) => ({ accountId: Number(ids[index]), killCount: other.killCount })),
      );
      expect(boss.byAccount, boss.boss).toEqual(expected);
    }
    // Half a month of seed data, all inside the 30-day window.
    expect(all.bosses.some((boss) => boss.gainedLast30Days > 0)).toBe(true);
  });

  it('gives the same 30-day KC gain as the sessions, when all data is in the window', async () => {
    // The seed's KC only goes up, so the sum of the session gains per boss is
    // the highest KC minus the first one, which is the 30-day rule here.
    for (const id of ids) {
      const kc = await get(`/api/v1/accounts/${id}/kc`, kcResponseSchema);
      const fromSessions = new Map<string, number>();
      let cursor: string | null = null;
      do {
        const page: z.infer<typeof sessionsResponseSchema> = await get(
          `/api/v1/accounts/${id}/sessions?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
          sessionsResponseSchema,
        );
        for (const session of page.items) {
          // An open session has no summary yet: use the detail's KC.
          const gains = session.summary
            ? Object.entries(session.summary.kcGainedByBoss)
            : (await get(`/api/v1/sessions/${session.id}`, sessionDetailResponseSchema)).kc.map(
                (kc) => [kc.boss, kc.gained] as const,
              );
          for (const [boss, gained] of gains) {
            fromSessions.set(boss, (fromSessions.get(boss) ?? 0) + gained);
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      for (const boss of kc.bosses) {
        expect(boss.gainedLast30Days, `${id} ${boss.boss}`).toBe(fromSessions.get(boss.boss) ?? 0);
      }
    }
  });
});
