import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  clogFeedTimes,
  clogItems,
  clogObtained,
  clogSnapshots,
  externalSnapshots,
  weeklySummaries,
} from '../db/schema.js';
import { refreshAccountPets, refreshAllAccountPets } from '../pets/merge.js';
import { inChunks } from '../projections/bank.js';
import { invalidateWeeksFrom } from '../projections/weekly-summaries.js';
import type { ClogFeedEntry, ClogTabEntry } from './provider.js';
import { parseActivities, parseCollectionLog } from './runeprofile.js';

// The derived collection log tables, built from `external_snapshots`. Rows are
// applied in `id` order, which is the order they were stored in, so applying
// each row as it is stored and `rebuildClog` give the same tables.
//
// The weekly summary reads these tables by time (new items in a week, and the
// counts at its end), so each change deletes the stored weeks it can affect:
// the account's weeks that end after the earliest time that was set or
// changed (`invalidateWeeksFrom`, as events do). `rebuildClog` empties
// `weekly_summaries`.

export type ExternalSnapshotRow = typeof externalSnapshots.$inferSelect;

export interface ClogProjectionLogger {
  warn(obj: object, msg: string): void;
}

/** Rows loaded per query during a rebuild. A collection log body is about 150 KB. */
const REBUILD_CHUNK = 20;

/** Parsers per source. A new source adds its own here. */
const PARSERS: Record<
  string,
  { collectionLog(json: unknown): ClogTabEntry[]; feed(json: unknown): ClogFeedEntry[] } | undefined
> = {
  RUNEPROFILE: {
    collectionLog: parseCollectionLog,
    feed: (json) => parseActivities(json).entries,
  },
};

function applyCollectionLog(tx: Queryable, row: ExternalSnapshotRow, tabs: ClogTabEntry[]): void {
  const first =
    tx
      .select({ id: clogSnapshots.snapshotId })
      .from(clogSnapshots)
      .where(eq(clogSnapshots.accountId, row.accountId))
      .limit(1)
      .get() === undefined;

  const rows: (typeof clogItems.$inferInsert)[] = [];
  /** Unique items and whether the account has them. */
  const has = new Map<number, boolean>();
  tabs.forEach((tab, tabPosition) => {
    tab.pages.forEach((page, pagePosition) => {
      page.items.forEach((item, position) => {
        rows.push({
          accountId: row.accountId,
          tabPosition,
          pagePosition,
          position,
          tab: tab.name,
          page: page.name,
          itemId: item.itemId,
          name: item.name,
          quantity: item.quantity,
        });
        has.set(item.itemId, (has.get(item.itemId) ?? false) || item.quantity > 0);
      });
    });
  });

  tx.delete(clogItems).where(eq(clogItems.accountId, row.accountId)).run();
  inChunks(rows, (chunk) => tx.insert(clogItems).values(chunk).run());

  const known = new Set(
    tx
      .select({ itemId: clogObtained.itemId })
      .from(clogObtained)
      .where(eq(clogObtained.accountId, row.accountId))
      .all()
      .map((item) => item.itemId),
  );
  const feed = new Map(
    tx
      .select({ itemId: clogFeedTimes.itemId, obtainedAt: clogFeedTimes.obtainedAt })
      .from(clogFeedTimes)
      .where(eq(clogFeedTimes.accountId, row.accountId))
      .all()
      .map((time) => [time.itemId, time.obtainedAt]),
  );
  const obtained = [...has].filter(([, value]) => value).map(([itemId]) => itemId);
  const added = obtained
    .filter((itemId) => !known.has(itemId))
    .map((itemId) => {
      const feedTime = feed.get(itemId);
      return {
        accountId: row.accountId,
        itemId,
        // The feed's time if it has one. Otherwise: no time for what was
        // already there at the first sync, and this sync's time after that.
        firstSeenAt: feedTime ?? (first ? null : row.fetchedAt),
        approximate: feedTime === undefined && !first,
        snapshotId: row.id,
      };
    });
  inChunks(added, (chunk) => tx.insert(clogObtained).values(chunk).run());

  tx.insert(clogSnapshots)
    .values({
      snapshotId: row.id,
      accountId: row.accountId,
      source: row.source,
      takenAt: row.fetchedAt,
      obtained: obtained.length,
      total: has.size,
    })
    .run();

  // Weekly: the counts change from this snapshot's time, and a new item with
  // a feed time is new in the week of that (possibly much older) time.
  let from = row.fetchedAt;
  for (const item of added) {
    if (item.firstSeenAt !== null && item.firstSeenAt < from) from = item.firstSeenAt;
  }
  invalidateWeeksFrom(tx, row.accountId, from);
}

function applyFeed(tx: Queryable, row: ExternalSnapshotRow, entries: ClogFeedEntry[]): void {
  // The earliest time per item on this page.
  const earliest = new Map<number, string>();
  for (const entry of entries) {
    const current = earliest.get(entry.itemId);
    if (current === undefined || entry.obtainedAt < current) {
      earliest.set(entry.itemId, entry.obtainedAt);
    }
  }
  /** Weekly: the earliest first-seen time, old or new, that this page changed. */
  let changedFrom: string | undefined;
  const changed = (at: string | null) => {
    if (at !== null && (changedFrom === undefined || at < changedFrom)) changedFrom = at;
  };
  for (const [itemId, obtainedAt] of earliest) {
    // The earliest time known for the item, this page included.
    const time = tx
      .insert(clogFeedTimes)
      .values({ accountId: row.accountId, itemId, obtainedAt })
      .onConflictDoUpdate({
        target: [clogFeedTimes.accountId, clogFeedTimes.itemId],
        set: { obtainedAt: sql`min(${clogFeedTimes.obtainedAt}, excluded.obtained_at)` },
      })
      .returning({ obtainedAt: clogFeedTimes.obtainedAt })
      .get();
    const isItem = and(eq(clogObtained.accountId, row.accountId), eq(clogObtained.itemId, itemId));
    const current = tx
      .select({ firstSeenAt: clogObtained.firstSeenAt })
      .from(clogObtained)
      .where(isItem)
      .get();
    // The feed can have an item before the collection log has it.
    if (!current) continue;
    tx.update(clogObtained)
      .set({ firstSeenAt: time.obtainedAt, approximate: false })
      .where(isItem)
      .run();
    if (current.firstSeenAt !== time.obtainedAt) {
      // The item leaves the week of its old time and enters the week of the new one.
      changed(current.firstSeenAt);
      changed(time.obtainedAt);
    }
  }
  if (changedFrom !== undefined) invalidateWeeksFrom(tx, row.accountId, changedFrom);
}

/**
 * Applies one stored snapshot to the derived tables. A body that cannot be
 * read (an unknown source or kind, or a format this version does not know) is
 * skipped with a warning: the raw row stays. Returns whether it was applied.
 */
export function applyExternalSnapshot(
  tx: Queryable,
  row: ExternalSnapshotRow,
  log?: ClogProjectionLogger,
): boolean {
  const parser = PARSERS[row.source];
  if (!parser || (row.kind !== 'COLLECTION_LOG' && row.kind !== 'ACTIVITIES')) {
    log?.warn(
      { snapshotId: row.id, source: row.source, kind: row.kind, reason: 'UnknownSourceOrKind' },
      'Could not read a stored external snapshot, skipped',
    );
    return false;
  }
  // Everything is read before anything is written.
  let apply: () => void;
  try {
    const json = JSON.parse(row.body) as unknown;
    if (row.kind === 'COLLECTION_LOG') {
      const tabs = parser.collectionLog(json);
      apply = () => {
        applyCollectionLog(tx, row, tabs);
      };
    } else {
      const entries = parser.feed(json);
      apply = () => {
        applyFeed(tx, row, entries);
      };
    }
  } catch (error) {
    // The error's name only: never the body.
    log?.warn(
      {
        snapshotId: row.id,
        source: row.source,
        kind: row.kind,
        reason: error instanceof Error ? error.name : 'Error',
      },
      'Could not read a stored external snapshot, skipped',
    );
    return false;
  }
  apply();
  // Pets come from the "All Pets" page and its first-seen times.
  refreshAccountPets(tx, row.accountId);
  return true;
}

/**
 * Stores one response of a source unchanged in `external_snapshots` and
 * applies it to the derived tables. The one way raw external data gets in:
 * a sync and the seed both use it, so a rebuild reproduces either.
 */
export function storeExternalSnapshot(
  tx: Queryable,
  snapshot: Omit<typeof externalSnapshots.$inferInsert, 'id'>,
  log?: ClogProjectionLogger,
): void {
  const row = tx.insert(externalSnapshots).values(snapshot).returning().get();
  applyExternalSnapshot(tx, row, log);
}

/** Empties the derived collection log tables. Raw snapshots and the owner's settings stay. */
export function resetClogTables(tx: Queryable): void {
  tx.delete(clogObtained).run();
  tx.delete(clogFeedTimes).run();
  tx.delete(clogItems).run();
  tx.delete(clogSnapshots).run();
}

/**
 * Empties the derived collection log tables and builds them again from
 * `external_snapshots`. Call inside a transaction. Returns how many snapshots
 * were applied and how many were skipped because they could not be read.
 */
export function rebuildClog(
  tx: Queryable,
  log?: ClogProjectionLogger,
): { applied: number; skipped: number } {
  resetClogTables(tx);
  // Stored weeks hold collection log items and counts: computed again when read.
  tx.delete(weeklySummaries).run();
  // Pets known from the collection log go with it; each snapshot applied
  // below brings its account's pets back.
  refreshAllAccountPets(tx);
  let applied = 0;
  let skipped = 0;
  let after = 0;
  for (;;) {
    const rows = tx
      .select()
      .from(externalSnapshots)
      .where(gt(externalSnapshots.id, after))
      .orderBy(asc(externalSnapshots.id))
      .limit(REBUILD_CHUNK)
      .all();
    for (const row of rows) {
      if (applyExternalSnapshot(tx, row, log)) applied++;
      else skipped++;
      after = row.id;
    }
    if (rows.length < REBUILD_CHUNK) return { applied, skipped };
  }
}

/** The derived tables in a fixed order, for comparing in tests. */
export function clogTablesSnapshot(db: Queryable) {
  return {
    snapshots: db.select().from(clogSnapshots).orderBy(asc(clogSnapshots.snapshotId)).all(),
    items: db
      .select()
      .from(clogItems)
      .orderBy(
        asc(clogItems.accountId),
        asc(clogItems.tabPosition),
        asc(clogItems.pagePosition),
        asc(clogItems.position),
      )
      .all(),
    obtained: db
      .select()
      .from(clogObtained)
      .orderBy(asc(clogObtained.accountId), asc(clogObtained.itemId))
      .all(),
    feedTimes: db
      .select()
      .from(clogFeedTimes)
      .orderBy(asc(clogFeedTimes.accountId), asc(clogFeedTimes.itemId))
      .all(),
  };
}
