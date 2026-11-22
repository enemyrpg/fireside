import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import member from '../../../shared/fixtures/api/auth-me-response/valid/logged-in.json';
import { PAGES, type PageDef } from '@/pages/registry';
import { SETTINGS_SERVER_PATH } from '@/pages/settings/paths';
import { mockApi, renderApp, stubDesktop } from '@/test/render-app';

// A member never reaches an admin-only endpoint: the server would answer `403`.
// Every page in the registry is opened as a member with the admin endpoints
// answering `403`, as the server does; any `403` fails. A new page is covered
// automatically.

const FORBIDDEN = {
  status: 403,
  body: { error: { code: 'FORBIDDEN', message: 'Only an admin can do this', details: [] } },
};

/** The admin endpoints the dashboard knows, all `403` for a member. */
const ADMIN_ROUTES = {
  '/api/v1/admin/backups': FORBIDDEN,
  '/api/v1/admin/external-sources': FORBIDDEN,
  '/api/v1/admin/icons': FORBIDDEN,
  'POST /api/v1/admin/rebuild': FORBIDDEN,
  '/api/v1/users': FORBIDDEN,
  '/api/v1/invites': FORBIDDEN,
};

const SESSION_ID = '0190f5a0-0000-7000-8000-000000000001';

/** A URL that opens `page` (`all` for account pages, a session ID for session detail). */
function urlOf(page: PageDef): string {
  const path = page.path
    .replace(/\/:[a-zA-Z]+\?$/, '')
    .replace(':sessionId', SESSION_ID)
    .replace(/\/:[a-zA-Z]+\?\//, '/');
  if (!page.scoped) return path;
  return path === '' ? '/all' : `/all/${path}`;
}

const urlOfCall = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Lets every request start and answer, so the page settles. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}

describe('every page as a member', () => {
  it.each(PAGES.map((page) => [page.id, page] as const))(
    '%s makes no admin-only request and gets no 403',
    async (_id, page) => {
      const fetchMock = mockApi({ '/api/v1/auth/me': { body: member }, ...ADMIN_ROUTES });
      renderApp(urlOf(page));
      await settle();

      const responses = await Promise.all(
        fetchMock.mock.results.map((result) => result.value as Promise<Response>),
      );
      const forbidden = responses
        .map((response, index) => ({ response, call: fetchMock.mock.calls[index] }))
        .filter(({ response }) => response.status === 403)
        .map(({ call }) => (call ? urlOfCall(call[0]) : '?'));
      expect(forbidden).toEqual([]);
      const adminCalls = fetchMock.mock.calls
        .map(([input]) => urlOfCall(input))
        .filter((url) => /\/api\/v1\/(admin\/|users|invites)/.test(url));
      expect(adminCalls).toEqual([]);
      expect(screen.queryByText('Only an admin can see this.')).toBeNull();
    },
  );

  it('opens Settings → Server as a page that does not exist', async () => {
    mockApi({ '/api/v1/auth/me': { body: member }, ...ADMIN_ROUTES });
    renderApp(SETTINGS_SERVER_PATH);
    expect(await screen.findByText("This page doesn't exist.")).toBeTruthy();
  });

  it('has no Users or Server in the Settings menu on PC', async () => {
    stubDesktop();
    mockApi({ '/api/v1/auth/me': { body: member }, ...ADMIN_ROUTES });
    renderApp('/settings');
    const menu = await screen.findByRole('navigation', { name: 'Settings' });
    expect(
      within(menu)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Profile', 'API keys', 'OSRS accounts']);
    expect(screen.queryByText('Users and Server are for admins only.')).toBeNull();
  });

  it('has no Users or Server in the Settings dropdown on mobile', async () => {
    mockApi({ '/api/v1/auth/me': { body: member }, ...ADMIN_ROUTES });
    renderApp('/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Settings section: Profile' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Profile', 'API keys', 'OSRS accounts']);
  });

  it.each(['/settings/users/invites', '/settings/users/keys/revoked'])(
    'opens %s as a page that does not exist',
    async (path) => {
      mockApi({ '/api/v1/auth/me': { body: member }, ...ADMIN_ROUTES });
      renderApp(path);
      expect(await screen.findByText("This page doesn't exist.")).toBeTruthy();
    },
  );

  it('says the collection log source is off without naming .env settings', async () => {
    mockApi({ '/api/v1/auth/me': { body: member }, ...ADMIN_ROUTES });
    renderApp('/settings/accounts');
    const notes = await screen.findAllByText(
      "Off on this server. The server's admin can turn it on.",
    );
    expect(notes.length).toBeGreaterThan(0);
    expect(screen.queryByText(/RUNEPROFILE_ENABLED/)).toBeNull();
  });
});

describe('Settings as an admin in login mode', () => {
  it('has the Server tab', async () => {
    mockApi({
      '/api/v1/auth/me': { body: { mode: 'login', user: { ...member.user, role: 'admin' } } },
    });
    stubDesktop();
    renderApp('/settings');
    const menu = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(menu).getByRole('link', { name: 'Server' })).toBeTruthy();
  });
});
