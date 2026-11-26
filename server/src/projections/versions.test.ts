import { getTableName, type Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { resetClogTables } from '../clog/project.js';
import type { Queryable } from '../db/index.js';
import { projectionVersions, sessions } from '../db/schema.js';
import { PROJECTIONS, type Projection } from './index.js';
import { sessionsProjection } from './sessions.js';
import { emptyRun, eventFactory, ingestBatch, TEST_NOW } from './testing.js';
import {
  outdatedProjections,
  projectionUpgrade,
  REBUILD_SETTLED_TABLES,
  REBUILT_COLUMNS,
  REBUILT_TABLES,
  recomputeOutdated,
  recordCurrentVersions,
} from './versions.js';

const idle = { payload: { idle: true } };

function versions(run: ReturnType<typeof emptyRun>): Record<string, number> {
  return Object.fromEntries(
    run.database.db
      .select({ name: projectionVersions.name, version: projectionVersions.version })
      .from(projectionVersions)
      .all()
      .map((row) => [row.name, row.version]),
  );
}

/** A run with one session whose AFK was built with the old rules (no estimate). */
function oldRun() {
  const run = emptyRun();
  const f = eventFactory();
  ingestBatch(
    run,
    [
      f.sessionStart('19:00'),
      f.heartbeat('19:01', idle),
      f.heartbeat('19:02', idle),
      f.heartbeat('19:03', idle),
      f.sessionEnd('19:04'),
    ],
    PROJECTIONS,
    TEST_NOW,
  );
  run.database.sqlite.exec(`
    DELETE FROM session_afk_estimates;
    UPDATE sessions SET afk_seconds = 0, active_seconds = duration_seconds;
  `);
  return run;
}

describe('projection versions', () => {
  it('counts a missing row as version 1', () => {
    const run = emptyRun();
    expect(outdatedProjections(run.database.sqlite).map((p) => p.name)).toEqual([
      'sessions',
      'kc',
      'raid-special-loot',
    ]);
    recordCurrentVersions(run.database.db);
    expect(outdatedProjections(run.database.sqlite)).toEqual([]);
    expect(versions(run)).toMatchObject({
      accounts: 1,
      sessions: 2,
      kc: 2,
      'raid-special-loot': 2,
    });
  });

  it('recomputes an outdated projection and records the versions', () => {
    const run = oldRun();
    const upgrade = projectionUpgrade({ now: () => TEST_NOW });
    expect(upgrade.pending(run.database.sqlite)).toBe(true);
    const report = upgrade.run(run.database.db, run.database.sqlite);
    expect(report).toMatchObject({
      projections: ['sessions', 'kc', 'raid-special-loot'],
      counts: {
        sessions: 1,
        kcObservationsRemoved: 0,
        raidSessions: 0,
        choicesMoved: 0,
        choicesDeleted: 0,
      },
      columns: {},
    });
    expect(report.tables).toEqual(
      expect.arrayContaining(['sessions', 'session_afk_estimates', 'projection_versions']),
    );
    expect(run.database.db.select({ afk: sessions.afkSeconds }).from(sessions).get()).toEqual({
      afk: 120,
    });
    expect(upgrade.pending(run.database.sqlite)).toBe(false);
    expect(versions(run).sessions).toBe(2);
  });

  it('does nothing when every version is current', () => {
    const run = emptyRun();
    recordCurrentVersions(run.database.db);
    expect(projectionUpgrade().pending(run.database.sqlite)).toBe(false);
  });

  it('records the versions on a rebuild', () => {
    const run = oldRun();
    rebuildDerivedTables(run.database.db, { now: () => TEST_NOW });
    expect(outdatedProjections(run.database.sqlite)).toEqual([]);
    expect(run.database.db.select({ afk: sessions.afkSeconds }).from(sessions).get()).toEqual({
      afk: 120,
    });
  });

  it('falls back to a full rebuild for a projection without recompute', () => {
    const run = oldRun();
    // The sessions rules, as if bumped without a recompute.
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
    // kc has a recompute, but one outdated projection without makes it a rebuild.
    expect(outdated.map((p) => p.name)).toEqual(['sessions', 'kc', 'raid-special-loot']);

    const report = recomputeOutdated(run.database.db, outdated, {
      projections,
      now: () => TEST_NOW,
    });
    expect(report.counts).toEqual({ events: 5, failed: 0 });
    expect(report.tables).toEqual(
      [...REBUILT_TABLES, ...REBUILD_SETTLED_TABLES, 'projection_versions'].sort(),
    );
    expect(report.columns).toEqual(REBUILT_COLUMNS);
    expect(run.database.db.select({ afk: sessions.afkSeconds }).from(sessions).get()).toEqual({
      afk: 120,
    });
  });

  it('lists exactly the tables a rebuild resets', () => {
    // Records `tx.delete(table)` calls without touching a database.
    const deleted = new Set<string>();
    const chain: Record<string, unknown> = {};
    for (const method of ['where', 'run']) chain[method] = () => chain;
    const tx = {
      delete: (table: Table) => {
        deleted.add(getTableName(table));
        return chain;
      },
    } as unknown as Queryable; // A stub: `reset` only deletes.
    for (const projection of PROJECTIONS) projection.reset(tx);
    resetClogTables(tx);
    expect([...REBUILT_TABLES].sort()).toEqual([...deleted].sort());
  });
});
