import { BRANDING } from '@fireside/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import accountWithNames from '../../../../shared/fixtures/api/account-detail-response/valid/with-names.json';
import clogBeforeNameLog from '../../../../shared/fixtures/api/collection-log-response/valid/profile-from-before-name.json';
import clogNeverSyncedLog from '../../../../shared/fixtures/api/collection-log-response/valid/never-synced.json';
import clogNotFoundLog from '../../../../shared/fixtures/api/collection-log-response/valid/profile-not-found.json';
import clogSourceOffLog from '../../../../shared/fixtures/api/collection-log-response/valid/source-off.json';
import clogSyncedLog from '../../../../shared/fixtures/api/collection-log-response/valid/synced.json';
import clogNoSourceOn from '../../../../shared/fixtures/api/collection-log-status-response/valid/no-source.json';
import clogStarted from '../../../../shared/fixtures/api/collection-log-sync-response/valid/started.json';
import createdKey from '../../../../shared/fixtures/api/create-key-response/valid/created.json';
import keysMixed from '../../../../shared/fixtures/api/keys-response/valid/mixed.json';
import backupDisabled from '../../../../shared/fixtures/api/backup-status-response/valid/disabled.json';
import backupFailed from '../../../../shared/fixtures/api/backup-status-response/valid/failed.json';
import backupNoneYet from '../../../../shared/fixtures/api/backup-status-response/valid/none-yet.json';
import backupOk from '../../../../shared/fixtures/api/backup-status-response/valid/ok.json';
import sourcesFailed from '../../../../shared/fixtures/api/external-sources-response/valid/failed.json';
import sourcesNoContact from '../../../../shared/fixtures/api/external-sources-response/valid/no-contact.json';
import sourcesOff from '../../../../shared/fixtures/api/external-sources-response/valid/off.json';
import sourcesOk from '../../../../shared/fixtures/api/external-sources-response/valid/ok.json';
import iconsImported from '../../../../shared/fixtures/api/icons-status-response/valid/imported.json';
import rebuildOk from '../../../../shared/fixtures/api/rebuild-response/valid/ok.json';
import rebuildWithFailures from '../../../../shared/fixtures/api/rebuild-response/valid/with-failures.json';
import { mockApi, renderApp, stubDesktop } from '@/test/render-app';

// Settings tabs. The keys fixture has two active keys (Gaming PC, used; Laptop,
// never used) and one revoked (Old PC). The accounts fixture has Test Main (1,
// Ironman, total 1,850) and Alt (2, Normal, no level).

const serverError = {
  status: 500,
  body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: [] } },
};

const nameError = {
  status: 400,
  body: {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request body',
      details: [{ path: 'body.name', message: 'Give the key a name.' }],
    },
  },
};

const altDetail = {
  ...accountWithNames,
  id: 2,
  displayName: 'Alt',
  accountType: 'NORMAL',
  totalLevel: null,
  totalXp: null,
  names: [accountWithNames.names[1]],
};

/** Requests sent with `method` to `path`. */
function callsTo(fetchMock: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => url === `/api/v1${path}` && (init?.method ?? 'GET') === method,
  );
}

const SECTIONS = [
  ['/settings', 'Profile'],
  ['/settings/keys', 'API keys'],
  ['/settings/accounts', 'OSRS accounts'],
  ['/settings/users', 'Users'],
  ['/settings/server', 'Server'],
  // History screens keep their tab marked.
  ['/settings/keys/revoked', 'API keys'],
  ['/settings/users/invites', 'Users'],
  ['/settings/users/keys/revoked', 'Users'],
] as const;

describe('settings menu on PC', () => {
  beforeEach(() => {
    stubDesktop();
  });

  it.each(SECTIONS)('%s marks only %s and hides the account switcher', async (path, tab) => {
    mockApi({ '/api/v1/keys': { body: keysMixed } });
    renderApp(path);
    const menu = await screen.findByRole('navigation', { name: 'Settings' });
    const links = within(menu).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Profile',
      'API keys',
      'OSRS accounts',
      'Users',
      'Server',
    ]);
    // Regression: a circular import once left a tab without a path, marked with Profile.
    expect(
      links
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((l) => l.textContent),
    ).toEqual([tab]);
    expect(screen.getByText('Users and Server are for admins only.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Choose account/ })).toBeNull();
    // The profile icon stays marked on every screen.
    expect(
      screen.getByRole('link', { name: 'Settings and profile' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  // Local mode, so the user is an admin and has the Server tab.
  it('opens Settings → Server from Profile for an admin', async () => {
    mockApi();
    const { router } = renderApp('/settings');
    const menu = await screen.findByRole('navigation', { name: 'Settings' });
    const serverLink = within(menu).getByRole('link', { name: 'Server' });
    expect(serverLink.getAttribute('href')).toBe('/settings/server');
    await userEvent.click(serverLink);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/server');
    });
    expect(await screen.findByText('Server version')).toBeTruthy();
    const current = within(screen.getByRole('navigation', { name: 'Settings' }))
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent);
    expect(current).toEqual(['Server']);
  });
});

describe('settings menu on mobile', () => {
  it('is a dropdown named after the current tab, with every tab as a link', async () => {
    mockApi();
    const { router } = renderApp('/settings/keys');
    const menu = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(menu).queryAllByRole('link')).toHaveLength(0);
    const trigger = within(menu).getByRole('button', { name: 'Settings section: API keys' });
    await userEvent.click(trigger);
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Profile',
      'API keys',
      'OSRS accounts',
      'Users',
      'Server',
    ]);
    expect(items[1]?.getAttribute('aria-current')).toBe('page');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Server' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/server');
    });
    expect(await screen.findByRole('button', { name: 'Settings section: Server' })).toBeTruthy();
  });
});

describe('API keys', () => {
  it('lists only active keys, with the revoked ones behind a link row', async () => {
    mockApi({ '/api/v1/keys': { body: keysMixed } });
    renderApp('/settings/keys');
    const list = await screen.findByRole('list', { name: 'API keys' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/fs_a1b2….*Gaming PC.*Created 1 Nov, 19:00 · last used/),
      expect.stringMatching(/fs_Zx9q….*Laptop.*never used/),
    ]);
    expect(screen.getByRole('heading', { name: 'API keys 2 active' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke Gaming PC' })).toBeTruthy();
    expect(screen.queryByText('Old PC')).toBeNull();
    const more = screen.getByRole('link', { name: /^Revoked keys · 1/ });
    expect(more.getAttribute('href')).toBe('/settings/keys/revoked');
  });

  it('opens the revoked keys, and Back returns to the list', async () => {
    mockApi({ '/api/v1/keys': { body: keysMixed } });
    const { router } = renderApp('/settings/keys');
    await userEvent.click(await screen.findByRole('link', { name: /^Revoked keys · 1/ }));
    const list = await screen.findByRole('list', { name: 'Revoked keys' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([expect.stringMatching(/fs_0f3K….*Old PC.*revoked 1 Nov, 10:00.*Revoked/)]);
    // Read only: nothing to revoke here.
    expect(within(list).queryByRole('button')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'API keys' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/keys');
    });
  });

  it('has no link row without revoked keys', async () => {
    mockApi({ '/api/v1/keys': { body: { keys: keysMixed.keys.filter((k) => !k.revokedAt) } } });
    renderApp('/settings/keys');
    await screen.findByRole('list', { name: 'API keys' });
    expect(screen.queryByRole('link', { name: /Revoked keys/ })).toBeNull();
  });

  it('invites to create a key when there are none', async () => {
    mockApi({ '/api/v1/keys': { body: { keys: [] } } });
    renderApp('/settings/keys');
    expect(
      await screen.findByText('No API keys yet. Create one below and paste it into the plugin.'),
    ).toBeTruthy();
  });

  it('shows a retry when the list fails, and the form still works', async () => {
    mockApi({ '/api/v1/keys': serverError });
    renderApp('/settings/keys');
    expect(await screen.findByText("Couldn't load this.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create key' })).toBeTruthy();
  });

  it('shows the new key once, copies it and refreshes the list', async () => {
    let created = false;
    const fetchMock = mockApi({
      'GET /api/v1/keys': () =>
        Response.json(
          created ? { keys: [...keysMixed.keys, createdKey.apiKey] } : { keys: keysMixed.keys },
        ),
      'POST /api/v1/keys': () => {
        created = true;
        return Response.json(createdKey, { status: 201 });
      },
    });
    renderApp('/settings/keys');
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'API keys' });
    await user.type(screen.getByLabelText('Name'), 'Gaming PC');
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    const reveal = await screen.findByRole('region', { name: 'New API key Gaming PC' });
    expect(within(reveal).getByText(createdKey.key)).toBeTruthy();
    expect(within(reveal).getByText("Copy it now. You won't see the full key again.")).toBeTruthy();
    // Screen readers announce a short message, never the key.
    const announced = within(reveal).getByRole('status');
    expect(announced.textContent).toBe('API key created. Copy it now.');
    const post = callsTo(fetchMock, 'POST', '/keys')[0];
    expect(post?.[1]?.body).toBe('{"name":"Gaming PC"}');
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('');

    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    expect(await within(reveal).findByText('Copied')).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe(createdKey.key);

    const list = screen.getByRole('list', { name: 'API keys' });
    await waitFor(() => {
      expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    });
    // The list itself never holds the full key.
    expect(within(list).queryByText(createdKey.key)).toBeNull();
  });

  it('says so when the clipboard is refused', async () => {
    mockApi({
      '/api/v1/keys': { body: keysMixed },
      'POST /api/v1/keys': { status: 201, body: createdKey },
    });
    renderApp('/settings/keys');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'Gaming PC');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const reveal = await screen.findByRole('region', { name: 'New API key Gaming PC' });
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: () => Promise.reject(new Error('Denied')),
    });
    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    expect(await within(reveal).findByText('Copy failed')).toBeTruthy();
  });

  it('shows the name rule under the field and clears it on typing', async () => {
    mockApi({ '/api/v1/keys': { body: keysMixed }, 'POST /api/v1/keys': nameError });
    renderApp('/settings/keys');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const input = screen.getByLabelText('Name');
    expect(await screen.findByText('Give the key a name.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /New API key/ })).toBeNull();
    await user.type(input, 'x');
    expect(screen.queryByText('Give the key a name.')).toBeNull();
  });

  it('shows a general message for other create errors', async () => {
    mockApi({ '/api/v1/keys': { body: keysMixed }, 'POST /api/v1/keys': serverError });
    renderApp('/settings/keys');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'Gaming PC');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText("Couldn't create the key. Try again.")).toBeTruthy();
  });

  it('shows "Creating…" and can\'t be sent twice', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = mockApi({
      '/api/v1/keys': { body: keysMixed },
      'POST /api/v1/keys': () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    renderApp('/settings/keys');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'Gaming PC');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const pending = await screen.findByRole('button', { name: 'Creating…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Name'), '{Enter}');
    expect(callsTo(fetchMock, 'POST', '/keys')).toHaveLength(1);
    answer(Response.json(createdKey, { status: 201 }));
    expect(await screen.findByRole('button', { name: 'Create key' })).toBeTruthy();
  });

  it('revokes only after confirming', async () => {
    let revoked = false;
    const fetchMock = mockApi({
      'GET /api/v1/keys': () =>
        Response.json({
          keys: keysMixed.keys.map((key) =>
            key.id === 1 && revoked ? { ...key, revokedAt: '2026-11-10T20:00:00.000Z' } : key,
          ),
        }),
      'DELETE /api/v1/keys/1': () => {
        revoked = true;
        return new Response(null, { status: 204 });
      },
    });
    renderApp('/settings/keys');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revoke Gaming PC' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke “Gaming PC”?' });
    expect(
      within(dialog).getByText(
        "RuneLite clients using this key stop sending data right away. This can't be undone.",
      ),
    ).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(callsTo(fetchMock, 'DELETE', '/keys/1')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Revoke Gaming PC' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke key' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(callsTo(fetchMock, 'DELETE', '/keys/1')).toHaveLength(1);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Revoke Gaming PC' })).toBeNull();
    });
    expect(await screen.findByRole('link', { name: /^Revoked keys · 2/ })).toBeTruthy();
  });

  it('returns focus to the revoke button when the dialog closes', async () => {
    mockApi({ 'GET /api/v1/keys': { body: keysMixed } });
    renderApp('/settings/keys');
    const user = userEvent.setup();
    const revokeButton = await screen.findByRole('button', { name: 'Revoke Gaming PC' });

    revokeButton.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(revokeButton);
    });

    await user.keyboard('{Enter}');
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(revokeButton);
    });
  });

  it('keeps the dialog open with a message when revoking fails', async () => {
    mockApi({ '/api/v1/keys': { body: keysMixed }, 'DELETE /api/v1/keys/1': serverError });
    renderApp('/settings/keys');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revoke Gaming PC' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
    expect(await within(dialog).findByText("Couldn't revoke the key. Try again.")).toBeTruthy();
  });
});

describe('OSRS accounts', () => {
  it('shows colour, type, first and last seen, total level and name history', async () => {
    mockApi({
      '/api/v1/accounts/1': { body: accountWithNames },
      '/api/v1/accounts/2': { body: altDetail },
    });
    renderApp('/settings/accounts');
    const list = await screen.findByRole('list', { name: 'OSRS accounts' });
    const [testMain, alt] = within(list).getAllByRole('listitem');
    if (!testMain || !alt) throw new Error('Expected two accounts');
    // One card per account: name, type and level, then rows.
    expect(within(testMain).getByRole('heading', { name: 'Test Main' })).toBeTruthy();
    expect(testMain.textContent).toMatch(/Test MainIronman · total level 1,850(Online|Last seen )/);
    expect(testMain.textContent).toContain('First seenSun 1 Nov');
    await within(testMain).findByText(/OldName/);
    expect(testMain.textContent).toContain('Name historyTest Main (Nov 2026) ← OldName (Nov 2026)');
    expect(alt.textContent).toMatch(/Alt.*Normal/);
    // No level yet, and only one name: no history.
    expect(alt.textContent).not.toContain('total level');
    await waitFor(() => {
      expect(within(alt).queryByLabelText('Loading')).toBeNull();
    });
    expect(alt.textContent).toContain('Name historyNo earlier names');
  });

  it('shows accounts without a name as "Unknown account" without a type', async () => {
    mockApi({
      '/api/v1/accounts': {
        body: {
          accounts: [
            {
              id: 3,
              displayName: null,
              accountType: null,
              firstSeenAt: '2026-11-08T19:00:00.000Z',
              lastSeenAt: '2026-11-08T19:05:00.000Z',
              totalLevel: null,
              totalXp: null,
              latestSession: null,
            },
          ],
        },
      },
    });
    renderApp('/settings/accounts');
    const list = await screen.findByRole('list', { name: 'OSRS accounts' });
    const row = within(list).getByRole('listitem');
    expect(row.textContent).toMatch(/^Unknown account(Online|Last seen )/);
  });

  it('shows a retry for one account whose name history fails', async () => {
    mockApi({ '/api/v1/accounts/1': serverError, '/api/v1/accounts/2': { body: altDetail } });
    renderApp('/settings/accounts');
    expect(await screen.findByText("Couldn't load the name history.")).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(screen.getByText('Alt')).toBeTruthy();
  });

  it('invites to connect the plugin when there are no accounts', async () => {
    mockApi({ '/api/v1/accounts': { body: { accounts: [] } } });
    renderApp('/settings/accounts');
    expect(
      await screen.findByText('Accounts show up here the first time they log in with the plugin.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create an API key' }).getAttribute('href')).toBe(
      '/settings/keys',
    );
  });
});

describe('Collection log from RuneProfile', () => {
  /** The status endpoint gives the collection log without its tabs. */
  function statusOf<T extends { tabs: unknown }>(log: T): Omit<T, 'tabs'> {
    const status: Omit<T, 'tabs'> & { tabs?: unknown } = { ...log };
    delete status.tabs;
    return status;
  }
  const clogBeforeName = statusOf(clogBeforeNameLog);
  const clogNeverSynced = statusOf(clogNeverSyncedLog);
  const clogNotFound = statusOf(clogNotFoundLog);
  const clogSourceOff = statusOf(clogSourceOffLog);
  const clogSynced = statusOf(clogSyncedLog);
  const CLOG = '/api/v1/accounts/1/collection-log';
  const STATUS = `${CLOG}/status`;
  /** External sources with RuneProfile on in `.env`. */
  const runeProfileOn = {
    contactSet: true,
    sources: sourcesOff.sources.map((source) =>
      source.id === 'RUNEPROFILE'
        ? { ...source, enabled: true, active: true, nextFetchAt: '2026-11-08T21:00:00.000Z' }
        : source,
    ),
  };
  const on = {
    '/api/v1/admin/external-sources': { body: runeProfileOn },
    '/api/v1/accounts/1/collection-log/status': { body: { ...clogNoSourceOn, accountId: 1 } },
    '/api/v1/accounts/2/collection-log/status': { body: { ...clogNoSourceOn, accountId: 2 } },
    '/api/v1/accounts/1': { body: accountWithNames },
    '/api/v1/accounts/2': { body: altDetail },
  };

  /** Test Main's row (account 1), once its collection log setting has loaded. */
  async function testMainRow() {
    const list = await screen.findByRole('list', { name: 'OSRS accounts' });
    const [row] = within(list).getAllByRole('listitem');
    if (!row) throw new Error('Expected an account');
    await within(row).findByRole('switch', { name: 'Collection log from RuneProfile' });
    return row;
  }
  const toggle = (row: HTMLElement) =>
    within(row).getByRole('switch', { name: 'Collection log from RuneProfile' });

  it('is off by default and says that a RuneProfile profile is public', async () => {
    mockApi(on);
    renderApp('/settings/accounts');
    const row = await testMainRow();
    expect(toggle(row).getAttribute('aria-checked')).toBe('false');
    expect(toggle(row)).toHaveProperty('disabled', false);
    expect(row.textContent).toContain(
      'Needs the RuneProfile plugin in RuneLite. A RuneProfile profile is public: anyone can see its collection log, quests and diaries.',
    );
    expect(within(row).queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('cannot be turned on while RuneProfile is off on the server, and names the setting', async () => {
    mockApi();
    renderApp('/settings/accounts');
    const row = await testMainRow();
    await within(row).findByText(/Off on this server/);
    expect(toggle(row)).toHaveProperty('disabled', true);
    expect(row.textContent).toContain('Off on this server: set RUNEPROFILE_ENABLED=true in .env.');
  });

  it('turns the source on for that account only', async () => {
    let turnedOn = false;
    const fetchMock = mockApi({
      ...on,
      [STATUS]: () =>
        Response.json(
          turnedOn ? clogNeverSynced : { ...clogNeverSynced, source: null, sync: null },
        ),
      [`PUT ${CLOG}/source`]: () => {
        turnedOn = true;
        return Response.json({ ...clogStarted, accountId: 1 });
      },
    });
    renderApp('/settings/accounts');
    const row = await testMainRow();
    await userEvent.setup().click(toggle(row));
    await waitFor(() => {
      expect(toggle(row).getAttribute('aria-checked')).toBe('true');
    });
    const calls = callsTo(fetchMock, 'PUT', '/accounts/1/collection-log/source');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]?.body).toBe(JSON.stringify({ source: 'RUNEPROFILE' }));
    expect(callsTo(fetchMock, 'PUT', '/accounts/2/collection-log/source')).toEqual([]);
  });

  it('shows the slot count and the last sync, and can be turned off', async () => {
    const fetchMock = mockApi({
      ...on,
      [STATUS]: { body: clogSynced },
      [`PUT ${CLOG}/source`]: { body: { accountId: 1, source: null, sync: null } },
    });
    renderApp('/settings/accounts');
    const row = await testMainRow();
    expect(toggle(row).getAttribute('aria-checked')).toBe('true');
    expect(row.textContent).toMatch(/3 of 4 collection log slots · synced /);
    // Only the light status: the whole collection log is never downloaded here.
    expect(callsTo(fetchMock, 'GET', '/accounts/1/collection-log/status')).not.toEqual([]);
    expect(callsTo(fetchMock, 'GET', '/accounts/1/collection-log')).toEqual([]);
    expect(within(row).queryByRole('alert')).toBeNull();
    await userEvent.setup().click(toggle(row));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'PUT', '/accounts/1/collection-log/source')[0]?.[1]?.body).toBe(
        JSON.stringify({ source: null }),
      );
    });
  });

  it('starts a sync with "Sync now"', async () => {
    const fetchMock = mockApi({
      ...on,
      [STATUS]: { body: clogSynced },
      [`POST ${CLOG}/sync`]: { status: 202, body: { ...clogStarted, accountId: 1 } },
    });
    renderApp('/settings/accounts');
    const row = await testMainRow();
    const button = within(row).getByRole('button', { name: 'Sync now' });
    expect(button).toHaveProperty('disabled', false);
    await userEvent.setup().click(button);
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', '/accounts/1/collection-log/sync')).toHaveLength(1);
    });
  });

  it('says so when a sync could not be started', async () => {
    mockApi({
      ...on,
      [STATUS]: { body: clogSynced },
      [`POST ${CLOG}/sync`]: {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'Too soon', details: [] } },
      },
    });
    renderApp('/settings/accounts');
    const row = await testMainRow();
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Sync now' }));
    expect(
      await within(row).findByText("Couldn't start a sync. Try again in a minute."),
    ).toBeTruthy();
  });

  it('tells the owner what to do when the profile is older than our record of the name', async () => {
    mockApi({ ...on, [STATUS]: { body: clogBeforeName } });
    renderApp('/settings/accounts');
    const row = await testMainRow();
    expect(within(row).getByRole('alert').textContent).toBe(
      `This RuneProfile profile is older than ${BRANDING.displayName}’s record of this name. Log in with the RuneProfile plugin on so it uploads, then click Sync now.`,
    );
    // "Sync now" is there to click afterwards.
    expect(within(row).getByRole('button', { name: 'Sync now' })).toHaveProperty('disabled', false);
  });

  it('names the account when RuneProfile has no profile for it, and waits out the minute', async () => {
    const soon = new Date(Date.now() + 45_000).toISOString();
    mockApi({
      ...on,
      [STATUS]: {
        body: { ...clogNotFound, sync: { ...clogNotFound.sync, nextSyncAllowedAt: soon } },
      },
    });
    renderApp('/settings/accounts');
    const row = await testMainRow();
    expect(within(row).getByRole('alert').textContent).toBe(
      'No RuneProfile profile named Test Main. If you changed name, or have not used the RuneProfile plugin yet, log in with the RuneProfile plugin on so it uploads, then click Sync now.',
    );
    expect(within(row).getByRole('button', { name: 'Sync now' })).toHaveProperty('disabled', true);
  });

  it.each([
    ['not synced yet', clogNeverSynced, 'Not synced yet.', false],
    [
      'off on the server',
      clogSourceOff,
      'RuneProfile is off on this server, so nothing is fetched.',
      true,
    ],
  ])('shows a status when %s', async (_name, body, text, syncDisabled) => {
    mockApi({ ...on, [STATUS]: { body } });
    renderApp('/settings/accounts');
    const row = await testMainRow();
    expect(within(row).getByRole('status').textContent).toBe(text);
    expect(within(row).getByRole('button', { name: 'Sync now' })).toHaveProperty(
      'disabled',
      syncDisabled,
    );
  });

  it('keeps the row usable when the collection log setting fails to load', async () => {
    mockApi({ ...on, [STATUS]: serverError });
    renderApp('/settings/accounts');
    const list = await screen.findByRole('list', { name: 'OSRS accounts' });
    const [row] = within(list).getAllByRole('listitem');
    if (!row) throw new Error('Expected an account');
    expect(await within(row).findByText("Couldn't load the collection log settings.")).toBeTruthy();
    expect(row.textContent).toContain('Test Main');
  });
});

describe('Server', () => {
  it('shows the server and contract versions', async () => {
    mockApi();
    renderApp('/settings/server');
    expect(await screen.findByText('Server version')).toBeTruthy();
    const card = screen.getByText('Server version').closest('section');
    if (!card) throw new Error('Expected the Server card');
    expect(within(card).getByText('0.1.0')).toBeTruthy();
    expect(within(card).getByText('1.7.0')).toBeTruthy();
  });

  /** The Server card, once the icon counts are loaded. */
  async function serverCard() {
    const label = await screen.findByText('Icons');
    const card = label.closest('section');
    if (!card) throw new Error('Expected the Server card');
    return card;
  }

  it('shows how many icons are stored, per kind', async () => {
    mockApi({ '/api/v1/admin/icons': { body: iconsImported } });
    renderApp('/settings/server');
    const card = await serverCard();
    expect(within(card).getByText('1,738 items · 25 skills · 72 bosses')).toBeTruthy();
    // The fixture's newest icon is old: the import is over.
    expect(within(card).queryByText('Importing icons from RuneLite…')).toBeNull();
  });

  it('shows zero icons before the plugin has uploaded any, without a note', async () => {
    mockApi();
    renderApp('/settings/server');
    const card = await serverCard();
    expect(within(card).getByText('0 items · 0 skills · 0 bosses')).toBeTruthy();
    expect(within(card).queryByRole('status')).toBeNull();
  });

  it('says that icons are being imported while the newest one is fresh', async () => {
    const body = {
      items: 1,
      skills: 1,
      bosses: 1,
      lastStoredAt: new Date(Date.now() - 30_000).toISOString(),
    };
    mockApi({ '/api/v1/admin/icons': { body } });
    renderApp('/settings/server');
    const card = await serverCard();
    expect(within(card).getByText('1 item · 1 skill · 1 boss')).toBeTruthy();
    expect(within(card).getByRole('status').textContent).toBe('Importing icons from RuneLite…');
  });

  it('shows an error state when the icon counts fail to load', async () => {
    mockApi({ '/api/v1/admin/icons': serverError });
    renderApp('/settings/server');
    const heading = await screen.findByRole('heading', { name: 'Server' });
    const card = heading.closest('section');
    if (!card) throw new Error('Expected the Server card');
    expect(await within(card).findByRole('button', { name: /retry/i })).toBeTruthy();
    expect(within(card).getByText('Server version')).toBeTruthy();
  });

  /** The Backups card, once loaded. */
  async function backupsCard() {
    const heading = await screen.findByRole('heading', { name: 'Backups' });
    const card = heading.closest('section');
    if (!card) throw new Error('Expected the Backups card');
    await within(card).findByText('Last backup');
    return card;
  }

  /** The value next to `label` in the card. */
  function row(card: HTMLElement, label: string) {
    // With several sources, the first one's row (OSRS Wiki Prices).
    return within(card).getAllByText(label)[0]?.parentElement?.textContent ?? '';
  }

  it('shows the last backup, how many are kept and the next run', async () => {
    mockApi({ '/api/v1/admin/backups': { body: backupOk } });
    renderApp('/settings/server');
    const card = await backupsCard();
    // The health fixture's time zone; 03:00 UTC is 04:00 in Oslo.
    expect(row(card, 'Last backup')).toMatch(/14 Nov( 2026)?, 04:00 · 19 MB$/);
    expect(row(card, 'Backups kept')).toMatch(/12 \(214 MB\)$/);
    expect(row(card, 'Next backup')).toMatch(/15 Nov( 2026)?, 04:00$/);
    expect(within(card).queryByRole('alert')).toBeNull();
    expect(within(card).getByText('pnpm cli restore <file>')).toBeTruthy();
  });

  it('shows when there are no backups yet', async () => {
    mockApi({ '/api/v1/admin/backups': { body: backupNoneYet } });
    renderApp('/settings/server');
    const card = await backupsCard();
    expect(row(card, 'Last backup')).toMatch(/None yet$/);
    expect(row(card, 'Backups kept')).toMatch(/0 \(0 B\)$/);
  });

  it('shows the last error', async () => {
    mockApi({ '/api/v1/admin/backups': { body: backupFailed } });
    renderApp('/settings/server');
    const card = await backupsCard();
    expect(within(card).getByRole('alert').textContent).toMatch(
      /^The last backup failed \(14 Nov( 2026)?, 04:00\): ENOSPC: no space left on device$/,
    );
    // The previous one is still listed.
    expect(row(card, 'Last backup')).toMatch(/13 Nov( 2026)?, 04:00/);
  });

  it('says when automatic backups are off', async () => {
    mockApi({ '/api/v1/admin/backups': { body: backupDisabled } });
    renderApp('/settings/server');
    const card = await backupsCard();
    expect(row(card, 'Next backup')).toMatch(/Off \(BACKUP_ENABLED\)$/);
  });

  /** The External sources card, once loaded. */
  async function sourcesCard() {
    const heading = await screen.findByRole('heading', { name: 'External sources' });
    const card = heading.closest('section');
    if (!card) throw new Error('Expected the External sources card');
    await within(card).findAllByText('Last fetch');
    return card;
  }

  it('lists external sources as off by default, naming the setting', async () => {
    mockApi({ '/api/v1/admin/external-sources': { body: sourcesOff } });
    renderApp('/settings/server');
    const card = await sourcesCard();
    expect(row(card, 'OSRS Wiki Prices')).toMatch(/Off \(PRICES_ENABLED\)$/);
    expect(row(card, 'Last fetch')).toMatch(/None yet$/);
    expect(within(card).queryByText('Next fetch')).toBeNull();
    expect(within(card).queryByRole('alert')).toBeNull();
  });

  it('says when a source is on in .env but the contact is missing', async () => {
    mockApi({ '/api/v1/admin/external-sources': { body: sourcesNoContact } });
    renderApp('/settings/server');
    const card = await sourcesCard();
    expect(row(card, 'OSRS Wiki Prices')).toMatch(/Off \(USER_AGENT_CONTACT\)$/);
  });

  it('shows the last and the next fetch of a source that is on', async () => {
    mockApi({ '/api/v1/admin/external-sources': { body: sourcesOk } });
    renderApp('/settings/server');
    const card = await sourcesCard();
    expect(row(card, 'OSRS Wiki Prices')).toMatch(/On$/);
    expect(row(card, 'Last fetch')).toMatch(/8 Nov( 2026)?, 20:00$/);
    expect(row(card, 'Next fetch')).toMatch(/8 Nov( 2026)?, 21:00$/);
    expect(within(card).queryByRole('alert')).toBeNull();
  });

  it('shows the last error of a source', async () => {
    mockApi({ '/api/v1/admin/external-sources': { body: sourcesFailed } });
    renderApp('/settings/server');
    const card = await sourcesCard();
    expect(within(card).getByRole('alert').textContent).toMatch(
      /^The last fetch from OSRS Wiki Prices failed \(8 Nov( 2026)?, 21:00\): HTTP 503$/,
    );
    expect(row(card, 'Last fetch')).toMatch(/8 Nov( 2026)?, 20:00$/);
  });

  it('shows an error state when the external sources fail to load', async () => {
    mockApi({ '/api/v1/admin/external-sources': serverError });
    renderApp('/settings/server');
    const heading = await screen.findByRole('heading', { name: 'External sources' });
    const card = heading.closest('section');
    if (!card) throw new Error('Expected the External sources card');
    expect(await within(card).findByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows an error state when the backup status fails to load', async () => {
    mockApi({ '/api/v1/admin/backups': serverError });
    renderApp('/settings/server');
    const heading = await screen.findByRole('heading', { name: 'Backups' });
    const card = heading.closest('section');
    if (!card) throw new Error('Expected the Backups card');
    expect(await within(card).findByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('rebuilds after confirming, shows "Rebuilding…" and the result', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = mockApi({
      'POST /api/v1/admin/rebuild': () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    renderApp('/settings/server');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rebuild' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rebuild derived data?' });
    expect(callsTo(fetchMock, 'POST', '/admin/rebuild')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Rebuild' }));

    const pending = await screen.findByRole('button', { name: 'Rebuilding…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(callsTo(fetchMock, 'POST', '/admin/rebuild')).toHaveLength(1);

    answer(Response.json(rebuildOk));
    expect(await screen.findByText('Rebuilt 12,345 events in 0.8 s.')).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeTruthy();
  });

  it('keeps showing the rebuild after leaving the tab and coming back', async () => {
    let answer: (response: Response) => void = () => undefined;
    mockApi({
      'POST /api/v1/admin/rebuild': () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const { router } = renderApp('/settings/server');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rebuild' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rebuild' }),
    );
    await screen.findByRole('button', { name: 'Rebuilding…' });
    await router.navigate('/settings');
    await router.navigate('/settings/server');
    expect(await screen.findByRole('button', { name: 'Rebuilding…' })).toBeTruthy();
    answer(Response.json(rebuildOk));
    expect(await screen.findByText('Rebuilt 12,345 events in 0.8 s.')).toBeTruthy();
  });

  it('tells how many events failed', async () => {
    mockApi({ 'POST /api/v1/admin/rebuild': { body: rebuildWithFailures } });
    renderApp('/settings/server');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rebuild' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rebuild' }),
    );
    expect(await screen.findByText('Rebuilt 120 events in 0.1 s.')).toBeTruthy();
    expect(screen.getByText(/2 events failed\. Their raw data is kept/)).toBeTruthy();
  });

  it('says so when the rebuild fails', async () => {
    mockApi({ 'POST /api/v1/admin/rebuild': serverError });
    renderApp('/settings/server');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rebuild' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rebuild' }),
    );
    expect(await screen.findByText('The rebuild failed. Check the server log.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeTruthy();
  });

  it('says when the server could not be reached', async () => {
    mockApi({
      'POST /api/v1/admin/rebuild': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    renderApp('/settings/server');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rebuild' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rebuild' }),
    );
    expect(
      await screen.findByText("Couldn't reach the server. Start it and try again."),
    ).toBeTruthy();
  });
});
