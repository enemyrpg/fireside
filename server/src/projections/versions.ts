import { performance } from 'node:perf_hooks';
import type BetterSqlite3 from 'better-sqlite3';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { rebuildClog } from '../clog/project.js';
import type { Db, DatabaseUpgrade, Queryable, UpgradeReport } from '../db/index.js';
import { getTableName } from 'drizzle-orm';
import {
  accountNames,
  accountPets,
  accounts,
  bankSnapshotItems,
  bankSnapshots,
  clogFeedTimes,
  clogItems,
  clogObtained,
  clogSnapshots,
  containerSnapshotItems,
  diaryCompletions,
  diarySnapshots,
  diaryStates,
  events,
  kcObservations,
  lootEvents,
  lootItems,
  pbRecords,
  petDrops,
  potionStorageItems,
  potionStorageSnapshots,
  projectionVersions,
  questCompletions,
  questSnapshots,
  questStates,
  raidDropChoices,
  raidSpecialLoot,
  sessionAfkEstimates,
  sessionAfkPeriods,
  sessionHeartbeats,
  sessionSummaries,
  sessions,
  weeklySummaries,
  xpSnapshotSkills,
  xpSnapshots,
} from '../db/schema.js';
import { rebuildProjectionsIn, type Projection, type ProjectionLogger } from './framework.js';
import { PROJECTIONS } from './index.js';

// Rule changes to projections reach existing data at startup
// (docs/decisions/0017-projection-rule-changes-recompute-at-startup.md).
//
// `projection_versions` holds the rules version each projection's rows were
// built with; a missing row is version 1. At startup, after migrations and
// in the same transaction, every projection whose version in code is newer is
// brought up to date: with its own `recompute`, or by a full rebuild if one
// of them has none. Then the current versions are stored. A rebuild stores
// them too, since it builds everything with the current rules.

const TABLE = 'projection_versions';

function versionOf(projection: Projection): number {
  return projection.version ?? 1;
}

/** Stored versions by name. Empty for a database from before the table. Only reads. */
function storedVersions(sqlite: BetterSqlite3.Database): Map<string, number> {
  const hasTable =
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE) !==
    undefined;
  if (!hasTable) return new Map();
  const rows = sqlite.prepare(`SELECT name, version FROM "${TABLE}"`).all() as {
    name: string;
    version: number;
  }[];
  return new Map(rows.map((row) => [row.name, row.version]));
}

/** The projections whose rows were built with older rules than the code's. Only reads. */
export function outdatedProjections(
  sqlite: BetterSqlite3.Database,
  projections: readonly Projection[] = PROJECTIONS,
): Projection[] {
  const stored = storedVersions(sqlite);
  return projections.filter((p) => (stored.get(p.name) ?? 1) < versionOf(p));
}

/** Stores the code's version of every projection, e.g. after a rebuild. */
export function recordCurrentVersions(
  tx: Queryable,
  projections: readonly Projection[] = PROJECTIONS,
  now: Clock = systemClock,
): void {
  const updatedAt = now().toISOString();
  for (const projection of projections) {
    const row = { version: versionOf(projection), updatedAt };
    tx.insert(projectionVersions)
      .values({ name: projection.name, ...row })
      .onConflictDoUpdate({ target: projectionVersions.name, set: row })
      .run();
  }
}

export interface UpgradeOptions {
  projections?: readonly Projection[];
  now?: Clock;
  log?: ProjectionLogger;
}

/**
 * SQL names of the tables a full rebuild empties and fills again: what every
 * projection's `reset` and `resetClogTables` delete (checked by a test).
 */
export const REBUILT_TABLES: readonly string[] = [
  accountNames,
  accountPets,
  accounts,
  bankSnapshotItems,
  bankSnapshots,
  clogFeedTimes,
  clogItems,
  clogObtained,
  clogSnapshots,
  containerSnapshotItems,
  diaryCompletions,
  diarySnapshots,
  diaryStates,
  kcObservations,
  lootEvents,
  lootItems,
  pbRecords,
  petDrops,
  potionStorageItems,
  potionStorageSnapshots,
  questCompletions,
  questSnapshots,
  questStates,
  raidSpecialLoot,
  sessionAfkEstimates,
  sessionAfkPeriods,
  sessionHeartbeats,
  sessionSummaries,
  sessions,
  weeklySummaries,
  xpSnapshotSkills,
  xpSnapshots,
].map((table) => getTableName(table));

/**
 * Tables that are not derived but that an upgrade by full rebuild may still
 * change: the raid split choices of drops that are definitely gone are
 * deleted, and before the upgrade to nearest-chest matching chest-key choices
 * move to their drop's event key (raids/choice-keys.ts).
 */
export const REBUILD_SETTLED_TABLES: readonly string[] = [getTableName(raidDropChoices)];

/** Columns of raw tables a full rebuild sets again: when each event was projected. */
export const REBUILT_COLUMNS: Readonly<Record<string, string[]>> = {
  [getTableName(events)]: ['processed_at', 'projection_error'],
};

/**
 * Brings `outdated` up to date inside the caller's transaction, then stores
 * the current versions. A projection without `recompute` makes it a full
 * rebuild, which covers the others too.
 */
export function recomputeOutdated(
  tx: Queryable,
  outdated: readonly Projection[],
  { projections = PROJECTIONS, now = systemClock, log }: UpgradeOptions = {},
): UpgradeReport {
  const start = performance.now();
  const at = now();
  const counts: Record<string, number> = {};
  const tables = new Set<string>([getTableName(projectionVersions)]);
  const columns: Record<string, string[]> = {};
  for (const projection of outdated) Object.assign(counts, projection.beforeUpgrade?.(tx));
  if (outdated.every((projection) => projection.recompute !== undefined)) {
    for (const projection of outdated) {
      const result = projection.recompute?.(tx, { now: at });
      for (const table of result?.tables ?? []) tables.add(table);
      Object.assign(counts, result?.counts);
    }
  } else {
    // Same as `rebuildDerivedTables`, inside this transaction.
    const result = rebuildProjectionsIn(tx, {
      projections,
      now: () => at,
      ...(log ? { log } : {}),
    });
    rebuildClog(tx, log);
    for (const table of [...REBUILT_TABLES, ...REBUILD_SETTLED_TABLES]) tables.add(table);
    Object.assign(columns, REBUILT_COLUMNS);
    counts.events = result.processed;
    counts.failed = result.failed.length;
  }
  recordCurrentVersions(tx, projections, () => at);
  return {
    projections: outdated.map((projection) => projection.name),
    counts,
    tables: [...tables].sort(),
    columns,
    durationMs: Math.round(performance.now() - start),
  };
}

/** The `upgrade` for `openDatabase`: recomputes outdated projections after migrating. */
export function projectionUpgrade(options: UpgradeOptions = {}): DatabaseUpgrade {
  const projections = options.projections ?? PROJECTIONS;
  return {
    pending: (sqlite) => outdatedProjections(sqlite, projections).length > 0,
    run: (db: Db, sqlite) =>
      recomputeOutdated(db, outdatedProjections(sqlite, projections), options),
  };
}
