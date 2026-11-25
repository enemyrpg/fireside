import type { ComponentType } from 'react';
import type { PageShape } from '@/components/PageSkeleton';
import { lazyNamed } from '@/lib/lazy';
import { OverviewPage } from '@/pages/OverviewPage';
import type { PageId } from '@/pages/registry';

export interface PageComponent {
  Component: ComponentType;
  /**
   * The shape of the skeleton while the page's code loads. Absent for a page
   * in the first chunk (Home), which never waits for code.
   */
  shape?: PageShape;
  /** Starts loading the page's code (a lazy page only). Safe to call more than once. */
  load?: () => Promise<unknown>;
}

function lazyPage<K extends string>(
  importer: () => Promise<Record<K, ComponentType>>,
  name: K,
  shape: PageShape,
): PageComponent {
  const { Component, load } = lazyNamed(importer, name);
  return { Component, shape, load };
}

/**
 * The component of every page in the registry. Kept apart from
 * `pages/registry.ts` because the pages import the registry (menus, links):
 * if the registry imported the pages, they would import each other, and a
 * page loaded before the registry would see its imports uninitialized.
 *
 * Home is in the first chunk, the page most visits start on; every other page
 * is its own chunk, loaded when it is first opened (docs/architecture.md,
 * "The dashboard bundle").
 */
export const PAGE_COMPONENTS: Record<PageId, PageComponent> = {
  home: { Component: OverviewPage },
  sessions: lazyPage(() => import('@/pages/SessionsPage'), 'SessionsPage', 'list'),
  session: lazyPage(() => import('@/pages/SessionPage'), 'SessionPage', 'cards'),
  screentime: lazyPage(() => import('@/pages/ScreentimePage'), 'ScreentimePage', 'cards'),
  weekly: lazyPage(() => import('@/pages/WeeklyPage'), 'WeeklyPage', 'cards'),
  xp: lazyPage(() => import('@/pages/XpPage'), 'XpPage', 'cards'),
  loot: lazyPage(() => import('@/pages/LootAndKcPage'), 'LootAndKcPage', 'list'),
  raids: lazyPage(() => import('@/pages/RaidsPage'), 'RaidsPage', 'cards'),
  clog: lazyPage(() => import('@/pages/CollectionLogPage'), 'CollectionLogPage', 'list'),
  pets: lazyPage(() => import('@/pages/PetsPage'), 'PetsPage', 'cards'),
  bank: lazyPage(() => import('@/pages/BankPage'), 'BankPage', 'list'),
  quests: lazyPage(() => import('@/pages/QuestsPage'), 'QuestsPage', 'list'),
  settings: lazyPage(() => import('@/pages/SettingsPage'), 'SettingsPage', {
    settings: 'profile',
  }),
  'settings-keys': lazyPage(() => import('@/pages/settings/KeysTab'), 'KeysTab', {
    settings: 'keys',
  }),
  'settings-accounts': lazyPage(() => import('@/pages/settings/AccountsTab'), 'AccountsTab', {
    settings: 'accounts',
  }),
  'settings-users': lazyPage(() => import('@/pages/settings/UsersTab'), 'UsersTab', {
    settings: 'users',
  }),
  'settings-server': lazyPage(() => import('@/pages/settings/ServerTab'), 'ServerTab', {
    settings: 'server',
  }),
  'settings-keys-revoked': lazyPage(
    () => import('@/pages/settings/RevokedKeysPage'),
    'RevokedKeysPage',
    { settings: 'keys' },
  ),
  'settings-users-keys-revoked': lazyPage(
    () => import('@/pages/settings/RevokedKeysPage'),
    'AdminRevokedKeysPage',
    { settings: 'users' },
  ),
  'settings-invites-past': lazyPage(
    () => import('@/pages/settings/PastInvitesPage'),
    'PastInvitesPage',
    { settings: 'users' },
  ),
};
