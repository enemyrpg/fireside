import {
  raidDropResponseSchema,
  raidSplitsResponseSchema,
  type Event,
  type RaidDrop,
  type RaidSplitsResponse,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { rebuildDerivedTables, retryFailedEvents } from '../admin/rebuild.js';
import { buildApp } from '../app.js';
import { raidDropChoices } from '../db/schema.js';
import { PROJECTIONS, type Projection } from '../projections/index.js';
import { sessionsProjection } from '../projections/sessions.js';
import {
  emptyRun,
  eventFactory,
  failingFor,
  ingestBatch,
  type TestRun,
} from '../projections/testing.js';
import {
  outdatedProjections,
  projectionUpgrade,
  recomputeOutdated,
  recordCurrentVersions,
} from '../projections/versions.js';
import { testConfig } from '../test-utils.js';

// The user's split choices are typed by hand and can't be rebuilt from raw
// events. They must stay on the drop they were made for when a drop changes
// keys (chest → event), when a projection fails and is retried, on rebuild,
// and when the matching rule changes. Only a choice whose drop is definitely
// gone (its event projected fine and no drop has its key) is removed.

const FANG = { itemId: 26219, name: "Osmumten's fang", quantity: 1, gePrice: 24_000_000 };
const TOA = { type: 'EVENT', name: 'Tombs of Amascut' } as const;
const coins = { itemId: 995, name: 'Coins', quantity: 50_000, gePrice: 1, haPrice: 1 };
const fangItem = { ...FANG, haPrice: 0 };

let app: FastifyInstance | undefined;
let run: TestRun;
let clock = new Date('2026-11-10T12:00:00.000Z');
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function start(events: readonly Event[], projections: readonly Projection[] = PROJECTIONS) {
  run = emptyRun();
  ingestBatch(run, events, projections);
  clock = new Date('2026-11-10T12:00:00.000Z');
  app = buildApp({ db: run.database, config: testConfig(), dashboard: { now: () => clock } });
}

/** Moves the app's clock on, so the next write is newer. */
function later(): void {
  clock = new Date(clock.getTime() + 60_000);
}

async function splits(): Promise<RaidSplitsResponse> {
  if (!app) throw new Error('start() sets app');
  const response = await app.inject({ method: 'GET', url: '/api/v1/accounts/1/raids/splits' });
  expect(response.statusCode, response.body).toBe(200);
  return raidSplitsResponseSchema.parse(response.json());
}

async function patched(dropId: string, payload: object): Promise<RaidDrop> {
  if (!app) throw new Error('start() sets app');
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/v1/accounts/1/raids/drops/${dropId}`,
    payload,
  });
  expect(response.statusCode, response.body).toBe(200);
  return raidDropResponseSchema.parse(response.json()).drop;
}

const choiceRows = () =>
  run.database.db
    .select({ eventId: raidDropChoices.eventId, itemIndex: raidDropChoices.itemIndex })
    .from(raidDropChoices)
    .all();

const rebuild = (projections: readonly Projection[] = PROJECTIONS) =>
  rebuildDerivedTables(run.database.db, { projections, now: () => clock });
const reprocess = () => retryFailedEvents(run.database.db, { now: () => clock });

describe('split choices across failures and rebuilds', () => {
  it('reads both rows after a retry without moving them, and an edit collapses them', async () => {
    const f = eventFactory();
    const chest = f.loot('19:00', { source: TOA, items: [coins, fangItem] });
    const special = f.raidSpecialLoot('19:00', { item: FANG, teamSize: 3 });
    start([f.sessionStart('18:00'), chest, special]);

    // Made on the drop as the event: under the event key.
    await patched(special.eventId, { ownValue: 20_000_000, note: 'old note' });

    // A rule bug makes the event fail in a rebuild: the drop falls back to the chest.
    expect(rebuild([...PROJECTIONS, failingFor(new Set([special.eventId]))]).failed).toHaveLength(
      1,
    );
    const fallback = (await splits()).drops.items;
    expect(fallback.map((drop) => drop.dropId)).toEqual([`${chest.eventId}.1`]);
    // The event's choice is not shown now, but it is kept.
    expect(fallback[0]).toMatchObject({ note: null, ownValue: null });
    expect(choiceRows()).toEqual([{ eventId: special.eventId, itemIndex: 0 }]);

    // A newer choice on the fallback: conflicts in the note, has no own value.
    later();
    await patched(`${chest.eventId}.1`, { note: 'new note', mode: 'FFA' });

    // Fixed and retried: one drop showing both rows merged (the newer note
    // wins, the empty own value does not hide the older one), still two rows.
    expect(reprocess().failed).toEqual([]);
    const merged = {
      dropId: special.eventId,
      note: 'new note',
      mode: 'FFA',
      overridden: true,
      ownValue: 20_000_000,
    };
    expect((await splits()).drops.items).toEqual([expect.objectContaining(merged)]);
    expect(choiceRows()).toHaveLength(2);
    expect(rebuild().failed).toEqual([]);
    expect(choiceRows()).toHaveLength(2);

    // The owner's edit stores what they saw plus the change under the event key.
    later();
    expect(await patched(special.eventId, { partySize: 4 })).toMatchObject({
      ...merged,
      partySize: 4,
    });
    expect(choiceRows()).toEqual([{ eventId: special.eventId, itemIndex: 0 }]);
  });

  it('keeps a field the owner cleared empty when the drop had two rows', async () => {
    const f = eventFactory();
    const chest = f.loot('19:00', { source: TOA, items: [fangItem] });
    const special = f.raidSpecialLoot('19:00', { item: FANG, teamSize: 3 });
    start([f.sessionStart('18:00'), chest, special]);
    // Two rows without an edit: the older event row has the note, the newer
    // chest row an own value.
    run.database.db
      .insert(raidDropChoices)
      .values([
        {
          eventId: special.eventId,
          itemIndex: 0,
          note: 'old note',
          updatedAt: '2026-11-09T10:00:00.000Z',
        },
        {
          eventId: chest.eventId,
          itemIndex: 0,
          ownValue: 5,
          updatedAt: '2026-11-09T11:00:00.000Z',
        },
      ])
      .run();
    expect((await splits()).drops.items).toEqual([
      expect.objectContaining({ dropId: special.eventId, note: 'old note', ownValue: 5 }),
    ]);

    // The owner clears the note, which only the older row had.
    later();
    await patched(special.eventId, { note: null });
    const cleared = { dropId: special.eventId, note: null, ownValue: 5 };
    expect((await splits()).drops.items).toEqual([expect.objectContaining(cleared)]);
    expect(choiceRows()).toEqual([{ eventId: special.eventId, itemIndex: 0 }]);
    expect(rebuild().failed).toEqual([]);
    expect((await splits()).drops.items).toEqual([expect.objectContaining(cleared)]);
  });

  it('shows a chest choice on the event’s drop after a retry, still under the chest key', async () => {
    const f = eventFactory();
    const chest = f.loot('19:00', { source: TOA, items: [fangItem] });
    const special = f.raidSpecialLoot('19:00', { item: FANG, teamSize: 3 });
    start(
      [f.sessionStart('18:00'), chest, special],
      [...PROJECTIONS, failingFor(new Set([special.eventId]))],
    );
    await patched(`${chest.eventId}.0`, { note: 'from the chest' });

    expect(reprocess().failed).toEqual([]);
    const shown = [expect.objectContaining({ dropId: special.eventId, note: 'from the chest' })];
    expect((await splits()).drops.items).toEqual(shown);
    expect(choiceRows()).toEqual([{ eventId: chest.eventId, itemIndex: 0 }]);
    expect(rebuild().failed).toEqual([]);
    expect((await splits()).drops.items).toEqual(shown);
    expect(choiceRows()).toEqual([{ eventId: chest.eventId, itemIndex: 0 }]);
  });

  // Two fangs in one session: the first only known from its chest, with a
  // note. The second fang's event comes before its own chest, so for a while
  // it is matched with the first chest. Once its chest arrives the note must
  // be on the first fang again, whether the event came in by ingest, by a
  // retry or by a rebuild.
  it.each(['ingest', 'reprocess', 'rebuild'] as const)(
    'keeps a chest choice on its fang when another fang’s event comes before its chest (%s)',
    async (path) => {
      const f = eventFactory();
      const firstChest = f.loot('19:00', { source: TOA, items: [fangItem] });
      const special = f.raidSpecialLoot('19:40', { item: FANG, teamSize: 3 });
      const secondChest = f.loot('19:41', { source: TOA, items: [fangItem] });
      start([f.sessionStart('18:00'), firstChest]);
      await patched(`${firstChest.eventId}.0`, { note: 'first fang' });

      if (path === 'reprocess') {
        ingestBatch(run, [special], [...PROJECTIONS, failingFor(new Set([special.eventId]))]);
        expect(reprocess().failed).toEqual([]);
      } else {
        ingestBatch(run, [special]);
        if (path === 'rebuild') expect(rebuild().failed).toEqual([]);
      }
      // For now the event is matched with the only fang chest.
      expect((await splits()).drops.items).toEqual([
        expect.objectContaining({ dropId: special.eventId, note: 'first fang' }),
      ]);

      ingestBatch(run, [secondChest]);
      const expected = [
        expect.objectContaining({ dropId: special.eventId, note: null }),
        expect.objectContaining({ dropId: `${firstChest.eventId}.0`, note: 'first fang' }),
      ];
      expect((await splits()).drops.items).toEqual(expected);
      // A rebuild replays the event before its chest too.
      expect(rebuild().failed).toEqual([]);
      expect((await splits()).drops.items).toEqual(expected);
      expect(choiceRows()).toEqual([{ eventId: firstChest.eventId, itemIndex: 0 }]);
    },
  );

  it('keeps a teammate nickname while its event fails, and shows it again once retried', async () => {
    const f = eventFactory();
    const teammate = f.raidSpecialLoot('19:00', { item: FANG, recipient: 'TEAMMATE', teamSize: 3 });
    start([f.sessionStart('18:00'), teammate]);
    await patched(teammate.eventId, { nickname: 'Nickname K', note: 'a note' });

    rebuild([...PROJECTIONS, failingFor(new Set([teammate.eventId]))]);
    expect((await splits()).drops.items).toEqual([]);
    // Not shown, but never deleted for a failed event.
    expect(choiceRows()).toEqual([{ eventId: teammate.eventId, itemIndex: 0 }]);
    // Not even by a second rebuild or a retry that fails again.
    rebuild([...PROJECTIONS, failingFor(new Set([teammate.eventId]))]);
    retryFailedEvents(run.database.db, {
      projections: [...PROJECTIONS, failingFor(new Set([teammate.eventId]))],
      now: () => clock,
    });
    expect(choiceRows()).toHaveLength(1);

    expect(reprocess().failed).toEqual([]);
    expect((await splits()).drops.items).toEqual([
      expect.objectContaining({ dropId: teammate.eventId, nickname: 'Nickname K', note: 'a note' }),
    ]);
  });

  it('keeps every choice through a plain rebuild', async () => {
    const f = eventFactory();
    const chest = f.loot('19:00', { source: TOA, items: [fangItem] });
    const special = f.raidSpecialLoot('19:00', { item: FANG, teamSize: 3 });
    const onlyChest = f.loot('20:00', { source: TOA, items: [fangItem] });
    const teammate = f.raidSpecialLoot('21:00', { item: FANG, recipient: 'TEAMMATE' });
    start([f.sessionStart('18:00'), chest, special, onlyChest, teammate]);
    await patched(special.eventId, { note: 'own' });
    await patched(`${onlyChest.eventId}.0`, { ownValue: 1 });
    await patched(teammate.eventId, { nickname: 'Nickname L' });
    const before = await splits();
    const rows = run.database.db.select().from(raidDropChoices).all();

    expect(rebuild().failed).toEqual([]);
    expect(await splits()).toEqual(before);
    expect(run.database.db.select().from(raidDropChoices).all()).toEqual(rows);
  });

  it('deletes only a choice whose drop is gone although its event projected fine', () => {
    const f = eventFactory();
    const chest = f.loot('19:00', { source: TOA, items: [coins, fangItem] });
    const failing = f.loot('19:30', { source: TOA, items: [coins, fangItem] });
    start(
      [f.sessionStart('18:00'), chest, failing],
      [...PROJECTIONS, failingFor(new Set([failing.eventId]))],
    );
    // Choices under the coins' positions: as if the item had stopped being a
    // purple (game data changed). One chest is fine, the other fails.
    const at = clock.toISOString();
    run.database.db
      .insert(raidDropChoices)
      .values([
        { eventId: chest.eventId, itemIndex: 0, note: 'Zq9 gone', updatedAt: at },
        { eventId: failing.eventId, itemIndex: 0, note: 'Zq9 kept', updatedAt: at },
        { eventId: chest.eventId, itemIndex: 1, note: 'Zq9 shown', updatedAt: at },
      ])
      .run();
    const warnings: { obj: object; msg: string }[] = [];
    const log = {
      info: () => undefined,
      warn: (obj: object, msg: string) => warnings.push({ obj, msg }),
    };

    // A retry that projects nothing (the event fails again) removes nothing.
    retryFailedEvents(run.database.db, {
      projections: [...PROJECTIONS, failingFor(new Set([failing.eventId]))],
      now: () => clock,
      log,
    });
    expect(choiceRows()).toHaveLength(3);

    rebuildDerivedTables(run.database.db, {
      projections: [...PROJECTIONS, failingFor(new Set([failing.eventId]))],
      now: () => clock,
      log,
    });
    expect(choiceRows()).toEqual(
      expect.arrayContaining([
        { eventId: failing.eventId, itemIndex: 0 },
        { eventId: chest.eventId, itemIndex: 1 },
      ]),
    );
    expect(choiceRows()).toHaveLength(2);
    // A count, never the text.
    expect(warnings).toContainEqual({
      obj: { deleted: 1 },
      msg: 'Removed split choices of drops that no longer exist',
    });
    expect(JSON.stringify(warnings)).not.toContain('Zq9');
  });
});

describe('nearest-chest matching (raid-special-loot version 2)', () => {
  /**
   * Two chest fangs (19:00 and 19:40) and the 19:40 fang's own event. Built
   * with the current rules, then turned into what version 1 stored: the event
   * matched to the oldest chest, and the 19:40 chest on its own.
   */
  function versionOneRun() {
    const f = eventFactory();
    const first = f.loot('19:00', { source: TOA, items: [fangItem], killCount: 140 });
    const second = f.loot('19:40', { source: TOA, items: [fangItem], killCount: 141 });
    const special = f.raidSpecialLoot('19:40', { item: FANG, teamSize: 3 });
    start([f.sessionStart('18:00'), first, second, special]);
    recordCurrentVersions(run.database.db, PROJECTIONS, () => clock);
    run.database.sqlite.exec(`
      UPDATE raid_special_loot SET loot_event_id = NULL
        WHERE special_event_id = '${special.eventId}';
      UPDATE raid_special_loot SET loot_event_id = '${second.eventId}',
          occurred_at = '${second.occurredAt}', kill_count = 141
        WHERE special_event_id IS NULL;
      UPDATE raid_special_loot SET loot_event_id = '${first.eventId}', kill_count = 140
        WHERE special_event_id = '${special.eventId}';
      UPDATE projection_versions SET version = 1 WHERE name = 'raid-special-loot';
    `);
    return { first, second, special };
  }

  it('re-keys a drop with a choice and keeps the choice on it in the startup recompute', async () => {
    const { first, second, special } = versionOneRun();
    // Version 1 showed the event's drop with the 19:00 chest, and the 19:00
    // chest's key held its choice (made while only the chest was known).
    run.database.db
      .insert(raidDropChoices)
      .values({
        eventId: first.eventId,
        itemIndex: 0,
        note: 'the 19:40 fang',
        ownValue: 21_000_000,
        updatedAt: clock.toISOString(),
      })
      .run();
    const shown = (await splits()).drops.items.find((drop) => drop.dropId === special.eventId);
    expect(shown).toMatchObject({ note: 'the 19:40 fang', killCount: 140 });

    const upgrade = projectionUpgrade({ now: () => clock });
    expect(upgrade.pending(run.database.sqlite)).toBe(true);
    const report = upgrade.run(run.database.db, run.database.sqlite);
    expect(report.projections).toEqual(['raid-special-loot']);
    expect(report.counts).toMatchObject({ choicesMoved: 1, choicesDeleted: 0 });
    expect(report.tables).toEqual(expect.arrayContaining(['raid_drop_choices']));

    const drops = (await splits()).drops.items;
    expect(drops).toEqual([
      expect.objectContaining({
        dropId: special.eventId,
        killCount: 141,
        note: 'the 19:40 fang',
        ownValue: 21_000_000,
      }),
      expect.objectContaining({ dropId: `${first.eventId}.0`, note: null, ownValue: null }),
    ]);
    expect(drops.some((drop) => drop.dropId.startsWith(second.eventId))).toBe(false);
    expect(choiceRows()).toEqual([{ eventId: special.eventId, itemIndex: 0 }]);
  });

  it('keeps the choice on the same drop when the upgrade falls back to a full rebuild', async () => {
    const { first, special } = versionOneRun();
    run.database.db
      .insert(raidDropChoices)
      .values({
        eventId: first.eventId,
        itemIndex: 0,
        note: 'mine',
        updatedAt: clock.toISOString(),
      })
      .run();
    // Sessions outdated too and without a recompute: the upgrade is a full rebuild.
    run.database.sqlite.exec("UPDATE projection_versions SET version = 1 WHERE name = 'sessions'");
    const withoutRecompute: Projection = {
      name: sessionsProjection.name,
      version: sessionsProjection.version ?? 1,
      apply: (tx, event, context) => {
        sessionsProjection.apply(tx, event, context);
      },
      reset: (tx) => {
        sessionsProjection.reset(tx);
      },
      snapshot: (db) => sessionsProjection.snapshot(db),
    };
    const projections = PROJECTIONS.map((p) => (p.name === 'sessions' ? withoutRecompute : p));
    const outdated = outdatedProjections(run.database.sqlite, projections);
    expect(outdated.map((p) => p.name)).toEqual(['sessions', 'raid-special-loot']);
    const report = recomputeOutdated(run.database.db, outdated, { projections, now: () => clock });
    expect(report.counts).toMatchObject({ failed: 0 });
    expect(report.tables).toEqual(expect.arrayContaining(['raid_drop_choices']));

    expect((await splits()).drops.items).toEqual([
      expect.objectContaining({ dropId: special.eventId, killCount: 141, note: 'mine' }),
      expect.objectContaining({ dropId: `${first.eventId}.0`, note: null }),
    ]);
    expect(choiceRows()).toEqual([{ eventId: special.eventId, itemIndex: 0 }]);
  });
});
