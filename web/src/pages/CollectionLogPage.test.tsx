import type { CollectionLogResponse, CollectionLogStatusResponse } from '@fireside/shared';
import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import clogFailed from '../../../shared/fixtures/api/collection-log-response/valid/failed-with-old-data-and-unknown-item.json';
import clogSynced from '../../../shared/fixtures/api/collection-log-response/valid/synced.json';
import clogTurnedOff from '../../../shared/fixtures/api/collection-log-response/valid/turned-off-with-old-data.json';
import statusNeverSynced from '../../../shared/fixtures/api/collection-log-status-response/valid/never-synced.json';
import statusNoSource from '../../../shared/fixtures/api/collection-log-status-response/valid/no-source.json';
import clogStarted from '../../../shared/fixtures/api/collection-log-sync-response/valid/started.json';
import { CLOG_SYNC_POLL_MS } from '@/api/hooks';
import { LIVE_POLL_MS } from '@/api/query-client';
import { findMainNav, mockApi, renderApp, stubDesktop, type MockAnswer } from '@/test/render-app';

// The accounts fixture has 1 ("Test Main", ironman) and 2 ("Alt"). The synced
// fixture is account 1's collection log, 3 of 4 slots: Bosses → Abyssal Sire
// (Abyssal orphan, obtained 7 Nov; Jar of miasma, missing; Abyssal whip × 3,
// from before tracking) and Other → All Pets (Abyssal orphan again, and Pet
// snakeling with an approximate time on 7 Nov).

const LOG = clogSynced as CollectionLogResponse;

/** The status endpoint's answer for a collection log: the same without the tabs. */
function statusOf(log: CollectionLogResponse, accountId = log.accountId) {
  const status: CollectionLogStatusResponse & { tabs?: unknown } = { ...log, accountId };
  delete status.tabs;
  return status;
}

/** Answers for accounts with a collection log. Others keep the default: none. */
function withLogs(
  logs: Record<number, CollectionLogResponse>,
  answers: Record<string, MockAnswer> = {},
) {
  const byAccount: Record<string, MockAnswer> = {};
  for (const [id, log] of Object.entries(logs)) {
    const base = `/api/v1/accounts/${id}/collection-log`;
    byAccount[base] = { body: { ...log, accountId: Number(id) } };
    byAccount[`${base}/status`] = { body: statusOf(log, Number(id)) };
  }
  return mockApi({ ...byAccount, ...answers });
}

function calls(fetchMock: ReturnType<typeof mockApi>, path: string, method = 'GET'): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, 'http://localhost').pathname === path && (init?.method ?? 'GET') === method;
  }).length;
}

/** The interval at which the status of account 1 is read again (`false` = not at all). */
function statusPoll(queryClient: QueryClient): number | false {
  const query = queryClient.getQueryCache().find({ queryKey: ['collection-log-status', 1] });
  if (!query) throw new Error('No status query');
  const intervals = query.observers.map((observer) => {
    const { refetchInterval } = observer.options;
    const value = typeof refetchInterval === 'function' ? refetchInterval(query) : refetchInterval;
    return value ?? false;
  });
  return intervals.find((value) => value !== false) ?? false;
}

/**
 * The number over `label` in the row at the top. Both layouts are in the DOM
 * (CSS picks one), so a number with a mobile form reads as both, e.g. "1 of 21".
 */
async function stat(label: string): Promise<string> {
  // Waits for the numbers: the row is skeletons while the collection log loads.
  const text = await waitFor(() =>
    within(screen.getByRole('region', { name: 'Collection log summary' })).getByText(label),
  );
  return text.closest('div')?.firstElementChild?.textContent ?? '';
}

/** The game's tabs: links in the filter look, one per tab. */
const tabGroup = () => within(screen.getByRole('navigation', { name: 'Collection log tabs' }));

const slots = (grid: HTMLElement) =>
  [...grid.querySelectorAll('[data-slot-variant]')].map((slot) =>
    slot.getAttribute('data-slot-variant'),
  );

describe('Collection log', () => {
  beforeEach(() => {
    // Only Date is faked, so Testing Library's timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the three numbers', async () => {
    withLogs({ 1: LOG });
    renderApp('/1/collections/log');
    expect(await stat('of 4 slots')).toBe('3');
    expect(screen.getByRole('progressbar', { name: '3 of 4 slots' })).toBeTruthy();
    expect(screen.getByText('75.0% complete')).toBeTruthy();
    // Both dated items are from Saturday 7 November: this month, last week.
    expect(await stat('new this month · 0 this week')).toBe('2');
    // "1 of 2" on mobile, "1" over "of 2 pages completed" on PC.
    expect(await stat('of 2 pages completed')).toBe('1 of 21');
  });

  it('opens the first tab and page, with obtained and missing items in game order', async () => {
    withLogs({ 1: LOG });
    renderApp('/1/collections/log');
    const grid = await screen.findByRole('img', { name: 'Abyssal Sire: 2 of 3 obtained' });
    expect(slots(grid)).toEqual(['item', 'missing', 'item']);
    // Placeholder initials per icon, and the quantity on the slot when it is above 1.
    expect(grid.textContent).toBe('AbJaAb3');
    expect(screen.getByRole('heading', { level: 2, name: 'Abyssal Sire' })).toBeTruthy();
    expect(screen.getByText('Obtained 2 of 3')).toBeTruthy();
    expect(screen.getByText(/^Dimmed items are not obtained yet\./)).toBeTruthy();
    const tabs = tabGroup();
    // Links, so a tab opens in a new browser tab too.
    expect(tabs.getAllByRole('link').map((tab) => tab.textContent)).toEqual(['Bosses', 'Other']);
    expect(tabs.getByRole('link', { name: 'Bosses' }).getAttribute('aria-current')).toBe('page');
    expect(tabs.getByRole('link', { name: 'Other' }).getAttribute('aria-current')).toBeNull();
    expect(tabs.getByRole('link', { name: 'Other' }).getAttribute('href')).toBe(
      '/1/collections/log?tab=other',
    );
  });

  it.each([
    ['a missing item', '/1/collections/log', 1, 'Jar of miasmaNot obtained'],
    [
      'an item from before tracking',
      '/1/collections/log',
      2,
      'Abyssal whip × 3Obtained before tracking',
    ],
    ['an item with a known time', '/1/collections/log', 0, 'Abyssal orphanObtained Sat 7 Nov'],
    [
      'an item first seen by a sync',
      '/1/collections/log?tab=other',
      1,
      'Pet snakelingFirst seen ~Sat 7 Nov',
    ],
  ])('has a tooltip for %s', async (_name, path, index, text) => {
    withLogs({ 1: LOG });
    renderApp(path);
    const grid = await screen.findByRole('img', { name: /obtained$/ });
    const slot = grid.querySelectorAll('[data-slot-variant]')[index];
    if (!slot) throw new Error('Expected a slot');
    await userEvent.setup().hover(slot);
    expect((await screen.findByRole('tooltip')).textContent).toBe(text);
  });

  it('follows ?tab= and ?page=, and marks a completed page', async () => {
    withLogs({ 1: LOG });
    const { router } = renderApp('/1/collections/log?tab=other&page=all-pets');
    await screen.findByRole('img', { name: 'All Pets: 2 of 2 obtained' });
    const pages = within(screen.getByRole('navigation', { name: 'Other pages' }));
    const link = pages.getByRole('link', { name: /All Pets/ });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.textContent).toBe('All Pets2/2');
    expect(within(link).getByLabelText('Completed')).toBeTruthy();

    // A new tab goes in the history and opens its first page.
    await userEvent.setup().click(tabGroup().getByRole('link', { name: 'Bosses' }));
    await screen.findByRole('img', { name: 'Abyssal Sire: 2 of 3 obtained' });
    expect(router.state.location.search).toBe('?tab=bosses');
    expect(router.state.historyAction).toBe('PUSH');
  });

  it('falls back to the first tab and page for values it does not know', async () => {
    withLogs({ 1: LOG });
    renderApp('/1/collections/log?tab=nope&page=all-pets');
    expect(await screen.findByRole('img', { name: 'Abyssal Sire: 2 of 3 obtained' })).toBeTruthy();
  });

  describe('the page list', () => {
    // Bosses with three pages: Abyssal Sire (2/3) and two copies of it under other names.
    const [bosses, other] = LOG.tabs;
    const sire = bosses?.pages[0];
    if (!bosses || !other || !sire) throw new Error('Expected two tabs with a page');
    const MANY: CollectionLogResponse = {
      ...LOG,
      tabs: [
        {
          ...bosses,
          pages: [sire, { ...sire, name: 'Vorkath' }, { ...sire, name: 'Zulrah' }],
        },
        other,
      ],
    };
    const pageNames = (tab: string) =>
      within(screen.getByRole('navigation', { name: `${tab} pages` }))
        .queryAllByRole('link')
        .map((link) => link.textContent);

    it('filters the names with "Find a page", in the URL without a new history entry', async () => {
      withLogs({ 1: MANY });
      const { router } = renderApp('/1/collections/log');
      const field = await screen.findByRole('searchbox', { name: 'Find a page' });
      expect(pageNames('Bosses')).toEqual(['Abyssal Sire2/3', 'Vorkath2/3', 'Zulrah2/3']);

      const user = userEvent.setup();
      await user.type(field, 'vOR');
      await waitFor(() => {
        expect(pageNames('Bosses')).toEqual(['Vorkath2/3']);
      });
      expect(router.state.location.search).toBe('?find=vOR');
      expect(router.state.historyAction).toBe('REPLACE');
      // The chosen page stays on the right, though the list no longer has it.
      expect(screen.getByRole('heading', { level: 2, name: 'Abyssal Sire' })).toBeTruthy();

      // Picking a page keeps the filter; it goes in the history.
      await user.click(screen.getByRole('link', { name: /Vorkath/ }));
      await screen.findByRole('heading', { level: 2, name: 'Vorkath' });
      expect(router.state.location.search).toBe('?tab=bosses&page=vorkath&find=vOR');
      expect(router.state.historyAction).toBe('PUSH');
      expect(screen.getByRole('link', { name: /Vorkath/ }).getAttribute('aria-current')).toBe(
        'page',
      );
      expect((field as HTMLInputElement).value).toBe('vOR');

      // A new tab starts without it.
      await user.click(tabGroup().getByRole('link', { name: 'Other' }));
      await screen.findByRole('heading', { level: 2, name: 'All Pets' });
      expect(router.state.location.search).toBe('?tab=other');
      expect(pageNames('Other')).toEqual(['All Pets2/2']);
      expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Find a page' }).value).toBe(
        '',
      );
    });

    it('says so when no page matches, and reads the filter from the URL', async () => {
      withLogs({ 1: MANY });
      renderApp('/1/collections/log?find=kraken');
      const field = await screen.findByRole<HTMLInputElement>('searchbox', {
        name: 'Find a page',
      });
      expect(field.value).toBe('kraken');
      expect(pageNames('Bosses')).toEqual([]);
      expect(screen.getByText('No pages match “kraken”.')).toBeTruthy();

      await userEvent.setup().clear(field);
      await waitFor(() => {
        expect(pageNames('Bosses')).toHaveLength(3);
      });
    });

    it('has no "Hide completed" switch, only "Find a page"', async () => {
      withLogs({ 1: MANY });
      renderApp('/1/collections/log?tab=other');
      await screen.findByRole('searchbox', { name: 'Find a page' });
      expect(screen.queryByRole('switch')).toBeNull();
      // A completed page stays in the list.
      expect(pageNames('Other')).toEqual(['All Pets2/2']);
    });

    it('lets the page list and Recent items scroll with the page: nothing sticks', async () => {
      withLogs({ 1: MANY });
      renderApp('/1/collections/log');
      const list = await screen.findByRole('navigation', { name: 'Bosses pages' });
      const recent = await screen.findByRole('heading', { level: 2, name: 'Recent items' });
      for (const card of [list.closest('section'), recent.closest('section')]) {
        expect(card).not.toBeNull();
        expect(card?.closest('[class*="sticky"]')).toBeNull();
        expect(card?.style.top).toBe('');
      }
    });

    it('caps the page list card at 600 px, or the room under the top bar', async () => {
      const height = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1200);
      try {
        withLogs({ 1: MANY });
        renderApp('/1/collections/log');
        const list = await screen.findByRole('navigation', { name: 'Bosses pages' });
        const card = list.closest('section');
        if (!card) throw new Error('Expected the page list card');
        // A tall window: the cap, not the window.
        await waitFor(() => {
          expect(card.style.maxHeight).toBe('600px');
        });
        // A short window: the room under the top bar (no top bar here, so 500 − 20 − 20).
        height.mockReturnValue(500);
        act(() => {
          window.dispatchEvent(new Event('resize'));
        });
        await waitFor(() => {
          expect(card.style.maxHeight).toBe('460px');
        });
      } finally {
        height.mockRestore();
      }
    });

    it('scrolls the list to keep the chosen page in view', async () => {
      // A list 200 px high whose pages are 30 px each, laid out by name.
      const tops: Record<string, number> = { 'Abyssal Sire': 0, Vorkath: 300, Zulrah: 600 };
      const rect = vi
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: Element) {
          const name = Object.keys(tops).find((key) => this.textContent.startsWith(key));
          const list = this.closest('nav');
          const top =
            this.tagName === 'A' && name !== undefined && list
              ? 100 + (tops[name] ?? 0) - list.scrollTop
              : 100;
          return new DOMRect(0, top, 270, this.tagName === 'A' ? 30 : 200);
        });
      const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200);
      // Every size observer of the page, to say "the size changed" by hand.
      const original = window.ResizeObserver;
      const observers: (() => void)[] = [];
      window.ResizeObserver = class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(() => {
            callback([], this);
          });
        }
        observe = () => undefined;
        unobserve = () => undefined;
        disconnect = () => undefined;
      };
      const resize = () => {
        act(() => {
          for (const notify of observers) notify();
        });
      };
      try {
        withLogs({ 1: MANY });
        renderApp('/1/collections/log?page=zulrah');
        await screen.findByRole('heading', { level: 2, name: 'Zulrah' });
        const list = screen.getByRole('navigation', { name: 'Bosses pages' });
        // Zulrah's bottom (630) at the bottom of the 200 px list.
        expect(list.scrollTop).toBe(430);

        const user = userEvent.setup();
        // Still in view after a click on a page that is: nothing moves.
        list.scrollTop = 290;
        await user.click(screen.getByRole('link', { name: /Vorkath/ }));
        await screen.findByRole('heading', { level: 2, name: 'Vorkath' });
        expect(list.scrollTop).toBe(290);

        // Scrolled away to browse: a new height of the list leaves the place alone.
        list.scrollTop = 0;
        fireEvent.scroll(list);
        resize();
        expect(list.scrollTop).toBe(0);

        // In view (290–490), then the list gets too low to show it: brought back.
        list.scrollTop = 290;
        fireEvent.scroll(list);
        height.mockReturnValue(35);
        resize();
        expect(list.scrollTop).toBe(295);
      } finally {
        rect.mockRestore();
        height.mockRestore();
        window.ResizeObserver = original;
      }
    });

    it('lets the chosen page grow with its items: only the page list scrolls in a card', async () => {
      withLogs({ 1: MANY });
      renderApp('/1/collections/log');
      const heading = await screen.findByRole('heading', { level: 2, name: 'Abyssal Sire' });
      const card = heading.closest('section');
      expect(card?.className).not.toContain('overflow');
      expect(screen.getByRole('navigation', { name: 'Bosses pages' }).className).toContain(
        'overflow-y-auto',
      );
    });

    it('keeps pages whose names look alike, or have no letters, apart in the URL', async () => {
      const twins: CollectionLogResponse = {
        ...LOG,
        tabs: [
          {
            ...bosses,
            pages: [sire, { ...sire, name: 'abyssal sire!' }, { ...sire, name: '深淵' }],
          },
          { ...other, name: 'BOSSES' },
          { ...other, name: '他' },
        ],
      };
      withLogs({ 1: twins });
      const { router } = renderApp('/1/collections/log?page=abyssal-sire-2');
      await screen.findByRole('heading', { level: 2, name: 'abyssal sire!' });
      const links = () =>
        within(screen.getByRole('navigation', { name: 'Bosses pages' })).getAllByRole('link');
      expect(links().map((link) => link.getAttribute('href'))).toEqual([
        '/1/collections/log?tab=bosses&page=abyssal-sire',
        '/1/collections/log?tab=bosses&page=abyssal-sire-2',
        '/1/collections/log?tab=bosses&page=3',
      ]);
      expect(links().map((link) => link.getAttribute('aria-current'))).toEqual([
        null,
        'page',
        null,
      ]);

      const user = userEvent.setup();
      await user.click(screen.getByRole('link', { name: /深淵/ }));
      await screen.findByRole('heading', { level: 2, name: '深淵' });
      expect(router.state.location.search).toBe('?tab=bosses&page=3');
      expect(links().map((link) => link.getAttribute('aria-current'))).toEqual([
        null,
        null,
        'page',
      ]);

      // Tabs too: one that differs only in case, and one without ASCII letters.
      await user.click(tabGroup().getByRole('link', { name: 'BOSSES' }));
      await screen.findByRole('navigation', { name: 'BOSSES pages' });
      expect(router.state.location.search).toBe('?tab=bosses-2');
      await user.click(tabGroup().getByRole('link', { name: '他' }));
      await screen.findByRole('navigation', { name: '他 pages' });
      expect(router.state.location.search).toBe('?tab=3');
      expect(
        tabGroup()
          .getAllByRole('link')
          .map((tab) => tab.getAttribute('aria-current')),
      ).toEqual([null, null, 'page']);
    });

    it('goes back to the first page without the filter on a click on the chosen tab', async () => {
      withLogs({ 1: MANY });
      const { router } = renderApp('/1/collections/log?tab=bosses&page=zulrah&find=zul');
      await screen.findByRole('heading', { level: 2, name: 'Zulrah' });
      const bosses = tabGroup().getByRole('link', { name: 'Bosses' });
      expect(bosses.getAttribute('aria-current')).toBe('page');
      expect(bosses.getAttribute('href')).toBe('/1/collections/log?tab=bosses');
      await userEvent.setup().click(bosses);
      await screen.findByRole('heading', { level: 2, name: 'Abyssal Sire' });
      expect(router.state.location.search).toBe('?tab=bosses');
      expect(router.state.historyAction).toBe('PUSH');
      expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Find a page' }).value).toBe(
        '',
      );
    });
  });

  it('lists the newest items with their page, and explains "~"', async () => {
    withLogs({ 1: LOG });
    renderApp('/1/collections/log');
    const list = await screen.findByRole('list', { name: 'Recent items' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      'PePet snakelingAll Pets·~Sat 7 Nov',
      // Also on "All Pets", but listed once under its first page.
      'AbAbyssal orphanAbyssal Sire·Sat 7 Nov',
    ]);
    // Two this month: no "Show all".
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
    expect(within(list).getByRole('link', { name: 'All Pets' }).getAttribute('href')).toBe(
      '/1/collections/log?tab=other&page=all-pets',
    );
    expect(screen.getByText('~ is the sync that found it, not the drop')).toBeTruthy();
  });

  it('shows the sync state in the top bar and starts a sync with "Sync now"', async () => {
    let syncing = false;
    const fetchMock = withLogs(
      { 1: LOG },
      {
        '/api/v1/accounts/1/collection-log/status': () =>
          Response.json(syncing ? { ...statusOf(LOG), sync: clogStarted.sync } : statusOf(LOG)),
        'POST /api/v1/accounts/1/collection-log/sync': () => {
          syncing = true;
          return Response.json({ ...clogStarted, accountId: 1 }, { status: 202 });
        },
      },
    );
    renderApp('/1/collections/log');
    expect(await screen.findByText(/^Synced .* · RuneProfile$/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync now' }));
    const button = await screen.findByRole('button', { name: 'Syncing…' });
    expect(button).toHaveProperty('disabled', true);
    expect(calls(fetchMock, '/api/v1/accounts/1/collection-log/sync', 'POST')).toBe(1);
    // The collection log itself is still there, and was downloaded once.
    expect(screen.getByRole('img', { name: 'Abyssal Sire: 2 of 3 obtained' })).toBeTruthy();
    expect(calls(fetchMock, '/api/v1/accounts/1/collection-log')).toBe(1);
  });

  it('reads the collection log again once a sync has worked, never while it runs', async () => {
    let status: CollectionLogStatusResponse = {
      ...statusOf(LOG),
      sync: { ...clogStarted.sync, status: 'SYNCING' },
    };
    const fetchMock = withLogs(
      { 1: LOG },
      { '/api/v1/accounts/1/collection-log/status': () => Response.json(status) },
    );
    const { queryClient } = renderApp('/1/collections/log');
    await screen.findByRole('img', { name: 'Abyssal Sire: 2 of 3 obtained' });
    expect(calls(fetchMock, '/api/v1/accounts/1/collection-log')).toBe(1);

    // The sync is over, with a new collection log.
    status = {
      ...statusOf(LOG),
      updatedAt: '2026-11-11T11:59:00.000Z',
      sync: LOG.sync && {
        ...LOG.sync,
        lastSuccessAt: '2026-11-11T11:59:00.000Z',
        lastChangedAt: '2026-11-11T11:59:00.000Z',
      },
    };
    await queryClient.invalidateQueries({ queryKey: ['collection-log-status', 1] });
    await waitFor(() => {
      expect(calls(fetchMock, '/api/v1/accounts/1/collection-log')).toBe(2);
    });
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
  });

  it('backs off and drops "Syncing…" when the status cannot be read, until the server answers', async () => {
    const syncing: CollectionLogStatusResponse = {
      ...statusOf(LOG),
      sync: { ...clogStarted.sync, status: 'SYNCING' },
    };
    let down = false;
    withLogs(
      { 1: LOG },
      {
        '/api/v1/accounts/1/collection-log/status': () =>
          down ? Promise.reject(new TypeError('Failed to fetch')) : Response.json(syncing),
      },
    );
    const { queryClient } = renderApp('/1/collections/log');
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Syncing…' });
    expect(button.disabled).toBe(true);
    expect(statusPoll(queryClient)).toBe(CLOG_SYNC_POLL_MS);

    // The server goes away while the sync runs: the call is retried, then given up.
    down = true;
    void queryClient.invalidateQueries({ queryKey: ['collection-log-status', 1] });
    await waitFor(
      () => {
        expect(statusPoll(queryClient)).toBe(LIVE_POLL_MS);
      },
      { timeout: 8_000 },
    );
    // The usual banner says why; nothing claims a sync is running, and the stored log stays.
    expect(screen.getByText("Can't reach the server. Retrying…")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Syncing…' })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sync now' }).disabled).toBe(true);
    expect(screen.getByRole('img', { name: 'Abyssal Sire: 2 of 3 obtained' })).toBeTruthy();

    // It answers again: the sync is still running, and is followed closely again.
    down = false;
    await queryClient.refetchQueries({ queryKey: ['collection-log-status', 1] });
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeTruthy();
    expect(statusPoll(queryClient)).toBe(CLOG_SYNC_POLL_MS);
    await waitFor(() => {
      expect(screen.queryByText("Can't reach the server. Retrying…")).toBeNull();
    });
  }, 15_000);

  it('says what went wrong with a sync and keeps the stored collection log', async () => {
    // The fixture's latest sync could not reach RuneProfile; it has 3 of 5 slots from before.
    withLogs({ 1: clogFailed as CollectionLogResponse });
    renderApp('/1/collections/log');
    const message = await screen.findByText("Couldn't reach RuneProfile. It is tried again later.");
    expect(message.getAttribute('role')).toBe('status');
    expect(message.className).toContain('text-down');
    expect(await stat('of 5 slots')).toBe('3');
    expect(screen.getByRole('button', { name: 'Sync now' })).toHaveProperty('disabled', false);
  });

  it('says so when a sync could not be started', async () => {
    withLogs(
      { 1: LOG },
      {
        'POST /api/v1/accounts/1/collection-log/sync': {
          status: 429,
          body: { error: { code: 'RATE_LIMITED', message: 'Too soon', details: [] } },
        },
      },
    );
    renderApp('/1/collections/log');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText("Couldn't start a sync. Try again in a minute.")).toBeTruthy();
  });

  it('shows a stored collection log with the source off, without "Sync now"', async () => {
    withLogs({ 1: clogTurnedOff });
    renderApp('/1/collections/log');
    expect(await screen.findByText(/^Sync is off · updated /)).toBeTruthy();
    expect(await stat('of 4 slots')).toBe('3');
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('invites an account without a collection log to turn the source on', async () => {
    const fetchMock = withLogs({ 1: LOG });
    renderApp('/2/collections/log');
    expect(
      await screen.findByText(
        'Turn on collection log sync for this account in Settings and its collection log shows up here.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Open Settings → OSRS accounts' }).getAttribute('href'),
    ).toBe('/settings/accounts');
    // Nothing to download for it.
    expect(calls(fetchMock, '/api/v1/accounts/2/collection-log')).toBe(0);
  });

  it('tells an account that is turned on but not synced to press Sync now', async () => {
    withLogs(
      { 1: LOG },
      {
        '/api/v1/accounts/2/collection-log/status': {
          body: { ...statusNeverSynced, accountId: 2 },
        },
      },
    );
    renderApp('/2/collections/log');
    expect(
      await screen.findByText('Not synced yet. Press Sync now to fetch Alt’s collection log.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync now' })).toHaveProperty('disabled', false);
  });

  it('shows one card per account with a collection log for all accounts', async () => {
    const fetchMock = withLogs({ 1: LOG });
    renderApp('/all/collections/log');
    const list = await screen.findByRole('list', { name: 'Collection log per account' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(1);
    const [card] = cards as [HTMLElement];
    expect(card.textContent).toMatch(/^Test MainIronman3 of 4slots.+updated→$/);
    expect(within(card).getByRole('link').getAttribute('href')).toBe('/1/collections/log');
    expect(within(card).getByRole('progressbar', { name: '3 of 4 slots' })).toBeTruthy();
    expect(
      screen.getByText(
        'A collection log belongs to one account. Pick an account to see its pages.',
      ),
    ).toBeTruthy();
    // Only the small status per account: no collection log is downloaded, no top bar controls.
    expect(calls(fetchMock, '/api/v1/accounts/1/collection-log')).toBe(0);
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('has a menu item only when an account has a collection log', async () => {
    withLogs({ 2: { ...LOG, accountId: 2 } });
    renderApp('/1');
    const nav = await findMainNav();
    const menu = await within(nav).findByRole('link', { name: 'Collections' });
    expect(menu.getAttribute('href')).toBe('/1/collections/log');
  });

  it('is not found, with no menu item, when no account has a collection log', async () => {
    mockApi({
      '/api/v1/accounts/1/collection-log/status': { body: { ...statusNoSource, accountId: 1 } },
    });
    renderApp('/all/collections/log');
    expect(await screen.findByText("This page doesn't exist.")).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Collections' })).toBeNull();
  });

  it('offers Retry when the status cannot be loaded', async () => {
    let fail = true;
    withLogs(
      { 1: LOG },
      {
        '/api/v1/accounts/1/collection-log/status': () =>
          fail
            ? new Response(
                JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'x', details: [] } }),
                { status: 500, headers: { 'content-type': 'application/json' } },
              )
            : Response.json(statusOf(LOG)),
      },
    );
    renderApp('/1/collections/log');
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    await userEvent.setup().click(retry);
    expect(await stat('of 4 slots')).toBe('3');
  });

  it('has "Sync now" in the top bar on PC and last on the page on mobile', async () => {
    stubDesktop();
    withLogs({ 1: LOG });
    renderApp('/1/collections/log');
    const button = await screen.findByRole('button', { name: 'Sync now' });
    // On PC it sits next to the sync text in the top bar, before the numbers.
    const region = screen.getByRole('region', { name: 'Collection log summary' });
    expect(button.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Sync now' })).toHaveLength(1);
  });

  it('shows six recent items, and every item of the month behind "Show all N this month"', async () => {
    // Nine items on the first page, one a day from 1 November.
    const [bosses, other] = LOG.tabs;
    const sire = bosses?.pages[0];
    if (!bosses || !other || !sire) throw new Error('Expected two tabs with a page');
    const items = Array.from({ length: 9 }, (_, index) => ({
      itemId: 9000 + index,
      name: `Item ${String(index + 1)}`,
      obtained: true,
      quantity: 1,
      firstSeenAt: `2026-11-0${String(index + 1)}T12:00:00.000Z`,
      approximate: false,
    }));
    // With the two items on "All Pets" (both 7 November): 11 unique, all obtained.
    const many: CollectionLogResponse = {
      ...LOG,
      obtained: 11,
      total: 11,
      tabs: [{ ...bosses, pages: [{ ...sire, items, obtained: 9, total: 9 }] }, other],
    };
    withLogs({ 1: many });
    renderApp('/1/collections/log');
    const list = await screen.findByRole('list', { name: 'Recent items' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    // The newest first.
    expect(within(list).getAllByRole('listitem')[0]?.textContent).toContain('Item 9');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show all 11 this month' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(11);
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  });
});
