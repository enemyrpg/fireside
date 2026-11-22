import {
  BRANDING,
  type ClogSyncStatus,
  type CollectionLogItem,
  type CollectionLogPage,
  type CollectionLogStatusResponse,
  type CollectionLogTab,
} from '@fireside/shared';
import type { ReactNode } from 'react';
import { localDateIn } from '@/format';
import { ROWS_SHOWN } from '@/lib/show-all';
import { weekOfDate } from '@/lib/time';

// Rules of the Collection log page and of the collection log source under
// Settings → OSRS accounts. The API gives tabs, pages and items in the game's
// order, missing items included; which tab and page is shown, what counts as
// new and what is said about a sync lives here.

/** Path of the Collection log page below `/:acc` (also in the page registry). */
export const CLOG_PAGE_PATH = 'collections/log';

/** Name of the one collection log source, as shown. */
export const CLOG_SOURCE_NAME = 'RuneProfile';

/**
 * A name as it would stand in the URL: "Calvar'ion and Vet'ion" →
 * `calvar-ion-and-vet-ion`. Empty for a name without ASCII letters or digits,
 * and two names can give the same: `clogSlugs` is what the URL uses.
 */
export function clogSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The slug of every tab of a collection log, or of every page of a tab: what
 * stands in `?tab=` and `?page=`. Never empty and never the same for two
 * entries, whatever the source calls them, so every tab and page can be
 * opened. The first entry with a slug keeps it and a later one gets `-2`,
 * `-3`…; a name that gives no slug gets its place in the list (`3`).
 */
export function clogSlugs<T extends { name: string }>(entries: readonly T[]): Map<T, string> {
  const slugs = new Map<T, string>();
  const taken = new Set<string>();
  entries.forEach((entry, index) => {
    const base = clogSlug(entry.name) || String(index + 1);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${String(n)}`;
    taken.add(slug);
    slugs.set(entry, slug);
  });
  return slugs;
}

/**
 * Link to the Collection log page of an account or `all`, at a tab and page
 * given by their slugs (`clogSlugs`).
 */
export function clogHref(
  scope: string | number,
  {
    tab,
    page,
    find,
  }: { tab?: string | undefined; page?: string | undefined; find?: string | undefined } = {},
): string {
  const params = new URLSearchParams();
  if (tab !== undefined) params.set('tab', tab);
  if (page !== undefined) params.set('page', page);
  // The filter of the page list, kept while picking among the pages it found.
  if (find !== undefined && find !== '') params.set('find', find);
  const query = params.toString();
  return `/${String(scope)}/${CLOG_PAGE_PATH}${query ? `?${query}` : ''}`;
}

function bySlug<T extends { name: string }>(entries: readonly T[], param: string | null) {
  for (const [entry, slug] of clogSlugs(entries)) if (slug === param) return entry;
  return entries[0];
}

/** The tab of `?tab=`. A missing or unknown value is the first tab. */
export function selectTab(
  tabs: readonly CollectionLogTab[],
  param: string | null,
): CollectionLogTab | undefined {
  return bySlug(tabs, param);
}

/** The page of `?page=` in a tab. A missing or unknown value is the tab's first page. */
export function selectPage(
  tab: CollectionLogTab | undefined,
  param: string | null,
): CollectionLogPage | undefined {
  return tab ? bySlug(tab.pages, param) : undefined;
}

/** A page with every item obtained. A page without items is never complete. */
export function isPageComplete(page: Pick<CollectionLogPage, 'obtained' | 'total'>): boolean {
  return page.total > 0 && page.obtained === page.total;
}

/**
 * The pages the page list shows: those whose name contains `find` (any case,
 * spaces around it ignored).
 */
export function filterPages(
  pages: readonly CollectionLogPage[],
  find: string,
): CollectionLogPage[] {
  const needle = find.trim().toLowerCase();
  return pages.filter((page) => page.name.toLowerCase().includes(needle));
}

/**
 * The tallest the page list card gets on PC (about twelve pages), so it does
 * not reach far below the short cards next to it.
 */
export const PAGE_LIST_MAX_HEIGHT = 600;

/**
 * Height cap of the page list card: `PAGE_LIST_MAX_HEIGHT`, or the room under
 * the sticky top bar (the window minus the sticky top and 20 px, `stickyRoom`)
 * when that is smaller. Not tied to the cards next to it, which change with
 * every page picked. A shorter list makes the card shorter still.
 */
export function pageListMaxHeight(room: number): number {
  return Math.min(PAGE_LIST_MAX_HEIGHT, room);
}

/**
 * Where a list has to be scrolled for an entry to be in view: unchanged when
 * it already is, otherwise the shortest way there. `itemTop` is measured from
 * the top of the list's content.
 */
export function revealScrollTop(
  scrollTop: number,
  viewHeight: number,
  itemTop: number,
  itemHeight: number,
): number {
  if (itemTop < scrollTop) return itemTop;
  const itemBottom = itemTop + itemHeight;
  if (itemBottom > scrollTop + viewHeight) return Math.max(0, itemBottom - viewHeight);
  return scrollTop;
}

/** Pages with every item obtained, of all pages. */
export function pagesCompleted(tabs: readonly CollectionLogTab[]): {
  completed: number;
  total: number;
} {
  const pages = tabs.flatMap((tab) => tab.pages);
  return { completed: pages.filter(isPageComplete).length, total: pages.length };
}

/** An obtained item with a known time, and the first page (in game order) that has it. */
export interface DatedItem {
  item: CollectionLogItem & { firstSeenAt: string };
  tab: string;
  page: string;
  /** Their slugs, for a link to the page (`clogHref`). */
  tabSlug: string;
  pageSlug: string;
}

/**
 * Every obtained item whose time is known, once each: an item on several
 * pages (a pet is also on "All Pets") is listed under the first of them.
 */
export function datedItems(tabs: readonly CollectionLogTab[]): DatedItem[] {
  const seen = new Set<number>();
  const dated: DatedItem[] = [];
  for (const [tab, tabSlug] of clogSlugs(tabs)) {
    for (const [page, pageSlug] of clogSlugs(tab.pages)) {
      for (const item of page.items) {
        if (seen.has(item.itemId)) continue;
        seen.add(item.itemId);
        if (item.obtained && item.firstSeenAt !== null) {
          dated.push({
            item: { ...item, firstSeenAt: item.firstSeenAt },
            tab: tab.name,
            page: page.name,
            tabSlug,
            pageSlug,
          });
        }
      }
    }
  }
  return dated;
}

/** Every dated item, the newest first; items of the same time by name. */
export function recentItems(
  tabs: readonly CollectionLogTab[],
  limit = Number.POSITIVE_INFINITY,
): DatedItem[] {
  return datedItems(tabs)
    .sort(
      (a, b) =>
        b.item.firstSeenAt.localeCompare(a.item.firstSeenAt) ||
        a.item.name.localeCompare(b.item.name),
    )
    .slice(0, limit);
}

/**
 * What "Recent items" shows: the six newest. When more than six were first seen
 * in the month of `today` (a local date in `timeZone`), "Show all N this month"
 * unfolds every item of the month. Otherwise the six newest of all time and no
 * button. `items` newest first (`recentItems`).
 */
export function recentItemsShown(
  items: readonly DatedItem[],
  expanded: boolean,
  today: string,
  timeZone: string,
): { rows: readonly DatedItem[]; foldable: boolean; thisMonth: number } {
  const month = today.slice(0, 7);
  const thisMonth = items.filter(
    ({ item }) => localDateIn(item.firstSeenAt, timeZone).slice(0, 7) === month,
  );
  if (thisMonth.length <= ROWS_SHOWN) {
    return { rows: items.slice(0, ROWS_SHOWN), foldable: false, thisMonth: thisMonth.length };
  }
  return {
    rows: expanded ? thisMonth : thisMonth.slice(0, ROWS_SHOWN),
    foldable: true,
    thisMonth: thisMonth.length,
  };
}

/**
 * Items first seen in the calendar month and in the ISO week of `today` (a
 * local date in `timeZone`). Approximate times count: the item is new either way.
 */
export function newItemCounts(
  tabs: readonly CollectionLogTab[],
  today: string,
  timeZone: string,
): { month: number; week: number } {
  const week = weekOfDate(today);
  let inMonth = 0;
  let inWeek = 0;
  for (const { item } of datedItems(tabs)) {
    const date = localDateIn(item.firstSeenAt, timeZone);
    if (date.slice(0, 7) === today.slice(0, 7)) inMonth++;
    if (weekOfDate(date) === week) inWeek++;
  }
  return { month: inMonth, week: inWeek };
}

// --- Sync state -----------------------------------------------------------------

/** One sentence per state: what is wrong and what to do about it. `null` when all is well. */
export function clogStatusText(status: ClogSyncStatus, name: string): ReactNode {
  switch (status) {
    case 'OK':
      return null;
    case 'NEVER_SYNCED':
      return 'Not synced yet.';
    case 'SYNCING':
      return 'Syncing…';
    case 'SOURCE_OFF':
      return `${CLOG_SOURCE_NAME} is off on this server, so nothing is fetched.`;
    case 'NO_NAME':
      return `This account has no name ${CLOG_SOURCE_NAME} can look up yet. Log in with the ${BRANDING.displayName} plugin first.`;
    case 'PROFILE_NOT_FOUND':
      return `No ${CLOG_SOURCE_NAME} profile named ${name}. If you changed name, or have not used the ${CLOG_SOURCE_NAME} plugin yet, log in with the ${CLOG_SOURCE_NAME} plugin on so it uploads, then click Sync now.`;
    case 'PROFILE_FROM_BEFORE_NAME':
      return `This ${CLOG_SOURCE_NAME} profile is older than ${BRANDING.displayName}’s record of this name. Log in with the ${CLOG_SOURCE_NAME} plugin on so it uploads, then click Sync now.`;
    case 'RATE_LIMITED':
      return `${CLOG_SOURCE_NAME} asked for fewer requests. It is tried again later.`;
    case 'INVALID_API_KEY':
      return (
        <>
          {CLOG_SOURCE_NAME} refused the API key. Check{' '}
          <code className="font-mono">RUNEPROFILE_API_KEY</code> in{' '}
          <code className="font-mono">.env</code>.
        </>
      );
    case 'UNAVAILABLE':
      return `Couldn't reach ${CLOG_SOURCE_NAME}. It is tried again later.`;
    case 'INVALID_RESPONSE':
      return `${CLOG_SOURCE_NAME} answered in a format this version of ${BRANDING.displayName} does not know. Check for an update.`;
  }
}

/** Statuses the owner has to act on, shown as an alert. */
export const CLOG_NEEDS_ACTION: ReadonlySet<ClogSyncStatus> = new Set<ClogSyncStatus>([
  'NO_NAME',
  'PROFILE_NOT_FOUND',
  'PROFILE_FROM_BEFORE_NAME',
  'INVALID_API_KEY',
  'INVALID_RESPONSE',
]);

/** Statuses of a sync that did not work: the Collection log page says so under the top bar. */
export function isClogSyncProblem(status: ClogSyncStatus): boolean {
  return status !== 'OK' && status !== 'SYNCING' && status !== 'NEVER_SYNCED';
}

/**
 * Whether "Sync now" can be pressed: a source is on (also on the server), no
 * sync is running, and the minute after the last attempt is over.
 */
export function canSyncNow(
  status: Pick<CollectionLogStatusResponse, 'source' | 'sync'>,
  nowMs: number,
): boolean {
  const { source, sync } = status;
  if (source === null || sync === null) return false;
  if (sync.status === 'SYNCING' || sync.status === 'SOURCE_OFF') return false;
  return sync.nextSyncAllowedAt === null || Date.parse(sync.nextSyncAllowedAt) <= nowMs;
}
