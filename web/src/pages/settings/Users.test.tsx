import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import createdLocal from '../../../../shared/fixtures/api/created-invite-response/valid/local-only.json';
import createdPublic from '../../../../shared/fixtures/api/created-invite-response/valid/created.json';
import invitesAll from '../../../../shared/fixtures/api/invites-response/valid/all-statuses.json';
import member from '../../../../shared/fixtures/api/auth-me-response/valid/logged-in.json';
import usersTwo from '../../../../shared/fixtures/api/users-response/valid/two-users.json';
import { mockApi, renderApp } from '@/test/render-app';
import { LOCAL_ONLY_WARNING } from '@/lib/invites';

// Settings → Users. The users fixture has the admin (you) and ola (a
// deactivated member who can't create keys).

const admin = {
  mode: 'login',
  user: {
    id: 1,
    username: 'admin',
    role: 'admin',
    canCreateApiKeys: true,
    twoFactorEnabled: false,
  },
};
const ADMIN = { '/api/v1/auth/me': { body: admin } };

/** Requests sent with `method` to `path`, with their JSON bodies. */
function bodiesOf(fetchMock: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === `/api/v1${path}` && (init?.method ?? 'GET') === method)
    .map(([, init]) =>
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    );
}

describe('Settings → Users', () => {
  it('lists users with role, key permission and status', async () => {
    mockApi({ ...ADMIN });
    renderApp('/settings/users');
    const list = await screen.findByRole('list', { name: 'Users' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/admin\(you\)Admin.*can create API keys/),
      expect.stringMatching(/olaMemberDeactivated.*never logged in.*can’t create API keys/),
    ]);
  });

  it('in local mode says to set a password first, and offers no invites or actions', async () => {
    mockApi();
    renderApp('/settings/users');
    expect(await screen.findByText(/Set a password under Profile first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create invite' })).toBeNull();
    await screen.findByRole('list', { name: 'Users' });
    expect(screen.queryByRole('button', { name: 'Actions for ola' })).toBeNull();
  });

  it('lists active invites, and the rest on their own screen, never a link', async () => {
    mockApi({ ...ADMIN, '/api/v1/invites': { body: invitesAll } });
    const { router } = renderApp('/settings/users');
    const list = await screen.findByRole('list', { name: 'Invites' });
    const rows = within(list).getAllByRole('listitem');
    // Only active links in the main list; the rest are behind the link row.
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(
        /K7Q2M4XPFor a friend.*Member · can create API keys · by admin.*expires/,
      ),
    ]);
    expect(within(list).getAllByRole('button', { name: /^Revoke/ })).toHaveLength(1);
    expect(list.textContent).not.toMatch(/http|#/);

    await userEvent.click(screen.getByRole('link', { name: /^Used, expired and revoked · 3/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/users/invites');
    });
    const past = await screen.findByRole('list', { name: 'Used, expired and revoked invites' });
    expect(
      within(past)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringMatching(/8F3D0A1ZInvite 8F3D0A1Z→ kari.*by a deleted user.*used.*Used/),
      expect.stringMatching(/9G4E1B2Y.*expired.*Expired/),
      expect.stringMatching(/AH5F2C3XPassword reset for ola.*revoked.*Revoked/),
    ]);
    expect(within(past).queryByRole('button')).toBeNull();
    expect(past.textContent).not.toMatch(/http|#/);
    await userEvent.click(screen.getByRole('link', { name: 'Users' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/users');
    });
  });

  it('has no link row without used, expired or revoked invites', async () => {
    mockApi({
      ...ADMIN,
      '/api/v1/invites': {
        body: { invites: invitesAll.invites.filter((invite) => invite.status === 'active') },
      },
    });
    renderApp('/settings/users');
    await screen.findByRole('list', { name: 'Invites' });
    expect(screen.queryByRole('link', { name: /Used, expired and revoked/ })).toBeNull();
  });

  it('creates an invite and shows the link once, with Copy and the PUBLIC_URL warning', async () => {
    const fetchMock = mockApi({
      ...ADMIN,
      'POST /api/v1/invites': { status: 201, body: createdLocal },
    });
    const { router } = renderApp('/settings/users');
    await userEvent.type(await screen.findByLabelText(/Label/), 'For a friend');
    await userEvent.click(screen.getByRole('radio', { name: '30 days' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Can create API keys' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create invite' }));

    const reveal = await screen.findByRole('region', { name: 'New invite link' });
    expect(within(reveal).getByText(createdLocal.url)).toBeTruthy();
    expect(within(reveal).getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(within(reveal).getByText(LOCAL_ONLY_WARNING)).toBeTruthy();
    expect(within(reveal).getByText(/You won't see this link again/)).toBeTruthy();
    expect(bodiesOf(fetchMock, 'POST', '/invites')).toEqual([
      { label: 'For a friend', role: 'member', canCreateApiKeys: false, days: 30 },
    ]);

    // Gone once you leave the tab.
    await router.navigate('/settings/keys');
    await screen.findByText('Create API key');
    await router.navigate('/settings/users');
    await screen.findByRole('list', { name: 'Users' });
    expect(screen.queryByRole('region', { name: 'New invite link' })).toBeNull();
  });

  it('shows no warning when PUBLIC_URL is set', async () => {
    mockApi({ ...ADMIN, 'POST /api/v1/invites': { status: 201, body: createdPublic } });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Create invite' }));
    const reveal = await screen.findByRole('region', { name: 'New invite link' });
    expect(within(reveal).queryByText(LOCAL_ONLY_WARNING)).toBeNull();
  });

  it('shows the server’s message when there are too many invites', async () => {
    mockApi({
      ...ADMIN,
      'POST /api/v1/invites': {
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'There are already 20 active invites. Revoke one or wait until one expires.',
            details: [],
          },
        },
      },
    });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Create invite' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already 20 active invites/);
  });

  it('revokes an invite after asking', async () => {
    const fetchMock = mockApi({
      ...ADMIN,
      '/api/v1/invites': { body: invitesAll },
      'DELETE /api/v1/invites/K7Q2M4XP': { status: 204, body: null },
    });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke K7Q2M4XP' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke For a friend?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke link' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'DELETE', '/invites/K7Q2M4XP')).toHaveLength(1);
    });
  });

  it('makes a password reset link from the user’s menu', async () => {
    const reset = {
      ...createdLocal,
      url: 'http://localhost:3100/reset-password#Q2xhdWRlIG1hZGUgdGhpcyBmaXh0dXJlIHRva2VuIQ',
      invite: invitesAll.invites[3],
    };
    mockApi({
      ...ADMIN,
      '/api/v1/users': {
        body: { users: [usersTwo.users[0], { ...usersTwo.users[1], disabledAt: null }] },
      },
      'POST /api/v1/users/2/password-reset': { status: 201, body: reset },
    });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for ola' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Password reset link' }));
    const reveal = await screen.findByRole('region', { name: 'New password reset link' });
    expect(within(reveal).getByText(reset.url)).toBeTruthy();
    expect(within(reveal).getByText(LOCAL_ONLY_WARNING)).toBeTruthy();
    expect(within(reveal).getByText(/It works once, for 24 hours/)).toBeTruthy();
  });

  it('changes role and key permission straight from the menu', async () => {
    const fetchMock = mockApi({
      ...ADMIN,
      'PATCH /api/v1/users/2': { body: { ...usersTwo.users[1], role: 'admin' } },
    });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for ola' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Make admin' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for ola' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Allow creating API keys' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PATCH', '/users/2')).toEqual([
        { role: 'admin' },
        { canCreateApiKeys: true },
      ]);
    });
  });

  it('shows the last-admin refusal', async () => {
    mockApi({
      ...ADMIN,
      'PATCH /api/v1/users/1': {
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'The last admin can’t be deleted, disabled or demoted',
            details: [],
          },
        },
      },
    });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for admin' }));
    // Your own row has no deactivate or delete.
    expect(screen.queryByRole('menuitem', { name: 'Deactivate' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /^Delete/ })).toBeNull();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Make member' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The last admin can’t be deleted, disabled or demoted',
    );
  });

  it('deletes a user only after their name is typed', async () => {
    const fetchMock = mockApi({ ...ADMIN, 'DELETE /api/v1/users/2': { status: 204, body: null } });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for ola' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete with all data' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Delete ola and all their data?',
    });
    const confirm = within(dialog).getByRole('button', { name: 'Delete user' });
    expect(confirm).toHaveProperty('disabled', true);
    await userEvent.type(within(dialog).getByLabelText('Type ola to confirm'), 'ola');
    expect(confirm).toHaveProperty('disabled', false);
    await userEvent.click(confirm);
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'DELETE', '/users/2')).toHaveLength(1);
    });
  });

  it('activates a deactivated user', async () => {
    const fetchMock = mockApi({
      ...ADMIN,
      'PATCH /api/v1/users/2': { body: { ...usersTwo.users[1], disabledAt: null } },
    });
    renderApp('/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for ola' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Activate' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PATCH', '/users/2')).toEqual([{ disabled: false }]);
    });
  });
});

describe('Settings → Profile: delete my account', () => {
  it('posts the password, for a member', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: member },
      'POST /api/v1/auth/delete-account': { status: 204, body: null },
    });
    renderApp('/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete my account' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'POST', '/auth/delete-account')).toEqual([
        { password: 'correct horse battery' },
      ]);
    });
    // A member never asks for the user list.
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/users')).toBe(false);
  });

  it('shows a wrong password in the dialog', async () => {
    mockApi({
      '/api/v1/auth/me': { body: member },
      'POST /api/v1/auth/delete-account': {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: [{ path: 'body.password', message: 'Wrong password' }],
          },
        },
      },
    });
    renderApp('/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'nope');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete my account' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Wrong password');
  });

  it('tells the only admin why they can’t', async () => {
    mockApi({ ...ADMIN });
    renderApp('/settings');
    expect(await screen.findByText(/You're the only admin/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  it('is not there in local mode', async () => {
    mockApi();
    renderApp('/settings');
    await screen.findByText('Time zone');
    expect(screen.queryByText('Delete my account')).toBeNull();
  });
});
