import type {
  ClogSource,
  CollectionLogResponse,
  CollectionLogStatusResponse,
  CollectionLogTab,
} from '@fireside/shared';
import { asc, desc, eq } from 'drizzle-orm';
import { clogSourceRow, clogSyncState } from '../clog/sync.js';
import type { Queryable } from '../db/index.js';
import { clogItems, clogObtained, clogSnapshots } from '../db/schema.js';

// `GET /accounts/:accountId/collection-log` and `…/collection-log/status`.

export interface CollectionLogReadOptions {
  /** The source is on in `.env`. */
  sourceActive: boolean;
  /** A sync of the account is running. */
  syncing: boolean;
  nowMs: number;
}

/** The account's source and sync state. Both `null` without a source. */
export function collectionLogSync(
  db: Queryable,
  accountId: number,
  options: CollectionLogReadOptions,
): Pick<CollectionLogResponse, 'accountId' | 'source' | 'sync'> {
  const row = clogSourceRow(db, accountId);
  return {
    accountId,
    source: (row?.source as ClogSource | undefined) ?? null,
    sync: row ? clogSyncState(row, options) : null,
  };
}

/**
 * The collection log without its tabs: the source, whether the server can
 * use it, the sync state and the counts of the latest stored collection log.
 * Reads no item rows.
 */
export function collectionLogStatus(
  db: Queryable,
  accountId: number,
  options: CollectionLogReadOptions,
): CollectionLogStatusResponse {
  const { source, ...rest } = collectionLogSync(db, accountId, options);
  // Same order as the contract: the server's side right after the account's.
  const state = { source, sourceAvailable: options.sourceActive, ...rest };
  const latest = db
    .select()
    .from(clogSnapshots)
    .where(eq(clogSnapshots.accountId, accountId))
    .orderBy(desc(clogSnapshots.snapshotId))
    .limit(1)
    .get();
  if (!latest) return { ...state, updatedAt: null, obtained: null, total: null };
  return { ...state, updatedAt: latest.takenAt, obtained: latest.obtained, total: latest.total };
}

export function collectionLog(
  db: Queryable,
  accountId: number,
  options: CollectionLogReadOptions,
): CollectionLogResponse {
  const status = collectionLogStatus(db, accountId, options);
  if (status.updatedAt === null) return { ...status, tabs: [] };

  const firstSeen = new Map(
    db
      .select()
      .from(clogObtained)
      .where(eq(clogObtained.accountId, accountId))
      .all()
      .map((row) => [row.itemId, row]),
  );
  const rows = db
    .select()
    .from(clogItems)
    .where(eq(clogItems.accountId, accountId))
    .orderBy(asc(clogItems.tabPosition), asc(clogItems.pagePosition), asc(clogItems.position))
    .all();

  // An item on several pages is obtained on all of them if any page has it.
  const quantities = new Map<number, number>();
  for (const row of rows) {
    quantities.set(row.itemId, Math.max(quantities.get(row.itemId) ?? 0, row.quantity));
  }

  const tabs: CollectionLogTab[] = [];
  let tabPosition = -1;
  let pagePosition = -1;
  for (const row of rows) {
    if (row.tabPosition !== tabPosition) {
      tabs.push({ name: row.tab, pages: [] });
      tabPosition = row.tabPosition;
      pagePosition = -1;
    }
    const tab = tabs[tabs.length - 1];
    if (!tab) continue;
    if (row.pagePosition !== pagePosition) {
      tab.pages.push({ name: row.page, obtained: 0, total: 0, items: [] });
      pagePosition = row.pagePosition;
    }
    const page = tab.pages[tab.pages.length - 1];
    if (!page) continue;
    const quantity = quantities.get(row.itemId) ?? 0;
    const obtained = quantity > 0;
    const seen = obtained ? firstSeen.get(row.itemId) : undefined;
    page.items.push({
      itemId: row.itemId,
      name: row.name,
      quantity,
      obtained,
      firstSeenAt: seen?.firstSeenAt ?? null,
      approximate: seen?.firstSeenAt != null && seen.approximate,
    });
    page.total++;
    if (obtained) page.obtained++;
  }

  return { ...status, tabs };
}
