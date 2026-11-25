import { act, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PAGES, hrefOf, type PageId } from '@/pages/registry';
import { mockApi, renderApp } from '@/test/render-app';
import { PAGE_COMPONENTS } from './page-components';

// Every lazy page shows its skeleton while its code loads, then itself. Each
// page module is held back until the test lets it load, and each page
// component is marked (`page:<name>`) so the test sees the page, not the
// skeleton. The gates have their own tests (PageGate), so here they let
// every page through.

const modules = vi.hoisted(() => {
  interface Gate {
    promise: Promise<void>;
    resolve: () => void;
    requested: boolean;
  }
  const gates = new Map<string, Gate>();
  function gate(name: string): Gate {
    let found = gates.get(name);
    if (!found) {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      found = { promise, resolve, requested: false };
      gates.set(name, found);
    }
    return found;
  }
  return {
    async held(name: string, importOriginal: () => Promise<Record<string, unknown>>) {
      const entry = gate(name);
      entry.requested = true;
      await entry.promise;
      const { createElement } = await import('react');
      const original = await importOriginal();
      const marked: Record<string, unknown> = { ...original };
      for (const [key, value] of Object.entries(original)) {
        if (/(Page|Tab)$/.test(key) && typeof value === 'function') {
          const Page = value as ComponentType;
          marked[key] = () =>
            createElement('div', { 'data-testid': `page:${key}` }, createElement(Page));
        }
      }
      return marked;
    },
    release(name: string) {
      gate(name).resolve();
    },
    requested(name: string) {
      return gate(name).requested;
    },
  };
});

vi.mock('./PageGate', () => ({ PageGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/pages/SessionsPage', (load) => modules.held('SessionsPage', load));
vi.mock('@/pages/SessionPage', (load) => modules.held('SessionPage', load));
vi.mock('@/pages/ScreentimePage', (load) => modules.held('ScreentimePage', load));
vi.mock('@/pages/WeeklyPage', (load) => modules.held('WeeklyPage', load));
vi.mock('@/pages/XpPage', (load) => modules.held('XpPage', load));
vi.mock('@/pages/LootAndKcPage', (load) => modules.held('LootAndKcPage', load));
vi.mock('@/pages/RaidsPage', (load) => modules.held('RaidsPage', load));
vi.mock('@/pages/CollectionLogPage', (load) => modules.held('CollectionLogPage', load));
vi.mock('@/pages/PetsPage', (load) => modules.held('PetsPage', load));
vi.mock('@/pages/BankPage', (load) => modules.held('BankPage', load));
vi.mock('@/pages/QuestsPage', (load) => modules.held('QuestsPage', load));
vi.mock('@/pages/SettingsPage', (load) => modules.held('SettingsPage', load));
vi.mock('@/pages/settings/KeysTab', (load) => modules.held('KeysTab', load));
vi.mock('@/pages/settings/AccountsTab', (load) => modules.held('AccountsTab', load));
vi.mock('@/pages/settings/UsersTab', (load) => modules.held('UsersTab', load));
vi.mock('@/pages/settings/ServerTab', (load) => modules.held('ServerTab', load));
vi.mock('@/pages/settings/RevokedKeysPage', (load) => modules.held('RevokedKeysPage', load));
vi.mock('@/pages/settings/PastInvitesPage', (load) => modules.held('PastInvitesPage', load));

/** Page id → the module it lives in and its export (as in `page-components.ts`). */
const LAZY: [PageId, string, string][] = [
  ['sessions', 'SessionsPage', 'SessionsPage'],
  ['session', 'SessionPage', 'SessionPage'],
  ['screentime', 'ScreentimePage', 'ScreentimePage'],
  ['weekly', 'WeeklyPage', 'WeeklyPage'],
  ['xp', 'XpPage', 'XpPage'],
  ['loot', 'LootAndKcPage', 'LootAndKcPage'],
  ['raids', 'RaidsPage', 'RaidsPage'],
  ['clog', 'CollectionLogPage', 'CollectionLogPage'],
  ['pets', 'PetsPage', 'PetsPage'],
  ['bank', 'BankPage', 'BankPage'],
  ['quests', 'QuestsPage', 'QuestsPage'],
  ['settings', 'SettingsPage', 'SettingsPage'],
  ['settings-keys', 'KeysTab', 'KeysTab'],
  ['settings-accounts', 'AccountsTab', 'AccountsTab'],
  ['settings-users', 'UsersTab', 'UsersTab'],
  ['settings-server', 'ServerTab', 'ServerTab'],
  ['settings-keys-revoked', 'RevokedKeysPage', 'RevokedKeysPage'],
  ['settings-invites-past', 'PastInvitesPage', 'PastInvitesPage'],
  // Last: its module is RevokedKeysPage's, which has loaded by now.
  ['settings-users-keys-revoked', 'RevokedKeysPage', 'AdminRevokedKeysPage'],
];

function href(id: PageId): string {
  return id === 'session' ? '/sessions/s1' : hrefOf(id, 1);
}

describe('lazy pages', () => {
  // The first import of a page compiles it and its libraries, which can take
  // longer than a `find…` waits. Done once here, it leaves only the test's own
  // hold on each module.
  beforeAll(async () => {
    await Promise.all(
      [...new Set(LAZY.map(([, module]) => module))].map((module) =>
        vi.importActual(
          module.endsWith('Tab') || ['RevokedKeysPage', 'PastInvitesPage'].includes(module)
            ? `@/pages/settings/${module}`
            : `@/pages/${module}`,
        ),
      ),
    );
  }, 60_000);

  it('has Home in the first chunk and every other page lazy', () => {
    expect(PAGE_COMPONENTS.home.shape).toBeUndefined();
    expect(PAGE_COMPONENTS.home.load).toBeUndefined();
    const lazy = PAGES.filter((page) => page.id !== 'home').map((page) => page.id);
    expect(lazy.toSorted()).toEqual(LAZY.map(([id]) => id).toSorted());
    for (const id of lazy) {
      expect(PAGE_COMPONENTS[id].shape).toBeDefined();
      expect(PAGE_COMPONENTS[id].load).toBeDefined();
    }
  });

  it.each(LAZY)(
    '%s: the skeleton after 200 ms while the code loads, then the page',
    async (id, module, name) => {
      // The session itself never answers: the page stays in its own loading state.
      mockApi({ '/api/v1/sessions/s1': () => new Promise<Response>(() => undefined) });
      const { router } = renderApp('/1');
      expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();

      expect(await screen.findByRole('heading', { name: /^This week$/ })).toBeTruthy();

      await act(() => router.navigate(href(id)));
      expect(modules.requested(module)).toBe(true);
      // Its module has loaded for `settings-keys-revoked` already.
      if (name !== 'AdminRevokedKeysPage') {
        const skeleton = await screen.findByTestId('page-skeleton');
        // Not the last page kept on screen while the new one loads.
        expect(screen.queryByRole('heading', { name: /^This week$/ })).toBeNull();
        const lines = within(skeleton).getAllByTestId('skeleton-line');
        expect(lines[0]?.classList.contains('invisible')).toBe(true);
        await waitFor(() => {
          expect(lines[0]?.classList.contains('invisible')).toBe(false);
        });
      }

      act(() => {
        modules.release(module);
      });
      expect(await screen.findByTestId(`page:${name}`)).toBeTruthy();
      expect(screen.queryByTestId('page-skeleton')).toBeNull();
    },
  );
});
