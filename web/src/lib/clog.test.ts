import type { CollectionLogItem, CollectionLogTab } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  canSyncNow,
  clogHref,
  clogSlug,
  clogSlugs,
  clogStatusText,
  datedItems,
  filterPages,
  isClogSyncProblem,
  isPageComplete,
  newItemCounts,
  PAGE_LIST_MAX_HEIGHT,
  pageListMaxHeight,
  pagesCompleted,
  recentItems,
  recentItemsShown,
  revealScrollTop,
  selectPage,
  selectTab,
  type DatedItem,
} from './clog';

function item(
  itemId: number,
  name: string,
  firstSeenAt: string | null | false,
  approximate = false,
): CollectionLogItem {
  const obtained = firstSeenAt !== false;
  return {
    itemId,
    name,
    quantity: obtained ? 1 : 0,
    obtained,
    firstSeenAt: firstSeenAt === false ? null : firstSeenAt,
    approximate,
  };
}

function page(name: string, items: CollectionLogItem[]) {
  return { name, obtained: items.filter((i) => i.obtained).length, total: items.length, items };
}

const vorki = item(21992, 'Vorki', '2026-11-10T20:15:00.000Z');
const TABS: CollectionLogTab[] = [
  {
    name: 'Bosses',
    pages: [
      page('Abyssal Sire', [
        item(13262, 'Abyssal orphan', false),
        item(4151, 'Abyssal whip', null),
        item(13265, 'Abyssal dagger', '2026-10-30T12:00:00.000Z', true),
      ]),
      page("Calvar'ion and Vet'ion", [item(12601, 'Ring of the gods', '2026-11-02T23:30:00.000Z')]),
      page('Vorkath', [vorki, item(22006, 'Skeletal visage', '2026-11-10T20:15:00.000Z')]),
    ],
  },
  { name: 'Other', pages: [page('All Pets', [item(13262, 'Abyssal orphan', false), vorki])] },
];

describe('clogSlug and clogHref', () => {
  it('makes URL names of tab and page names', () => {
    expect(clogSlug('Bosses')).toBe('bosses');
    expect(clogSlug("Calvar'ion and Vet'ion")).toBe('calvar-ion-and-vet-ion');
    expect(clogSlug('Barrows Chests')).toBe('barrows-chests');
    expect(clogSlug("  Champion's Challenge ")).toBe('champion-s-challenge');
  });

  it('links to the page, a tab, and a page of a tab', () => {
    expect(clogHref(2)).toBe('/2/collections/log');
    expect(clogHref('all')).toBe('/all/collections/log');
    expect(clogHref(2, { tab: 'other' })).toBe('/2/collections/log?tab=other');
    expect(clogHref(2, { tab: 'other', page: 'all-pets' })).toBe(
      '/2/collections/log?tab=other&page=all-pets',
    );
    // The filter of the page list comes along as typed; an empty one does not.
    expect(clogHref(2, { tab: 'other', page: 'all-pets', find: 'all p' })).toBe(
      '/2/collections/log?tab=other&page=all-pets&find=all+p',
    );
    expect(clogHref(2, { tab: 'other', find: '' })).toBe('/2/collections/log?tab=other');
  });
});

describe('clogSlugs', () => {
  const slugs = (...names: string[]) => [...clogSlugs(names.map((name) => ({ name }))).values()];

  it('gives every name its plain slug when they differ', () => {
    expect(slugs('Bosses', 'Raids', "Champion's Challenge")).toEqual([
      'bosses',
      'raids',
      'champion-s-challenge',
    ]);
  });

  it('never gives two names the same slug', () => {
    // Differ only in case or punctuation; the first keeps the plain slug.
    expect(slugs('The Whisperer', 'the whisperer', 'The-Whisperer!')).toEqual([
      'the-whisperer',
      'the-whisperer-2',
      'the-whisperer-3',
    ]);
    // A suffix never lands on a slug another name already has, or takes later.
    expect(slugs('Zulrah', 'Zulrah 2', 'zulrah')).toEqual(['zulrah', 'zulrah-2', 'zulrah-3']);
    expect(slugs('zulrah', 'Zulrah', 'Zulrah 2')).toEqual(['zulrah', 'zulrah-2', 'zulrah-2-2']);
    // The very same name twice.
    expect(slugs('Vorkath', 'Vorkath')).toEqual(['vorkath', 'vorkath-2']);
  });

  it('gives a name without ASCII letters or digits its place in the list', () => {
    expect(slugs('Bosses', '冒険', '…', '2')).toEqual(['bosses', '2', '3', '2-2']);
    expect(slugs('')).toEqual(['1']);
  });

  it('keeps every tab and page reachable by its slug', () => {
    const twin = page('vorkath', []);
    const foreign = page('ボス', []);
    const tabs: CollectionLogTab[] = [
      { name: 'Bosses', pages: [page('Vorkath', []), twin, foreign] },
      { name: 'BOSSES', pages: [page('Other page', [])] },
      { name: '日本', pages: [] },
    ];
    expect(selectPage(tabs[0], 'vorkath')).toBe(tabs[0]?.pages[0]);
    expect(selectPage(tabs[0], 'vorkath-2')).toBe(twin);
    expect(selectPage(tabs[0], '3')).toBe(foreign);
    expect(selectTab(tabs, 'bosses-2')).toBe(tabs[1]);
    expect(selectTab(tabs, '3')).toBe(tabs[2]);
  });
});

describe('selectTab and selectPage', () => {
  it('picks by the URL name', () => {
    const tab = selectTab(TABS, 'other');
    expect(tab?.name).toBe('Other');
    expect(selectPage(selectTab(TABS, 'bosses'), 'vorkath')?.name).toBe('Vorkath');
  });

  it('falls back to the first tab and the first page', () => {
    expect(selectTab(TABS, null)?.name).toBe('Bosses');
    expect(selectTab(TABS, 'nope')?.name).toBe('Bosses');
    expect(selectPage(TABS[0], null)?.name).toBe('Abyssal Sire');
    // A page of another tab is not a page of this one.
    expect(selectPage(TABS[0], 'all-pets')?.name).toBe('Abyssal Sire');
  });

  it('is undefined without tabs or pages', () => {
    expect(selectTab([], 'bosses')).toBeUndefined();
    expect(selectPage(undefined, 'x')).toBeUndefined();
    expect(selectPage({ name: 'Empty', pages: [] }, null)).toBeUndefined();
  });
});

describe('pagesCompleted', () => {
  it('counts pages with every item obtained', () => {
    expect(pagesCompleted(TABS)).toEqual({ completed: 2, total: 4 });
  });

  it('never counts a page without items', () => {
    expect(isPageComplete({ obtained: 0, total: 0 })).toBe(false);
    expect(isPageComplete({ obtained: 3, total: 3 })).toBe(true);
    expect(isPageComplete({ obtained: 2, total: 3 })).toBe(false);
  });
});

describe('datedItems and recentItems', () => {
  it('lists each dated item once, under its first page', () => {
    const dated = datedItems(TABS);
    expect(dated.map((entry) => entry.item.name)).toEqual([
      'Abyssal dagger',
      'Ring of the gods',
      'Vorki',
      'Skeletal visage',
    ]);
    expect(dated.find((entry) => entry.item.name === 'Vorki')).toMatchObject({
      tab: 'Bosses',
      page: 'Vorkath',
      tabSlug: 'bosses',
      pageSlug: 'vorkath',
    });
  });

  it('puts the newest first, the same time by name, and stops at the limit', () => {
    expect(recentItems(TABS).map((entry) => entry.item.name)).toEqual([
      'Skeletal visage',
      'Vorki',
      'Ring of the gods',
      'Abyssal dagger',
    ]);
    expect(recentItems(TABS, 2)).toHaveLength(2);
  });
});

describe('recentItemsShown', () => {
  /** `count` items, one a day back from `from` (UTC noon), newest first. */
  function items(count: number, from: string): DatedItem[] {
    return Array.from({ length: count }, (_, index) => {
      const at = new Date(Date.parse(`${from}T12:00:00Z`) - index * 86_400_000).toISOString();
      return {
        item: {
          itemId: index + 1,
          name: `Item ${String(index + 1)}`,
          obtained: true,
          quantity: 1,
          firstSeenAt: at,
          approximate: false,
        },
        tab: 'Bosses',
        page: 'Vorkath',
        tabSlug: 'bosses',
        pageSlug: 'vorkath',
      };
    });
  }

  it('shows the six newest and no button with six or fewer this month', () => {
    // 4 in November (the 1st–4th), the rest in October.
    const all = items(10, '2026-11-04');
    const shown = recentItemsShown(all, false, '2026-11-20', 'UTC');
    expect(shown.foldable).toBe(false);
    expect(shown.thisMonth).toBe(4);
    expect(shown.rows).toHaveLength(6);
    expect(recentItemsShown(all, true, '2026-11-20', 'UTC').rows).toHaveLength(6);
  });

  it('folds to six and unfolds every item of the month with more than six', () => {
    // 9 in November (the 1st–9th), 3 in October.
    const all = items(12, '2026-11-09');
    const folded = recentItemsShown(all, false, '2026-11-20', 'UTC');
    expect(folded).toMatchObject({ foldable: true, thisMonth: 9 });
    expect(folded.rows).toHaveLength(6);
    const open = recentItemsShown(all, true, '2026-11-20', 'UTC');
    expect(open.rows.map((entry) => entry.item.name)).toEqual(
      all.slice(0, 9).map((entry) => entry.item.name),
    );
  });

  it('uses the local month: 23:30 UTC on 31 October is November in Oslo', () => {
    const late: DatedItem[] = items(7, '2026-11-06').map((entry, index) =>
      index === 6
        ? { ...entry, item: { ...entry.item, firstSeenAt: '2026-10-31T23:30:00Z' } }
        : entry,
    );
    expect(recentItemsShown(late, false, '2026-11-20', 'Europe/Oslo').thisMonth).toBe(7);
    expect(recentItemsShown(late, false, '2026-11-20', 'UTC').thisMonth).toBe(6);
  });

  it('shows nothing for no items', () => {
    expect(recentItemsShown([], false, '2026-11-20', 'UTC')).toEqual({
      rows: [],
      foldable: false,
      thisMonth: 0,
    });
  });
});

describe('newItemCounts', () => {
  it('counts the month and the ISO week of today in the time zone', () => {
    // Wednesday 11 November 2026: week 46 started on Monday the 9th.
    expect(newItemCounts(TABS, '2026-11-11', 'Europe/Oslo')).toEqual({ month: 3, week: 2 });
  });

  it('uses local dates: 23:30 UTC on the 2nd is the 3rd in Oslo, the 2nd in UTC', () => {
    expect(newItemCounts(TABS, '2026-11-02', 'UTC').week).toBe(1);
    // In Oslo it is 00:30 on Tuesday the 3rd: still week 45.
    expect(newItemCounts(TABS, '2026-11-03', 'Europe/Oslo')).toEqual({ month: 3, week: 1 });
    // October in UTC-12 for an item at 01:00 UTC on 1 November.
    const late = [{ name: 'T', pages: [page('P', [item(1, 'A', '2026-11-01T01:00:00.000Z')])] }];
    expect(newItemCounts(late, '2026-10-31', 'Etc/GMT+12').month).toBe(1);
    expect(newItemCounts(late, '2026-11-01', 'UTC').month).toBe(1);
  });

  it('counts approximate times, and an item on two pages once', () => {
    expect(newItemCounts(TABS, '2026-10-30', 'UTC')).toEqual({ month: 1, week: 1 });
    expect(newItemCounts(TABS, '2026-11-10', 'UTC').week).toBe(2);
  });

  it('is zero in a month and week without new items', () => {
    expect(newItemCounts(TABS, '2026-12-20', 'UTC')).toEqual({ month: 0, week: 0 });
  });
});

describe('sync state', () => {
  const sync = {
    status: 'OK' as const,
    lastAttemptAt: '2026-11-08T19:42:13.512Z',
    lastSuccessAt: '2026-11-08T19:42:13.512Z',
    lastChangedAt: null,
    nextSyncAllowedAt: '2026-11-08T19:43:13.512Z',
  };
  const at = (iso: string) => Date.parse(iso);

  it('allows "Sync now" once the minute after the last attempt is over', () => {
    const status = { source: 'RUNEPROFILE' as const, sync };
    expect(canSyncNow(status, at('2026-11-08T19:43:00.000Z'))).toBe(false);
    expect(canSyncNow(status, at('2026-11-08T19:43:13.512Z'))).toBe(true);
    expect(
      canSyncNow({ ...status, sync: { ...sync, nextSyncAllowedAt: null } }, at(sync.lastAttemptAt)),
    ).toBe(true);
  });

  it('never allows it without a source, while syncing or with the source off on the server', () => {
    const later = at('2026-11-09T00:00:00.000Z');
    expect(canSyncNow({ source: null, sync: null }, later)).toBe(false);
    for (const status of ['SYNCING', 'SOURCE_OFF'] as const) {
      expect(canSyncNow({ source: 'RUNEPROFILE', sync: { ...sync, status } }, later)).toBe(false);
    }
    expect(
      canSyncNow({ source: 'RUNEPROFILE', sync: { ...sync, status: 'UNAVAILABLE' } }, later),
    ).toBe(true);
  });

  it('calls a sync that did not work a problem, with a text for it', () => {
    expect(isClogSyncProblem('OK')).toBe(false);
    expect(isClogSyncProblem('SYNCING')).toBe(false);
    expect(isClogSyncProblem('NEVER_SYNCED')).toBe(false);
    for (const status of ['PROFILE_NOT_FOUND', 'UNAVAILABLE', 'SOURCE_OFF'] as const) {
      expect(isClogSyncProblem(status)).toBe(true);
      expect(clogStatusText(status, 'Seed Main')).not.toBeNull();
    }
    expect(clogStatusText('OK', 'Seed Main')).toBeNull();
    expect(clogStatusText('PROFILE_NOT_FOUND', 'Seed Main')).toContain('named Seed Main');
  });
});

describe('the page list', () => {
  const pages = TABS[0]?.pages ?? [];
  const names = (find: string) => filterPages(pages, find).map((entry) => entry.name);

  it('filters the names, in any case and in game order', () => {
    expect(names('')).toEqual(['Abyssal Sire', "Calvar'ion and Vet'ion", 'Vorkath']);
    expect(names('  VOR ')).toEqual(['Vorkath']);
    expect(names('a')).toEqual(['Abyssal Sire', "Calvar'ion and Vet'ion", 'Vorkath']);
    expect(names("vet'ion")).toEqual(["Calvar'ion and Vet'ion"]);
    expect(names('zulrah')).toEqual([]);
  });

  it('caps the card at 600 px, or the room under the top bar when that is less', () => {
    expect(PAGE_LIST_MAX_HEIGHT).toBe(600);
    // 1080 px window: 1080 − 88 − 20 is more than 600.
    expect(pageListMaxHeight(972)).toBe(600);
    // 700 px window: only 592 px under the sticky top.
    expect(pageListMaxHeight(592)).toBe(592);
    expect(pageListMaxHeight(200)).toBe(200);
  });

  it('scrolls only as far as it takes to show the chosen page', () => {
    // In view: stays.
    expect(revealScrollTop(100, 200, 150, 30)).toBe(100);
    // Above: its top goes to the top.
    expect(revealScrollTop(100, 200, 40, 30)).toBe(40);
    // Below: its bottom goes to the bottom.
    expect(revealScrollTop(100, 200, 500, 30)).toBe(330);
    expect(revealScrollTop(0, 200, 180, 30)).toBe(10);
  });
});
