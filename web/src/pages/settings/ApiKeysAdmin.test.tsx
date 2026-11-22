import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import settingsDefault from '../../../../shared/fixtures/api/server-settings-response/valid/default.json';
import createdForUser from '../../../../shared/fixtures/api/create-user-key-response/valid/created.json';
import keysMixed from '../../../../shared/fixtures/api/keys-response/valid/mixed.json';
import memberMe from '../../../../shared/fixtures/api/auth-me-response/valid/logged-in.json';
import usersTwo from '../../../../shared/fixtures/api/users-response/valid/two-users.json';
import { mockApi, renderApp, stubDesktop } from '@/test/render-app';

// The key permission on Settings → API keys, every user's keys and blocking
// under Settings → Users, and the default for new invites under Settings →
// Server.

const adminMe = {
  mode: 'login',
  user: {
    id: 1,
    username: 'admin',
    role: 'admin',
    canCreateApiKeys: true,
    twoFactorEnabled: false,
  },
};
const ADMIN = { '/api/v1/auth/me': { body: adminMe } };
const NO_PERMISSION = 'You can’t create API keys on this server. Ask the server’s admin for a key.';

function bodiesOf(fetchMock: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === `/api/v1${path}` && (init?.method ?? 'GET') === method)
    .map(([, init]) =>
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    );
}

describe('Settings → API keys without the permission', () => {
  it('explains instead of offering the form, and keeps the list and revoking', async () => {
    // The member fixture can't create keys.
    mockApi({ '/api/v1/auth/me': { body: memberMe }, '/api/v1/keys': { body: keysMixed } });
    renderApp('/settings/keys');
    expect(await screen.findByText(NO_PERMISSION)).toBeTruthy();
    expect(screen.queryByText('Create API key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create key' })).toBeNull();
    const list = await screen.findByRole('list', { name: 'API keys' });
    expect(within(list).getAllByRole('button', { name: /^Revoke/ })).toHaveLength(2);
  });

  it('says which keys an admin made or revoked (login mode)', async () => {
    mockApi({ '/api/v1/auth/me': { body: memberMe }, '/api/v1/keys': { body: keysMixed } });
    renderApp('/settings/keys');
    const list = await screen.findByRole('list', { name: 'API keys' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[1]?.textContent).toMatch(/Created by admin/);
    // The revoked key is on its own screen.
    await userEvent.click(screen.getByRole('link', { name: /^Revoked keys · 1/ }));
    const revoked = await screen.findByRole('list', { name: 'Revoked keys' });
    expect(within(revoked).getByRole('listitem').textContent).toMatch(
      /revoked by admin.*Revoked by admin/,
    );
  });

  it('says neither in local mode, where the CLI is the only other actor', async () => {
    mockApi({ '/api/v1/keys': { body: keysMixed } });
    renderApp('/settings/keys');
    const list = await screen.findByRole('list', { name: 'API keys' });
    expect(list.textContent).not.toMatch(/by admin/);
    expect(screen.getByRole('button', { name: 'Create key' })).toBeTruthy();
  });

  it('shows the limit message from the server under the form', async () => {
    mockApi({
      ...ADMIN,
      '/api/v1/keys': { body: keysMixed },
      'POST /api/v1/keys': {
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'You already have 10 active API keys. Revoke one you no longer use first.',
            details: [],
          },
        },
      },
    });
    renderApp('/settings/keys');
    await userEvent.type(await screen.findByLabelText('Name'), 'PC');
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText(/already have 10 active API keys/)).toBeTruthy();
  });
});

describe('Settings → Users → API keys', () => {
  it('lists every user’s keys with owner and status, and never a key', async () => {
    mockApi({ ...ADMIN });
    renderApp('/settings/users');
    const list = await screen.findByRole('list', { name: 'All API keys' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/fs_a1b2…Gaming PCadmin.*last used/),
    ]);
    expect(within(list).getAllByRole('button', { name: /^Revoke/ })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'API keys 1 active · all users' })).toBeTruthy();

    // Revoked keys of every user are behind the link row, and Back returns to Users.
    await userEvent.click(screen.getByRole('link', { name: /^Revoked keys · 2/ }));
    const revoked = await screen.findByRole('list', { name: 'Revoked keys' });
    const texts = within(revoked)
      .getAllByRole('listitem')
      .map((row) => row.textContent);
    expect(texts).toHaveLength(2);
    expect(texts).toContainEqual(
      expect.stringMatching(
        /fs_0f3K…Old PCola.*Created by the server.*revoked by the server.*Revoked/,
      ),
    );
    expect(texts).toContainEqual(
      expect.stringMatching(/fs_Zx9q…Ola's laptopola.*Created by admin.*revoked by admin/),
    );
    expect(within(revoked).queryByRole('button')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Users' }));
    expect(await screen.findByRole('list', { name: 'All API keys' })).toBeTruthy();
  });

  it('revokes a key after asking', async () => {
    const fetchMock = mockApi({
      ...ADMIN,
      'DELETE /api/v1/admin/keys/1': { status: 204, body: null },
    });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Gaming PC (admin)' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Revoke “Gaming PC” (admin)?')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'DELETE', '/admin/keys/1')).toHaveLength(1);
    });
  });

  it('creates a key for a user from their menu and shows it once', async () => {
    // PC: the dialog starts in its field. (A sheet on mobile starts on its title.)
    stubDesktop();
    const fetchMock = mockApi({
      ...ADMIN,
      'POST /api/v1/users/1/keys': { status: 201, body: createdForUser },
    });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for admin' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Create API key…' }));
    const dialog = await screen.findByRole('alertdialog');
    // The dialog starts in the field, and Enter creates the key.
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Name'));
    });
    await userEvent.keyboard('Ola’s laptop{Enter}');

    const reveal = await screen.findByRole('region', { name: /^New API key/ });
    expect(within(reveal).getByText(createdForUser.key)).toBeTruthy();
    // Shown once, right under the Users card (not below Invites), and focus
    // moves to its heading when the dialog closes, so it is in view and read out.
    const usersList = screen.getByRole('list', { name: 'Users' });
    const invites = screen.getByRole('heading', { name: 'Invites' });
    expect(
      usersList.compareDocumentPosition(reveal) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(reveal.compareDocumentPosition(invites) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const heading = within(reveal).getByRole('heading');
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(within(reveal).getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(within(reveal).getByText(/give it to ola yourself/)).toBeTruthy();
    expect(bodiesOf(fetchMock, 'POST', '/users/1/keys')).toEqual([{ name: 'Ola’s laptop' }]);
  });

  it('offers no key for a deactivated user', async () => {
    mockApi({ ...ADMIN });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for ola' }));
    await screen.findByRole('menuitem', { name: 'Activate' });
    expect(screen.queryByRole('menuitem', { name: 'Create API key…' })).toBeNull();
  });
});

describe('Blocking a user’s keys', () => {
  // In the users fixture the admin has one active key, ola none.
  const blockAdmin = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for admin' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Block creating API keys' }));
    return screen.findByRole('alertdialog');
  };

  it('“Block only” keeps the keys', async () => {
    const fetchMock = mockApi({
      ...ADMIN,
      'PATCH /api/v1/users/1': { body: { ...usersTwo.users[0], canCreateApiKeys: false } },
    });
    renderApp('/settings/users');
    const dialog = await blockAdmin();
    expect(within(dialog).getByText(/They have 1 active key/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Block only' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PATCH', '/users/1')).toEqual([{ canCreateApiKeys: false }]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  it('“Block and revoke” revokes the active keys too', async () => {
    const fetchMock = mockApi({
      ...ADMIN,
      'PATCH /api/v1/users/1': {
        body: { ...usersTwo.users[0], canCreateApiKeys: false, activeApiKeys: 0 },
      },
    });
    renderApp('/settings/users');
    const dialog = await blockAdmin();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Block and revoke their key' }),
    );
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PATCH', '/users/1')).toEqual([
        { canCreateApiKeys: false, revokeActiveKeys: true },
      ]);
    });
    // The key lists are read again.
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'GET', '/admin/keys').length).toBeGreaterThan(1);
    });
  });

  it('blocks at once when the user has no active keys', async () => {
    const ola = { ...usersTwo.users[1], disabledAt: null, canCreateApiKeys: true };
    const fetchMock = mockApi({
      ...ADMIN,
      '/api/v1/users': { body: { users: [usersTwo.users[0], ola] } },
      'PATCH /api/v1/users/2': { body: { ...ola, canCreateApiKeys: false } },
    });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for ola' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Block creating API keys' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PATCH', '/users/2')).toEqual([{ canCreateApiKeys: false }]);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('Default for new invites', () => {
  it('is changed under Settings → Server', async () => {
    const fetchMock = mockApi({
      ...ADMIN,
      'PATCH /api/v1/admin/settings': {
        body: { ...settingsDefault, defaultInviteCanCreateApiKeys: false },
      },
    });
    renderApp('/settings/server');
    const toggle = await screen.findByRole('switch', { name: 'Can create API keys' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PATCH', '/admin/settings')).toEqual([
        { defaultInviteCanCreateApiKeys: false },
      ]);
    });
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
  });

  it('pre-selects the invite form', async () => {
    const fetchMock = mockApi({
      ...ADMIN,
      '/api/v1/admin/settings': {
        body: { ...settingsDefault, defaultInviteCanCreateApiKeys: false },
      },
      'POST /api/v1/invites': {
        status: 409,
        body: { error: { code: 'CONFLICT', message: 'x', details: [] } },
      },
    });
    renderApp('/settings/users');
    const toggle = await screen.findByRole('switch', { name: 'Can create API keys' });
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'POST', '/invites')).toEqual([
        { label: '', role: 'member', canCreateApiKeys: false, days: 7 },
      ]);
    });
  });
});
