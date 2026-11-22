import { z } from 'zod';
import { nonNegativeInt, positiveInt, utcTimestamp } from '../common.js';
import { accountId } from './common.js';

// Collection log (since 1.25.0). Per account: `all` is not accepted.
//
// The data comes from a collection log source the owner turns on per account.
// The only source so far is RuneProfile (optional, off by default in `.env`).
// Whatever state the source is in, `GET …/collection-log` answers `200`: the
// state is in `sync.status`.

type Issues = z.core.ParsePayload['issues'];

function issue(issues: Issues, input: unknown, path: PropertyKey[], message: string) {
  issues.push({ code: 'custom', message, input, path });
}

/** Where an account's collection log can come from. */
export const CLOG_SOURCES = ['RUNEPROFILE'] as const;
export const clogSourceSchema = z.enum(CLOG_SOURCES);

/**
 * State of an account's collection log source:
 * - `OK`: the latest sync worked.
 * - `NEVER_SYNCED`: turned on, not tried yet.
 * - `SYNCING`: a sync is running now.
 * - `SOURCE_OFF`: the source is off in `.env` (its flag, or no `USER_AGENT_CONTACT`).
 * - `NO_NAME`: the account has no display name yet, or one the source cannot look up.
 * - `PROFILE_NOT_FOUND`: the source has no profile with the account's current
 *   name (never uploaded, or renamed and not uploaded since).
 * - `PROFILE_FROM_BEFORE_NAME`: the profile under that name was last updated
 *   before this server first saw the account with the name, so it may belong
 *   to the name's previous owner. Nothing was stored.
 * - `RATE_LIMITED`, `INVALID_API_KEY`, `UNAVAILABLE` (network, timeout, 5xx),
 *   `INVALID_RESPONSE` (the response had an unexpected format).
 */
export const CLOG_SYNC_STATUSES = [
  'OK',
  'NEVER_SYNCED',
  'SYNCING',
  'SOURCE_OFF',
  'NO_NAME',
  'PROFILE_NOT_FOUND',
  'PROFILE_FROM_BEFORE_NAME',
  'RATE_LIMITED',
  'INVALID_API_KEY',
  'UNAVAILABLE',
  'INVALID_RESPONSE',
] as const;
export const clogSyncStatusSchema = z.enum(CLOG_SYNC_STATUSES);

/** `…/collection-log` takes no query parameters. */
export const collectionLogQuerySchema = z.strictObject({});

export const clogSyncSchema = z.strictObject({
  status: clogSyncStatusSchema,
  /** The latest attempt, whatever its result. */
  lastAttemptAt: utcTimestamp.nullable(),
  /** The latest sync that worked. */
  lastSuccessAt: utcTimestamp.nullable(),
  /** The latest sync that found a changed collection log. */
  lastChangedAt: utcTimestamp.nullable(),
  /**
   * Earliest time `POST …/collection-log/sync` is accepted again. `null` when
   * a sync can be started now.
   */
  nextSyncAllowedAt: utcTimestamp.nullable(),
});

export const collectionLogItemSchema = z
  .strictObject({
    itemId: positiveInt,
    /** As the source gives it. Unknown items are shown by this name. */
    name: z.string().min(1),
    /** How many the account has obtained. 0 for a missing item. */
    quantity: nonNegativeInt,
    obtained: z.boolean(),
    /**
     * When the item was first obtained, as far as it is known. `null` for a
     * missing item, and for an item that was already there at the account's
     * first sync (obtained before tracking) unless the source's activity feed
     * has its time.
     */
    firstSeenAt: utcTimestamp.nullable(),
    /**
     * `true` when `firstSeenAt` is the time of the sync that first saw the
     * item, not the time it was obtained.
     */
    approximate: z.boolean(),
  })
  .check(({ value: item, issues }) => {
    if (item.obtained !== item.quantity > 0) {
      issue(issues, item.obtained, ['obtained'], 'obtained must be quantity > 0');
    }
    if (!item.obtained && item.firstSeenAt !== null) {
      issue(issues, item.firstSeenAt, ['firstSeenAt'], 'Only an obtained item has firstSeenAt');
    }
    if (item.approximate && item.firstSeenAt === null) {
      issue(issues, item.approximate, ['approximate'], 'Only a set firstSeenAt can be approximate');
    }
  });

export const collectionLogPageSchema = z
  .strictObject({
    name: z.string().min(1),
    /** Items on this page with `obtained`. */
    obtained: nonNegativeInt,
    /** Items on this page. */
    total: nonNegativeInt,
    /** In the order of the game's collection log. */
    items: z.array(collectionLogItemSchema),
  })
  .check(({ value: page, issues }) => {
    if (page.total !== page.items.length) {
      issue(issues, page.total, ['total'], 'total must be the number of items');
    }
    if (page.obtained !== page.items.filter((item) => item.obtained).length) {
      issue(issues, page.obtained, ['obtained'], 'obtained must be the number of obtained items');
    }
  });

export const collectionLogTabSchema = z.strictObject({
  name: z.string().min(1),
  pages: z.array(collectionLogPageSchema),
});

/** Unique items over `tabs`: an item on several pages counts once. */
export function collectionLogCounts(
  tabs: readonly {
    pages: readonly { items: readonly { itemId: number; obtained: boolean }[] }[];
  }[],
): { obtained: number; total: number } {
  const all = new Set<number>();
  const obtained = new Set<number>();
  for (const tab of tabs) {
    for (const page of tab.pages) {
      for (const item of page.items) {
        all.add(item.itemId);
        if (item.obtained) obtained.add(item.itemId);
      }
    }
  }
  return { obtained: obtained.size, total: all.size };
}

/**
 * What `GET …/collection-log` and `GET …/collection-log/status` share: the
 * source, the sync state and the counts.
 */
const collectionLogStatusFields = {
  accountId,
  /** The account's collection log source. `null` when none is turned on. */
  source: clogSourceSchema.nullable(),
  /**
   * Whether the server can fetch from the source (on in `.env`, with a
   * contact; contract 1.31.0). Lets every user see it without the admin-only
   * `GET /admin/external-sources`. `false`: turning it on stays off.
   */
  sourceAvailable: z.boolean(),
  /** `null` exactly when `source` is `null`. */
  sync: clogSyncSchema.nullable(),
  /** When the stored collection log was fetched. `null` before the first sync. */
  updatedAt: utcTimestamp.nullable(),
  /**
   * Unique items obtained and in total, as the game counts them: an item on
   * several pages (every pet is also on "All Pets") counts once. Page counts
   * count the item on each page. Both `null` before the first sync.
   */
  obtained: nonNegativeInt.nullable(),
  total: nonNegativeInt.nullable(),
};

/** The rules for the shared fields, with or without tabs. */
function checkCollectionLogStatus(
  status: z.infer<z.ZodObject<typeof collectionLogStatusFields>>,
  issues: Issues,
): void {
  if ((status.source === null) !== (status.sync === null)) {
    issue(issues, status.sync, ['sync'], 'sync is set exactly when source is set');
  }
  if ((status.updatedAt === null) !== (status.obtained === null)) {
    issue(issues, status.obtained, ['obtained'], 'Set exactly when updatedAt is set');
  }
  if ((status.updatedAt === null) !== (status.total === null)) {
    issue(issues, status.total, ['total'], 'Set exactly when updatedAt is set');
  }
  if (status.obtained !== null && status.total !== null && status.obtained > status.total) {
    issue(issues, status.obtained, ['obtained'], 'Must be at most total');
  }
}

/** `GET /api/v1/accounts/:accountId/collection-log` (contract 1.25.0) */
export const collectionLogResponseSchema = z
  .strictObject({
    ...collectionLogStatusFields,
    /** Tabs and pages in the game's order. Empty before the first sync. */
    tabs: z.array(collectionLogTabSchema),
  })
  .check(({ value: log, issues }) => {
    checkCollectionLogStatus(log, issues);
    if (log.updatedAt === null) {
      if (log.tabs.length > 0) issue(issues, log.tabs, ['tabs'], 'No tabs before the first sync');
      return;
    }
    const counts = collectionLogCounts(log.tabs);
    if (log.obtained !== null && log.obtained !== counts.obtained) {
      issue(issues, log.obtained, ['obtained'], 'Must be the number of unique obtained items');
    }
    if (log.total !== null && log.total !== counts.total) {
      issue(issues, log.total, ['total'], 'Must be the number of unique items');
    }
    // An item on several pages is the same item everywhere.
    const seen = new Map<number, z.infer<typeof collectionLogItemSchema>>();
    log.tabs.forEach((tab, t) => {
      tab.pages.forEach((page, p) => {
        page.items.forEach((item, i) => {
          const first = seen.get(item.itemId);
          if (!first) {
            seen.set(item.itemId, item);
          } else if (
            first.quantity !== item.quantity ||
            first.firstSeenAt !== item.firstSeenAt ||
            first.approximate !== item.approximate
          ) {
            issue(
              issues,
              item,
              ['tabs', t, 'pages', p, 'items', i],
              'The same item must have the same quantity and time on every page',
            );
          }
        });
      });
    });
  });

/**
 * `GET /api/v1/accounts/:accountId/collection-log/status` (contract 1.26.0):
 * the collection log without its tabs, with the same fields and rules. For
 * what only needs the source, the sync state and the counts: Settings, menus
 * and the account cards.
 */
export const collectionLogStatusResponseSchema = z
  .strictObject(collectionLogStatusFields)
  .check(({ value: status, issues }) => {
    checkCollectionLogStatus(status, issues);
  });

/** `PUT /api/v1/accounts/:accountId/collection-log/source` (contract 1.25.0) */
export const collectionLogSourceRequestSchema = z.strictObject({
  /** `null` turns the source off. The stored collection log is kept. */
  source: clogSourceSchema.nullable(),
});

/**
 * Response of `PUT …/collection-log/source` (`200`) and
 * `POST …/collection-log/sync` (`202`, the sync has started).
 */
export const collectionLogSyncResponseSchema = z
  .strictObject({
    accountId,
    source: clogSourceSchema.nullable(),
    sync: clogSyncSchema.nullable(),
  })
  .refine((state) => (state.source === null) === (state.sync === null), {
    message: 'sync is set exactly when source is set',
    path: ['sync'],
  });

export type ClogSource = z.infer<typeof clogSourceSchema>;
export type ClogSyncStatus = z.infer<typeof clogSyncStatusSchema>;
export type ClogSync = z.infer<typeof clogSyncSchema>;
export type CollectionLogItem = z.infer<typeof collectionLogItemSchema>;
export type CollectionLogPage = z.infer<typeof collectionLogPageSchema>;
export type CollectionLogTab = z.infer<typeof collectionLogTabSchema>;
export type CollectionLogResponse = z.infer<typeof collectionLogResponseSchema>;
export type CollectionLogStatusResponse = z.infer<typeof collectionLogStatusResponseSchema>;
export type CollectionLogSourceRequest = z.infer<typeof collectionLogSourceRequestSchema>;
export type CollectionLogSyncResponse = z.infer<typeof collectionLogSyncResponseSchema>;
