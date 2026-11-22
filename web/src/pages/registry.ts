import type { LucideIcon } from 'lucide-react';
import { BookOpen, Clock, House, Landmark, TrendingUp } from 'lucide-react';
import { SETTINGS_ACCOUNTS_PATH } from '@/lib/accounts';
import { BANK_PAGE_PATH } from '@/lib/bank';
import { CLOG_PAGE_PATH } from '@/lib/clog';
import { PETS_PAGE_PATH } from '@/lib/pets';
import { QUESTS_PAGE_PATH } from '@/lib/quests';
import { WEEKLY_PAGE_PATH } from '@/lib/weekly';
import {
  SETTINGS_INVITES_PAST_PATH,
  SETTINGS_KEYS_PATH,
  SETTINGS_KEYS_REVOKED_PATH,
  SETTINGS_SERVER_PATH,
  SETTINGS_USERS_KEYS_REVOKED_PATH,
  SETTINGS_USERS_PATH,
} from './settings/paths';

// The one page and navigation config. The router, the top bar, the mobile tab
// bar and the sub-tabs are all built from this list, so a page appears in a
// menu only once it exists here. No "coming soon". Components are not here but
// in `routing/page-components.ts`, so the pages can import this list (menus,
// links) without an import cycle.

/** Session detail (`/sessions/:sessionId`), which has no account in the URL. */
export const SESSION_PAGE_ID = 'session';

/**
 * Every page. `routing/page-components.ts` maps each one to its component, so
 * a page without a component (or the reverse) fails the type check.
 */
export type PageId =
  | 'home'
  | 'sessions'
  | typeof SESSION_PAGE_ID
  | 'screentime'
  | 'weekly'
  | 'xp'
  | 'loot'
  | 'raids'
  | 'clog'
  | 'pets'
  | 'quests'
  | 'bank'
  | 'settings'
  | 'settings-keys'
  | 'settings-accounts'
  | 'settings-users'
  | 'settings-server'
  | 'settings-keys-revoked'
  | 'settings-users-keys-revoked'
  | 'settings-invites-past';

/** The five places in the top bar and the mobile tab bar. */
export type DestinationId = 'home' | 'activity' | 'progress' | 'collections' | 'bank';

export interface Destination {
  id: DestinationId;
  label: string;
  icon: LucideIcon;
  /**
   * Path below `/:acc` of a destination with sub-tabs: it redirects to the
   * first sub-tab that exists. `undefined` for one-page destinations.
   */
  path?: string;
}

export const DESTINATIONS: readonly Destination[] = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'activity', label: 'Activity', icon: Clock, path: 'activity' },
  { id: 'progress', label: 'Progress', icon: TrendingUp, path: 'progress' },
  { id: 'collections', label: 'Collections', icon: BookOpen, path: 'collections' },
  { id: 'bank', label: 'Bank', icon: Landmark },
];

/** Data a page needs before it (and its menu item) exists. */
export type PageRequirement = 'bank' | 'quests' | 'clog' | 'pets';

export interface PageDef {
  id: PageId;
  /** Heading of a page outside the five destinations (Settings, Session). */
  title: string;
  /**
   * Account pages: path below `/:acc` (`''` for the account's start page).
   * Other pages: absolute path.
   */
  path: string;
  /** Lives under `/:acc` (an account ID or `all`). */
  scoped: boolean;
  /** The place in the top bar this page belongs to (account pages). */
  destination?: DestinationId;
  /** Label of the page's sub-tab, for destinations with more than one page. */
  tab?: string;
  /** A shorter sub-tab label for mobile, where the tabs share the width (`tab` stays the name). */
  tabShort?: string;
  /**
   * Older paths below `/:acc` that redirect here, with the same parameters, the
   * query and the hash kept. Old links and bookmarks keep working.
   */
  oldPaths?: readonly string[];
  /**
   * Mobile shows no page header rows (title, account switcher, sub-tabs): the
   * page has its own top row (Session detail, `MobileSession`). The `h1` stays
   * for screen readers and focus.
   */
  bareOnMobile?: boolean;
  /** Settings hides the account switcher. */
  hideAccountSwitcher?: boolean;
  /**
   * For a detail page without a menu item of its own: the `id` of the page
   * whose destination and sub-tab are marked on it.
   */
  parent?: PageId;
  /**
   * The page and its menu item appear only once this data exists: `bank` when
   * at least one account has a bank snapshot, `quests` when one has a quest or
   * diary snapshot, `clog` when one has a collection log, `pets` when one has
   * a pet or a collection log. See `useVisiblePages`.
   */
  requires?: PageRequirement;
  /**
   * Only for admins: left out of menus and tabs for members, and the full-page
   * 404 if a member opens it. See `useIsAdmin`.
   */
  adminOnly?: boolean;
}

export const PAGES: readonly PageDef[] = [
  { id: 'home', title: 'Home', path: '', scoped: true, destination: 'home' },
  {
    id: 'sessions',
    title: 'Sessions',
    path: 'activity/sessions',
    scoped: true,
    destination: 'activity',
    tab: 'Sessions',
    oldPaths: ['sessions'],
  },
  // Session detail: no account in the URL (a session belongs to one account).
  // The top bar marks Activity and the sub-tab Sessions.
  {
    id: SESSION_PAGE_ID,
    title: 'Session',
    path: '/sessions/:sessionId',
    scoped: false,
    parent: 'sessions',
    bareOnMobile: true,
  },
  {
    id: 'screentime',
    title: 'Screen time',
    path: 'activity/screentime',
    scoped: true,
    destination: 'activity',
    tab: 'Screen time',
    oldPaths: ['screentime'],
  },
  // `:week` is optional: without it, the current week. Menu links leave it out.
  {
    id: 'weekly',
    title: 'Weekly summary',
    path: `${WEEKLY_PAGE_PATH}/:week?`,
    scoped: true,
    destination: 'activity',
    tab: 'Weekly',
    oldPaths: ['weekly/:week?'],
  },
  {
    id: 'xp',
    title: 'XP',
    path: 'progress/xp',
    scoped: true,
    destination: 'progress',
    tab: 'XP',
    oldPaths: ['xp'],
  },
  // Loot and Boss KC are one tab (they used to be two).
  {
    id: 'loot',
    title: 'Loot & KC',
    path: 'progress/loot',
    scoped: true,
    destination: 'progress',
    tab: 'Loot & KC',
    oldPaths: ['loot', 'loot/kc'],
  },
  {
    id: 'raids',
    title: 'Raids',
    path: 'progress/raids',
    scoped: true,
    destination: 'progress',
    tab: 'Raids',
    oldPaths: ['loot/raids'],
  },
  // Shown once an account has a collection log.
  {
    id: 'clog',
    title: 'Collection log',
    path: CLOG_PAGE_PATH,
    scoped: true,
    destination: 'collections',
    tab: 'Collection log',
    oldPaths: ['clog'],
    requires: 'clog',
  },
  // Shown once an account has a pet or a collection log (the help text about syncing).
  {
    id: 'pets',
    title: 'Pets',
    path: PETS_PAGE_PATH,
    scoped: true,
    destination: 'collections',
    tab: 'Pets',
    oldPaths: ['pets'],
    requires: 'pets',
  },
  // Shown once an account has a quest or diary snapshot.
  {
    id: 'quests',
    title: 'Quests & diaries',
    path: QUESTS_PAGE_PATH,
    scoped: true,
    destination: 'collections',
    tab: 'Quests & diaries',
    tabShort: 'Quests',
    oldPaths: ['quests'],
    requires: 'quests',
  },
  // Shown once an account has a bank snapshot.
  {
    id: 'bank',
    title: 'Bank',
    path: BANK_PAGE_PATH,
    scoped: true,
    destination: 'bank',
    requires: 'bank',
  },
  {
    id: 'settings',
    title: 'Settings',
    path: '/settings',
    scoped: false,
    hideAccountSwitcher: true,
  },
  // Tabs of Settings.
  ...(
    [
      ['settings-keys', SETTINGS_KEYS_PATH, false],
      // History screens behind a link row.
      ['settings-keys-revoked', SETTINGS_KEYS_REVOKED_PATH, false],
      ['settings-accounts', SETTINGS_ACCOUNTS_PATH, false],
      // Users and invites: admin-only endpoints.
      ['settings-users', SETTINGS_USERS_PATH, true],
      // Backups, external sources, icons and rebuild: admin-only endpoints.
      ['settings-server', SETTINGS_SERVER_PATH, true],
      ['settings-users-keys-revoked', SETTINGS_USERS_KEYS_REVOKED_PATH, true],
      ['settings-invites-past', SETTINGS_INVITES_PAST_PATH, true],
    ] as const
  ).map(([id, path, adminOnly]): PageDef => ({
    id,
    title: 'Settings',
    path,
    scoped: false,
    hideAccountSwitcher: true,
    parent: 'settings',
    ...(adminOnly ? { adminOnly } : {}),
  })),
];

/** Link to a page. Account pages need the account scope. */
export function pageHref(page: PageDef, scope: string | number): string {
  // Optional parameters (`/:week?`) are left out: the link opens the page's default.
  const path = page.path.replace(/\/:[^/]+\?/g, '');
  if (!page.scoped) return path;
  return `/${String(scope)}${path ? `/${path}` : ''}`;
}

/** The page with this id (every id is in `PAGES`; the type check makes sure). */
export function pageById(id: PageId): PageDef {
  const page = PAGES.find((entry) => entry.id === id);
  if (!page) throw new Error(`Unknown page ${id}`);
  return page;
}

/** Link to a page by id, e.g. `hrefOf('weekly', 'all')` → `/all/activity/weekly`. */
export function hrefOf(id: PageId, scope: string | number): string {
  return pageHref(pageById(id), scope);
}

/** The Settings page, which the profile icon opens. */
export const SETTINGS_PATH = '/settings';

/** The page whose sub-tab is marked on `page`: its parent, or the page itself. */
export function navPageId(page: PageDef | undefined): PageId | undefined {
  return page?.parent ?? page?.id;
}

/** The destination marked on `page` (its own, or its parent's). Settings has none. */
export function destinationOf(page: PageDef | undefined): Destination | undefined {
  const id = navPageId(page);
  const own = id === undefined ? undefined : PAGES.find((entry) => entry.id === id);
  return DESTINATIONS.find((destination) => destination.id === own?.destination);
}

/** The pages of a destination among `pages` (the visible ones), in menu order. */
export function destinationPages(
  destination: DestinationId,
  pages: readonly PageDef[],
): readonly PageDef[] {
  return pages.filter((page) => page.destination === destination);
}
