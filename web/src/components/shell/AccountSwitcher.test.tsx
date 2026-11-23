import type { AccountsResponse } from '@fireside/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_POLL_MS } from '@/api/query-client';
import { mockApi, renderApp } from '@/test/render-app';
import { json } from '@/test/sessions';

// "Online" in the account switcher follows the newest session, and the
// accounts list is polled only while an account shows as online.

const NOW = '2026-11-11T12:00:00.000Z';

/** Account 1 playing (open session, heartbeat 30 s ago); account 2 logged out yesterday. */
function accounts(latest: AccountsResponse['accounts'][number]['latestSession']): AccountsResponse {
  return {
    accounts: [
      {
        id: 1,
        displayName: 'Test Main',
        accountType: 'IRONMAN',
        firstSeenAt: '2026-11-01T18:00:00.000Z',
        lastSeenAt: '2026-11-11T11:59:30.000Z',
        totalLevel: 1850,
        totalXp: 123456789,
        latestSession: latest,
      },
      {
        id: 2,
        displayName: 'Alt',
        accountType: 'NORMAL',
        firstSeenAt: '2026-11-01T18:00:00.000Z',
        lastSeenAt: '2026-11-10T12:00:00.000Z',
        totalLevel: null,
        totalXp: null,
        latestSession: { endedAt: '2026-11-10T12:00:00.000Z', endReason: 'logout' },
      },
    ],
  };
}

const OPEN = { endedAt: null, endReason: null };

/** How many times `GET /accounts` was asked for. */
function accountRequests(fetchMock: ReturnType<typeof mockApi>): number {
  return fetchMock.mock.calls.filter(([input]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, 'http://localhost').pathname === '/api/v1/accounts';
  }).length;
}

/** Lets the polling interval (and `useNow`) run for `ms`. */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  // Date and intervals only: Testing Library's own timeouts keep working.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AccountSwitcher online state', () => {
  it('shows offline within one poll after a logout, then stops polling', async () => {
    let latest: AccountsResponse['accounts'][number]['latestSession'] = OPEN;
    const fetchMock = mockApi({
      '/api/v1/accounts': () => json(accounts(latest)),
      '/api/v1/accounts/1/sessions': () => json({ items: [], nextCursor: null }),
    });
    // A page that shows no online state of its own: only the switcher polls.
    renderApp('/1/activity/sessions');
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    await user.click(await screen.findByRole('button', { name: /^Choose account/ }));
    const main = await screen.findByRole('menuitem', { name: /Test Main/ });
    expect(within(main).getByText('Online')).toBeTruthy();
    const alt = screen.getByRole('menuitem', { name: /Alt/ });
    expect(within(alt).queryByText('Online')).toBeNull();

    // Logged out 10 s from now, well inside the 3-minute heartbeat window.
    latest = { endedAt: '2026-11-11T12:00:10.000Z', endReason: 'logout' };
    const before = accountRequests(fetchMock);
    await pass(LIVE_POLL_MS);
    await waitFor(() => {
      expect(accountRequests(fetchMock)).toBe(before + 1);
    });
    await waitFor(() => {
      expect(
        within(screen.getByRole('menuitem', { name: /Test Main/ })).queryByText('Online'),
      ).toBeNull();
    });

    // Nobody is online any more: no further requests.
    const after = accountRequests(fetchMock);
    await pass(LIVE_POLL_MS * 4);
    expect(accountRequests(fetchMock)).toBe(after);
  });

  it('stays online across a world hop, and with a killed client until the window passes', async () => {
    let latest: AccountsResponse['accounts'][number]['latestSession'] = {
      endedAt: '2026-11-11T11:59:50.000Z',
      endReason: 'hop',
    };
    mockApi({
      '/api/v1/accounts': () => json(accounts(latest)),
      '/api/v1/accounts/1/sessions': () => json({ items: [], nextCursor: null }),
    });
    renderApp('/1/activity/sessions');
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(await screen.findByRole('button', { name: /^Choose account/ }));
    const main = await screen.findByRole('menuitem', { name: /Test Main/ });
    expect(within(main).getByText('Online')).toBeTruthy();

    // The next part starts, then the client is killed: the session stays open,
    // and no heartbeat comes after 11:59:30.
    latest = OPEN;
    await pass(LIVE_POLL_MS);
    expect(
      within(screen.getByRole('menuitem', { name: /Test Main/ })).getByText('Online'),
    ).toBeTruthy();
    // 3 minutes after the last heartbeat it is offline.
    await pass(LIVE_POLL_MS * 5);
    await waitFor(() => {
      expect(
        within(screen.getByRole('menuitem', { name: /Test Main/ })).queryByText('Online'),
      ).toBeNull();
    });
  });
});
