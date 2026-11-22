import type { ComponentType } from 'react';
import { BankPage } from '@/pages/BankPage';
import { CollectionLogPage } from '@/pages/CollectionLogPage';
import { LootAndKcPage } from '@/pages/LootAndKcPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { PetsPage } from '@/pages/PetsPage';
import { QuestsPage } from '@/pages/QuestsPage';
import { RaidsPage } from '@/pages/RaidsPage';
import type { PageId } from '@/pages/registry';
import { ScreentimePage } from '@/pages/ScreentimePage';
import { SessionPage } from '@/pages/SessionPage';
import { SessionsPage } from '@/pages/SessionsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AccountsTab } from '@/pages/settings/AccountsTab';
import { KeysTab } from '@/pages/settings/KeysTab';
import { PastInvitesPage } from '@/pages/settings/PastInvitesPage';
import { AdminRevokedKeysPage, RevokedKeysPage } from '@/pages/settings/RevokedKeysPage';
import { ServerTab } from '@/pages/settings/ServerTab';
import { UsersTab } from '@/pages/settings/UsersTab';
import { WeeklyPage } from '@/pages/WeeklyPage';
import { XpPage } from '@/pages/XpPage';

/**
 * The component of every page in the registry. Kept apart from
 * `pages/registry.ts` because the pages import the registry (menus, links):
 * if the registry imported the pages, they would import each other, and a
 * page loaded before the registry would see its imports uninitialized.
 */
export const PAGE_COMPONENTS: Record<PageId, ComponentType> = {
  home: OverviewPage,
  sessions: SessionsPage,
  session: SessionPage,
  screentime: ScreentimePage,
  weekly: WeeklyPage,
  xp: XpPage,
  loot: LootAndKcPage,
  raids: RaidsPage,
  clog: CollectionLogPage,
  pets: PetsPage,
  bank: BankPage,
  quests: QuestsPage,
  settings: SettingsPage,
  'settings-keys': KeysTab,
  'settings-accounts': AccountsTab,
  'settings-users': UsersTab,
  'settings-server': ServerTab,
  'settings-keys-revoked': RevokedKeysPage,
  'settings-users-keys-revoked': AdminRevokedKeysPage,
  'settings-invites-past': PastInvitesPage,
};
