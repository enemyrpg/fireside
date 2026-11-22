import { render, screen, within } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, type DataRouter } from 'react-router';
import { vi } from 'vitest';
import aboutDefault from '../../../shared/fixtures/api/about-response/valid/default.json';
import accountsFixture from '../../../shared/fixtures/api/accounts-response/valid/accounts.json';
import authLocal from '../../../shared/fixtures/api/auth-me-response/valid/local.json';
import bankSummaryNoData from '../../../shared/fixtures/api/bank-summary-response/valid/no-data.json';
import clogNoSource from '../../../shared/fixtures/api/collection-log-status-response/valid/no-source-and-off-on-server.json';
import diariesNoData from '../../../shared/fixtures/api/diaries-response/valid/no-data.json';
import sourcesOff from '../../../shared/fixtures/api/external-sources-response/valid/off.json';
import iconsEmpty from '../../../shared/fixtures/api/icons-status-response/valid/empty.json';
import adminKeysMixed from '../../../shared/fixtures/api/admin-keys-response/valid/mixed.json';
import invitesEmpty from '../../../shared/fixtures/api/invites-response/valid/empty.json';
import settingsDefault from '../../../shared/fixtures/api/server-settings-response/valid/default.json';
import usersTwo from '../../../shared/fixtures/api/users-response/valid/two-users.json';
import healthFixture from '../../../shared/fixtures/api/health-response/valid/health.json';
import petsNone from '../../../shared/fixtures/api/pets-response/valid/no-pets.json';
import questsNoData from '../../../shared/fixtures/api/quests-response/valid/no-data.json';
import { createQueryClient } from '@/api/query-client';
import { DESK_QUERY } from '@/hooks/useIsDesktop';
import { WIDE_QUERY } from '@/hooks/useIsWide';
import { App } from '@/App';
import { createRoutes } from '@/routing/routes';

// Renders the whole app at a path, with `fetch` answering from the contract
// fixtures in shared/fixtures/api/ (so responses are known to be valid).

/**
 * A response, or a function of the request URL that gives one. A function may
 * return a promise, e.g. to hold a response while a test looks at the loading state.
 */
export type MockAnswer =
  { status?: number; body: unknown } | ((url: string) => Response | Promise<Response>);

/**
 * The menu asks every account whether it has quest or diary data (the accounts
 * fixture has 1 and 2). By default: none, so no Quests & diaries page.
 */
function noQuestData(accountId: number): Record<string, MockAnswer> {
  return {
    [`/api/v1/accounts/${String(accountId)}/quests`]: { body: { ...questsNoData, accountId } },
    [`/api/v1/accounts/${String(accountId)}/diaries`]: { body: { ...diariesNoData, accountId } },
  };
}

/**
 * Answers by path (without the query string) for GET, or by method and path
 * (`'POST /api/v1/keys'`), which wins over the path alone. Other methods only
 * get a method answer, so a POST never gets a GET fixture by mistake.
 * Anything without an answer gets a 404 error body.
 */
export function mockApi(answers: Record<string, MockAnswer> = {}) {
  const all: Record<string, MockAnswer> = {
    '/api/v1/health': { body: healthFixture },
    // The instance text: the default, on the login page and `/about`.
    '/api/v1/about': { body: aboutDefault },
    // Local mode by default: no login, as before 9.2.
    '/api/v1/auth/me': { body: authLocal },
    '/api/v1/accounts': { body: accountsFixture },
    // The menu asks whether any account has bank data. By default: none, so no Bank page.
    '/api/v1/accounts/all/bank/summary': { body: bankSummaryNoData },
    ...noQuestData(1),
    ...noQuestData(2),
    // The menu and Settings → OSRS accounts: no collection log, and RuneProfile off.
    '/api/v1/accounts/1/collection-log/status': { body: { ...clogNoSource, accountId: 1 } },
    '/api/v1/accounts/2/collection-log/status': { body: { ...clogNoSource, accountId: 2 } },
    // The menu asks whether any account has a pet. By default: none, so no Pets page.
    '/api/v1/accounts/all/pets': { body: petsNone },
    '/api/v1/admin/external-sources': { body: sourcesOff },
    // Settings → Server: no icons uploaded yet.
    '/api/v1/admin/icons': { body: iconsEmpty },
    // Settings → Users: the local admin and a member, no invites.
    '/api/v1/users': { body: usersTwo },
    '/api/v1/invites': { body: invitesEmpty },
    // Every user's keys (one active, two revoked), and the default settings.
    '/api/v1/admin/keys': { body: adminKeysMixed },
    '/api/v1/admin/settings': { body: settingsDefault },
    ...answers,
  };
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.split('?')[0] ?? url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const answer = all[`${method} ${path}`] ?? (method === 'GET' ? all[path] : undefined);
    if (typeof answer === 'function') return Promise.resolve(answer(url));
    const status = answer?.status ?? (answer ? 200 : 404);
    const body = answer
      ? answer.body
      : { error: { code: 'NOT_FOUND', message: 'Not found', details: [] } };
    // A 204 response can't have a body.
    if (status === 204) return Promise.resolve(new Response(null, { status }));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function renderApp(path: string): { router: DataRouter; queryClient: QueryClient } {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  const queryClient = createQueryClient();
  render(<App queryClient={queryClient} router={router} />);
  return { router, queryClient };
}

/**
 * The PC layout (`useIsDesktop`): the account switcher and the profile icon
 * sit in the top bar. Without this, tests get the mobile layout, where they
 * sit in the page header. Undone by `vi.unstubAllGlobals` after each test.
 */
export function stubDesktop() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === DESK_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

/**
 * The wide PC layout (`useIsWide`, from 1100 px) as well as `stubDesktop`:
 * e.g. `StackedColumns` in two columns.
 */
export function stubWide() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === DESK_QUERY || query === WIDE_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

/**
 * A layout that can cross the PC breakpoint during a test (`useIsDesktop`):
 * `setDesktop` changes what the media query matches and tells its listeners,
 * as a window resized across 860 px does. Undone by `vi.unstubAllGlobals`.
 */
export function stubResizableLayout(desktop: boolean): { setDesktop: (next: boolean) => void } {
  let matches = desktop;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === DESK_QUERY && matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      if (query === DESK_QUERY) listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  return {
    setDesktop: (next) => {
      matches = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The destinations in the top bar. */
export async function findMainNav(): Promise<HTMLElement> {
  return within(await screen.findByRole('banner')).getByRole('navigation', { name: 'Main' });
}
