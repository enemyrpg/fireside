import {
  accountsResponseSchema,
  kcResponseSchema,
  lootResponseSchema,
  normalizeBossName,
  raidOf,
  raidSplitsResponseSchema,
  raidsResponseSchema,
  type SpecialLootItem,
} from '@fireside/shared';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import {
  raidDropChoices,
  raidManualDrops,
  raidSpecialLoot,
  raidSplitDefaults,
} from '../db/schema.js';
import type { SeedData } from '../seed/generator/generate.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a small seed run: raid KC comes out of the kc endpoint as
// raids with best times per team size, own purples are linked to the chest
// loot, teammates' purples never are, and loot value counts each purple once.
// The raids endpoint splits raid loot and own purples, and lists
// every purple once.

const OPTIONS = {
  seed: 7,
  accounts: 2,
  months: 0.5,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

describe('raids on seed data', () => {
  let app: FastifyInstance;
  let database: Database;
  let data: SeedData;
  let ids: string[] = [];

  beforeAll(async () => {
    const fixture = await loadSeedFixture(OPTIONS, { TZ: OPTIONS.timeZone });
    const { config, result } = fixture;
    ({ data, database } = fixture);
    expect(result.rejected).toEqual([]);
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

  it('lists raid modes as raids, with their raid and best times per team size', async () => {
    const seededModes = new Set(
      data.events.flatMap((e) =>
        e.type === 'kc' && raidOf(normalizeBossName(e.payload.boss))
          ? [normalizeBossName(e.payload.boss)]
          : [],
      ),
    );
    expect(seededModes.size).toBeGreaterThan(0);

    const { bosses } = await get('/api/v1/accounts/all/kc', kcResponseSchema);
    const raids = bosses.filter((boss) => boss.category === 'raid');
    expect(new Set(raids.map((boss) => boss.boss))).toEqual(seededModes);
    for (const boss of raids) {
      expect(boss.raid).toBe(raidOf(boss.boss)?.name);
      expect(boss.bestTimesByTeamSize.length).toBeGreaterThan(0);
      expect(boss.bestTimeSeconds).toBe(
        Math.min(...boss.bestTimesByTeamSize.map((time) => time.seconds)),
      );
    }
    for (const boss of bosses.filter((b) => b.category === 'boss')) {
      expect(boss.raid).toBeNull();
      expect(raidOf(boss.boss)).toBeUndefined();
    }

    // Best time per team size matches the seeded KC messages: the lowest
    // kill time or reported PB (older PBs are lower than any kill).
    const toa = raids.find((boss) => boss.boss === 'Tombs of Amascut');
    expect(toa).toBeDefined();
    const best = new Map<number, number>();
    for (const e of data.events) {
      if (e.type !== 'kc' || normalizeBossName(e.payload.boss) !== 'Tombs of Amascut') continue;
      const { teamSize, timeSeconds, personalBestSeconds } = e.payload;
      if (teamSize === undefined) continue;
      for (const seconds of [timeSeconds, personalBestSeconds]) {
        if (seconds !== undefined)
          best.set(teamSize, Math.min(best.get(teamSize) ?? Infinity, seconds));
      }
    }
    expect(toa?.bestTimesByTeamSize).toEqual(
      [...best].sort((a, b) => a[0] - b[0]).map(([teamSize, seconds]) => ({ teamSize, seconds })),
    );
  });

  it('links every own purple to the chest loot and never a teammate’s', () => {
    const rows = database.db
      .select()
      .from(raidSpecialLoot)
      .orderBy(asc(raidSpecialLoot.occurredAt))
      .all();
    const specials = data.events.filter((e) => e.type === 'raid.special_loot');
    expect(rows).toHaveLength(specials.length);
    expect(rows.some((row) => row.recipient === 'SELF')).toBe(true);
    expect(rows.some((row) => row.recipient === 'TEAMMATE')).toBe(true);
    for (const row of rows) {
      expect(row.specialEventId).not.toBeNull();
      if (row.recipient === 'SELF') {
        expect(row.lootEventId).not.toBeNull();
        expect(row.lootItemPosition).not.toBeNull();
      } else {
        expect(row.recipient).toBe('TEAMMATE');
        expect(row.lootEventId).toBeNull();
      }
    }
  });

  it('counts each purple once in the loot value', async () => {
    const totals = (await get('/api/v1/accounts/all/loot', lootResponseSchema)).totals;
    expect(totals.geValue).toBe(data.stats.lootGeValue);
    expect(totals.lootCount).toBe(data.stats.eventsByType.loot);
    // Per account too: the account totals add up to `all`.
    let sum = 0;
    for (const id of ids.filter((id) => id !== 'all')) {
      sum += (await get(`/api/v1/accounts/${id}/loot`, lootResponseSchema)).totals.geValue;
    }
    expect(sum).toBe(totals.geValue);
  });

  async function allSpecialLoot(scope: string): Promise<SpecialLootItem[]> {
    const items: SpecialLootItem[] = [];
    let cursor: string | null = null;
    do {
      const page: z.infer<typeof raidsResponseSchema> = await get(
        `/api/v1/accounts/${scope}/raids?limit=17${cursor === null ? '' : `&cursor=${cursor}`}`,
        raidsResponseSchema,
      );
      items.push(...page.specialLoot.items);
      cursor = page.specialLoot.nextCursor;
    } while (cursor !== null);
    return items;
  }

  it('splits raid loot and own purples so each purple counts once', async () => {
    let checkedSpecial = 0;
    for (const scope of ids) {
      const { raids } = await get(`/api/v1/accounts/${scope}/raids`, raidsResponseSchema);
      const loot = await get(`/api/v1/accounts/${scope}/loot`, lootResponseSchema);
      if (loot.groupBy !== 'source') throw new Error('groupBy defaults to source');
      const { groups } = loot;
      for (const summary of raids) {
        const raidGroups = groups.filter(
          (group) =>
            group.source.name !== null &&
            raidOf(normalizeBossName(group.source.name))?.name === summary.raid,
        );
        // Every own purple in seed has its chest, so the split adds up exactly.
        expect(summary.lootGeValue + summary.specialLootGeValue, summary.raid).toBe(
          raidGroups.reduce((sum, group) => sum + group.geValue, 0),
        );
        expect(summary.lootCount).toBe(raidGroups.reduce((sum, group) => sum + group.lootCount, 0));
        checkedSpecial += summary.specialLootGeValue;
      }
    }
    expect(checkedSpecial).toBeGreaterThan(0);
  });

  it('lists every seeded purple exactly once, own ones in special loot value', async () => {
    const items = await allSpecialLoot('all');
    const specials = data.events.filter((e) => e.type === 'raid.special_loot');
    const key = (at: string, itemId: number, recipient: string) =>
      `${at}/${String(itemId)}/${recipient}`;
    expect(items.map((item) => key(item.occurredAt, item.itemId, item.recipient)).sort()).toEqual(
      specials.map((e) => key(e.occurredAt, e.payload.item.itemId, e.payload.recipient)).sort(),
    );
    const { raids } = await get('/api/v1/accounts/all/raids', raidsResponseSchema);
    const own = items.filter((item) => item.recipient === 'SELF');
    expect(raids.reduce((sum, raid) => sum + raid.specialLootGeValue, 0)).toBe(
      own.reduce((sum, item) => sum + item.geValue, 0),
    );
    // Per account, the lists add up to `all`.
    let perAccount = 0;
    for (const id of ids.filter((id) => id !== 'all')) {
      const accountItems = await allSpecialLoot(id);
      expect(accountItems.every((item) => String(item.accountId) === id)).toBe(true);
      perAccount += accountItems.length;
    }
    expect(perAccount).toBe(items.length);
  });

  it('never names a player in the raids response', async () => {
    const names = data.events.flatMap((e) =>
      e.type === 'session.start' ? [e.payload.displayName] : [],
    );
    expect(names.length).toBeGreaterThan(0);
    const body = JSON.stringify(await allSpecialLoot('all'));
    for (const name of new Set(names)) expect(body).not.toContain(name);
  });

  // The split tracker's tables hold the user's own choices (nicknames among
  // them), so the seed never fills them.
  it('seeds no split choices, nicknames or manual drops', async () => {
    expect(database.db.select().from(raidSplitDefaults).all()).toEqual([]);
    expect(database.db.select().from(raidDropChoices).all()).toEqual([]);
    expect(database.db.select().from(raidManualDrops).all()).toEqual([]);

    for (const id of ids) {
      const splits = await get(
        `/api/v1/accounts/${id}/raids/splits?limit=100`,
        raidSplitsResponseSchema,
      );
      const raids = await get(`/api/v1/accounts/${id}/raids?limit=100`, raidsResponseSchema);
      // The same purples as the special loot list, in the same order.
      expect(
        splits.drops.items.map((drop) => [drop.occurredAt, drop.itemId, drop.geValue]),
      ).toEqual(
        raids.specialLoot.items.map((item) => [item.occurredAt, item.itemId, item.geValue]),
      );
      expect(splits.defaults.every((account) => account.mode === 'SPLIT')).toBe(true);
      for (const drop of splits.drops.items) {
        expect(drop).toMatchObject({
          manual: false,
          nickname: null,
          note: null,
          ownValue: null,
          overridden: false,
        });
      }
    }
  });
});
