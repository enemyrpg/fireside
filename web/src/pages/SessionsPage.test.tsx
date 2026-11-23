import type { QueryClient } from '@tanstack/react-query';
import type { SessionDetailResponse, SessionsResponse } from '@fireside/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_POLL_MS } from '@/api/query-client';
import {
  mockApi,
  renderApp,
  stubDesktop,
  stubResizableLayout,
  type MockAnswer,
} from '@/test/render-app';
import { EMPTY_SUMMARY, json, makeDetail, makeSession as session } from '@/test/sessions';
import { SESSION_NOT_FOUND } from './SessionPage';
import { SESSIONS_EMPTY } from './SessionsPage';

// Health says Europe/Oslo (UTC+1 in November). Accounts 1 ("Test Main") and 2 ("Alt").

// Sun 8 Nov: a hop (19:00–19:30 local) and the next part 20 s later (until 20:10).
const HOP = session(1, '2026-11-08T18:00:00.000Z', '2026-11-08T18:30:00.000Z', {
  endReason: 'hop',
});
const AFTER_HOP = session(2, '2026-11-08T18:30:20.000Z', '2026-11-08T19:10:00.000Z', {
  world: 330,
});
// Sat 7 Nov, account 2, still open, no world yet.
const OPEN = session(3, '2026-11-07T10:00:00.000Z', '2026-11-07T10:05:00.000Z', {
  accountId: 2,
  endedAt: null,
  endReason: null,
  world: null,
  durationSeconds: 300,
  activeSeconds: 300,
  summary: null,
});
// On the second page: Sun 1 Nov.
const OLD = session(4, '2026-11-01T12:00:00.000Z', '2026-11-01T13:00:00.000Z');

// Neighbours per account, in list order.
const DETAILS: Record<string, SessionDetailResponse> = {
  [OLD.id]: makeDetail(OLD, { newerId: HOP.id }),
  [HOP.id]: makeDetail(HOP, { olderId: OLD.id, newerId: AFTER_HOP.id }),
  [AFTER_HOP.id]: makeDetail(AFTER_HOP, { olderId: HOP.id }),
  [OPEN.id]: makeDetail(OPEN),
};

/** URLs the app fetched. */
function fetchedUrls(fetchMock: ReturnType<typeof mockApi>): URL[] {
  return fetchMock.mock.calls.map(([input]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, 'http://localhost');
  });
}

const sessionsAnswer: MockAnswer = (url) => {
  const cursor = new URL(url, 'http://localhost').searchParams.get('cursor');
  const page: SessionsResponse = cursor
    ? { items: [OLD], nextCursor: null }
    : { items: [AFTER_HOP, HOP, OPEN], nextCursor: 'next' };
  return json(page);
};

/** Every session detail by ID; anything else is a 404. */
const detailAnswers = (details: Record<string, SessionDetailResponse> = DETAILS) =>
  Object.fromEntries(
    Object.entries(details).map(([key, body]) => [`/api/v1/sessions/${key}`, { body }]),
  );

/** The selected session on PC. */
const pane = (name: RegExp | string) => screen.findByRole('region', { name });

const search = (router: { state: { location: { search: string } } }) =>
  router.state.location.search;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Sessions page', () => {
  it('groups by local day with totals and merges a quick world hop', async () => {
    const fetchMock = mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer });
    renderApp('/all/activity/sessions');

    const sunday = await screen.findByRole('region', { name: 'Sun 8 Nov' });
    // One row for both parts: 30 + 39 min 40 s.
    expect(within(sunday).getByText(/1 h 9 min · 1 session/)).toBeTruthy();
    const link = within(sunday).getByRole('link', { name: /Test Main, Sun 8 Nov 19:00–20:10/ });
    // A hop group opens its first part, so Newer follows the play order.
    expect(link.getAttribute('href')).toBe(`/sessions/${HOP.id}`);
    expect(within(sunday).getByText('Worlds 302 → 330')).toBeTruthy();
    expect(within(sunday).getByText('24K XP')).toBeTruthy();
    expect(within(sunday).getByText(/Vorkath/).textContent).toBe('Vorkath +8');

    // The open session: Live, "now", no world and no XP yet.
    const saturday = screen.getByRole('region', { name: 'Sat 7 Nov' });
    expect(within(saturday).getByText('Live')).toBeTruthy();
    expect(within(saturday).getByText('11:00–now')).toBeTruthy();
    expect(within(saturday).getByText('World unknown')).toBeTruthy();

    // 20 per page, as the design says.
    const url = fetchedUrls(fetchMock).find((u) => u.pathname === '/api/v1/accounts/all/sessions');
    expect(url?.searchParams.get('limit')).toBe('20');
  });

  it('unfolds the parts of a hop group', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer });
    renderApp('/all/activity/sessions');
    const toggle = await screen.findByRole('button', { name: 'Show 2 parts (world hops)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    const parts = screen.getByRole('list', { name: 'Parts' });
    expect(
      within(parts)
        .getAllByRole('link')
        .map((link) => [link.getAttribute('href'), link.textContent]),
    ).toEqual([
      [`/sessions/${HOP.id}`, '19:00–19:30World 30230 min'],
      [`/sessions/${AFTER_HOP.id}`, '19:30–20:10World 33039 min'],
    ]);
    expect(
      screen
        .getByRole('button', { name: 'Hide 2 parts (world hops)' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('folds short sessions without XP, kills or loot into one row that unfolds', async () => {
    const a = session(11, '2026-11-08T09:00:00.000Z', '2026-11-08T09:03:00.000Z', {
      summary: EMPTY_SUMMARY,
    });
    const b = session(12, '2026-11-08T09:10:00.000Z', '2026-11-08T09:12:00.000Z', {
      accountId: 2,
      summary: EMPTY_SUMMARY,
    });
    const c = session(13, '2026-11-08T09:20:00.000Z', '2026-11-08T09:25:00.000Z', {
      summary: EMPTY_SUMMARY,
    });
    mockApi({
      '/api/v1/accounts/all/sessions': { body: { items: [c, b, a], nextCursor: null } },
    });
    renderApp('/all/activity/sessions');

    // One accessible text with the accounts in the run (the dots are only colour).
    const toggle = await screen.findByRole('button', {
      name: '3 short sessions · Test Main, Alt · 10:00–10:25',
    });
    expect(toggle.textContent).toContain('10:00–10:25');
    expect(toggle.textContent).toContain('10 min');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The day still counts every row.
    expect(screen.getByText(/10 min · 3 sessions/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Test Main/ })).toBeNull();

    await userEvent.click(toggle);
    const rows = screen.getByRole('list', { name: '3 short sessions' });
    expect(
      within(rows)
        .getAllByRole('link')
        .map((link) => link.getAttribute('aria-label')),
    ).toEqual([
      'Test Main, Sun 8 Nov 10:20–10:25',
      'Alt, Sun 8 Nov 10:10–10:12',
      'Test Main, Sun 8 Nov 10:00–10:03',
    ]);
  });

  it('does not fold a short session with a new collection log item, and badges it', async () => {
    const a = session(11, '2026-11-08T09:00:00.000Z', '2026-11-08T09:03:00.000Z', {
      summary: EMPTY_SUMMARY,
    });
    const b = session(12, '2026-11-08T09:10:00.000Z', '2026-11-08T09:12:00.000Z', {
      summary: EMPTY_SUMMARY,
      newCollectionLogCount: 1,
    });
    const c = session(13, '2026-11-08T09:20:00.000Z', '2026-11-08T09:25:00.000Z', {
      summary: EMPTY_SUMMARY,
    });
    const busy = session(14, '2026-11-08T11:00:00.000Z', '2026-11-08T12:00:00.000Z', {
      newCollectionLogCount: 14,
    });
    mockApi({
      '/api/v1/accounts/all/sessions': { body: { items: [busy, c, b, a], nextCursor: null } },
    });
    renderApp('/all/activity/sessions');
    await screen.findByRole('link', { name: /Test Main, Sun 8 Nov 12:00/ });
    // b splits a and c: no run of two short rows is left.
    expect(screen.queryByRole('button', { name: /short sessions/ })).toBeNull();
    const badges = screen.getAllByTestId('new-clog-badge');
    expect(badges.map((badge) => badge.textContent)).toEqual([
      '14 new collection logs',
      '1 new collection log',
    ]);
  });

  it('loads the next page with the cursor', async () => {
    const fetchMock = mockApi({ '/api/v1/accounts/1/sessions': sessionsAnswer });
    renderApp('/1/activity/sessions');
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('region', { name: 'Sun 1 Nov' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const cursors = fetchedUrls(fetchMock)
      .filter((url) => url.pathname === '/api/v1/accounts/1/sessions')
      .map((url) => url.searchParams.get('cursor'));
    expect(cursors).toEqual([null, 'next']);
  });

  it("does not show the previous account's rows while another account loads", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi({
      '/api/v1/accounts/1/sessions': sessionsAnswer,
      '/api/v1/accounts/2/sessions': async () => {
        await held;
        return json({ items: [], nextCursor: null });
      },
    });
    const { router } = renderApp('/1/activity/sessions');
    expect(await screen.findByRole('region', { name: 'Sun 8 Nov' })).toBeTruthy();
    await act(() => router.navigate('/2/activity/sessions'));
    expect(screen.queryByRole('region', { name: 'Sun 8 Nov' })).toBeNull();
    release();
    expect(await screen.findByText(SESSIONS_EMPTY)).toBeTruthy();
  });

  it('invites to play when there are no sessions', async () => {
    mockApi({ '/api/v1/accounts/2/sessions': { body: { items: [], nextCursor: null } } });
    renderApp('/2/activity/sessions');
    expect(await screen.findByText(SESSIONS_EMPTY)).toBeTruthy();
  });

  it('shows a retry when the list fails', async () => {
    mockApi({
      '/api/v1/accounts/all/sessions': {
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Boom', details: [] } },
      },
    });
    renderApp('/all/activity/sessions');
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('stays on the list for an empty ?session= on mobile', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    const { router } = renderApp('/all/activity/sessions?session=');
    expect(await screen.findByRole('region', { name: 'Sun 8 Nov' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/all/activity/sessions');
  });

  it('opens the screen for a selected session on mobile (replace)', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    const { router } = renderApp(`/all/activity/sessions?session=${HOP.id}`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sessions/${HOP.id}`);
    });
    expect(router.state.historyAction).toBe('REPLACE');
  });
});

describe('Sessions page on PC: list and selected session', () => {
  beforeEach(() => {
    stubDesktop();
  });

  it('shows the open session without a selection, and leaves the URL alone', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    const { router } = renderApp('/all/activity/sessions');
    const region = await pane('Sat 7 Nov · 11:00–now');
    expect(within(region).getByText('Live')).toBeTruthy();
    expect(search(router)).toBe('');
    // Its row is marked.
    const row = screen.getByRole('link', { name: /Alt, Sat 7 Nov/ });
    expect(row.getAttribute('aria-current')).toBe('true');
    // Rows select a session in the list.
    expect(screen.getByRole('link', { name: /Test Main, Sun 8 Nov/ }).getAttribute('href')).toBe(
      `/all/activity/sessions?session=${HOP.id}`,
    );
  });

  it('shows the fifth number and the Collection log section in the pane', async () => {
    const withClog = { ...AFTER_HOP, newCollectionLogCount: 1 };
    const detail = makeDetail(
      withClog,
      { olderId: HOP.id },
      {
        collectionLog: {
          obtained: 341,
          total: 1734,
          items: [
            {
              itemId: 34719,
              name: 'Rondache',
              tab: 'Raids',
              page: 'The Fractured Archive',
              pageObtained: 2,
              pageTotal: 9,
              at: '2026-11-08T18:59:58.802Z',
              approximate: false,
            },
          ],
        },
      },
    );
    mockApi({
      '/api/v1/accounts/1/sessions': { body: { items: [withClog, HOP], nextCursor: null } },
      ...detailAnswers({ ...DETAILS, [AFTER_HOP.id]: detail }),
    });
    renderApp('/1/activity/sessions');
    const region = within(await pane('Sun 8 Nov · 19:30–20:10'));
    const numbers = within(region.getByRole('region', { name: 'Session summary' }));
    expect(numbers.getByText('new collection log')).toBeTruthy();
    const clog = within(region.getByRole('region', { name: 'Collection log' }));
    expect(clog.getByText('The Fractured Archive · 2 of 9 on this page')).toBeTruthy();
    expect(clog.getByText('19:59')).toBeTruthy();
    expect(region.getByText('New collection log')).toBeTruthy();
    // The list row has the badge.
    expect(screen.getByTestId('new-clog-badge').textContent).toBe('1 new collection log');
  });

  it('treats an empty ?session= as no selection', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    renderApp('/all/activity/sessions?session=');
    // The open session, as without the parameter, not "Not found".
    expect(await pane('Sat 7 Nov · 11:00–now')).toBeTruthy();
    expect(screen.queryByText(SESSION_NOT_FOUND)).toBeNull();
  });

  it('shows the newest session when none is open', async () => {
    mockApi({
      '/api/v1/accounts/1/sessions': { body: { items: [AFTER_HOP, HOP], nextCursor: null } },
      ...detailAnswers(),
    });
    renderApp('/1/activity/sessions');
    // The newest session is the second part of the hop chain.
    expect(await pane('Sun 8 Nov · 19:30–20:10')).toBeTruthy();
  });

  it('selects a row in the URL, keeps focus on it, and Back returns to the previous one', async () => {
    const user = userEvent.setup();
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    const { router } = renderApp('/all/activity/sessions');
    await pane('Sat 7 Nov · 11:00–now');

    const row = screen.getByRole('link', { name: /Test Main, Sun 8 Nov/ });
    await user.click(row);
    expect(search(router)).toBe(`?session=${HOP.id}`);
    expect(router.state.historyAction).toBe('PUSH');
    expect(await pane('Sun 8 Nov · 19:00–19:30')).toBeTruthy();
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-current')).toBe('true');

    await act(() => router.navigate(-1));
    expect(search(router)).toBe('');
    expect(await pane('Sat 7 Nov · 11:00–now')).toBeTruthy();
  });

  it('moves with Older/Newer in the URL, and keeps the hop row selected for every part', async () => {
    const user = userEvent.setup();
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    const { router } = renderApp(`/all/activity/sessions?session=${HOP.id}`);
    const region = await pane('Sun 8 Nov · 19:00–19:30');
    const row = screen.getByRole('link', { name: /Test Main, Sun 8 Nov/ });
    expect(row.getAttribute('aria-current')).toBe('true');

    const newer = within(region).getByRole('link', { name: 'Newer →' });
    expect(newer.getAttribute('href')).toBe(`/all/activity/sessions?session=${AFTER_HOP.id}`);
    await user.click(newer);
    expect(search(router)).toBe(`?session=${AFTER_HOP.id}`);
    expect(await pane('Sun 8 Nov · 19:30–20:10')).toBeTruthy();
    // Still the same row: the group holds both parts.
    expect(row.getAttribute('aria-current')).toBe('true');
  });

  it('shows the hop chain from the list: part, links and the current part', async () => {
    const user = userEvent.setup();
    // The whole list (no more pages), so the chain is surely complete.
    const fetchMock = mockApi({
      '/api/v1/accounts/all/sessions': {
        body: { items: [AFTER_HOP, HOP, OPEN, OLD], nextCursor: null },
      },
      ...detailAnswers(),
    });
    const { router } = renderApp(`/all/activity/sessions?session=${HOP.id}`);
    const region = await pane('Sun 8 Nov · 19:00–19:30');
    const bar = within(region).getByRole('navigation', { name: 'World hops' });
    expect(bar.textContent).toContain('Part 1 of 2');
    const links = within(bar).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      '19:00–19:30·World 302·30 min',
      '19:30–20:10·World 330·39 min',
    ]);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    expect(links[1]?.getAttribute('aria-current')).toBeNull();
    // From the list: the walk fetched nothing.
    const fetched = fetchedUrls(fetchMock).map((url) => url.pathname);
    expect(fetched).not.toContain(`/api/v1/sessions/${OLD.id}`);

    const second = links[1];
    if (!second) throw new Error('expected a second part');
    await user.click(second);
    expect(search(router)).toBe(`?session=${AFTER_HOP.id}`);
    const next = await pane('Sun 8 Nov · 19:30–20:10');
    expect(within(next).getByRole('navigation', { name: 'World hops' }).textContent).toContain(
      'Part 2 of 2',
    );
  });

  it('finds a hop made after the list loaded (the list still has the session as live)', async () => {
    // The list loaded while S was live; the polled detail has its hop to S2.
    const live = session(40, '2026-11-09T18:00:00.000Z', '2026-11-09T18:30:00.000Z', {
      endedAt: null,
      endReason: null,
      summary: null,
    });
    const hopped = { ...live, endedAt: '2026-11-09T18:30:00.000Z', endReason: 'hop' as const };
    const next = session(41, '2026-11-09T18:30:20.000Z', '2026-11-09T18:40:00.000Z', {
      endedAt: null,
      endReason: null,
      summary: null,
      world: 330,
    });
    mockApi({
      '/api/v1/accounts/1/sessions': { body: { items: [live], nextCursor: null } },
      ...detailAnswers({
        [live.id]: makeDetail(hopped, { newerId: next.id }),
        [next.id]: makeDetail(next, { olderId: live.id }),
      }),
    });
    renderApp(`/1/activity/sessions?session=${live.id}`);
    const region = await pane('Mon 9 Nov · 19:00–19:30');
    const bar = await within(region).findByRole('navigation', { name: 'World hops' });
    expect(bar.textContent).toContain('Part 1 of 2');
    expect(
      within(bar)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['19:00–19:30·World 302·30 min', '19:30–now·World 330·9 min']);
  });

  it('walks the neighbours when an older part may be on the next page', async () => {
    const fetchMock = mockApi({
      '/api/v1/accounts/all/sessions': sessionsAnswer,
      ...detailAnswers(),
    });
    renderApp(`/all/activity/sessions?session=${HOP.id}`);
    const region = await pane('Sun 8 Nov · 19:00–19:30');
    // The first part is the account's oldest loaded session: OLD is fetched to know.
    const bar = await within(region).findByRole('navigation', { name: 'World hops' });
    expect(bar.textContent).toContain('Part 1 of 2');
    expect(fetchedUrls(fetchMock).map((url) => url.pathname)).toContain(
      `/api/v1/sessions/${OLD.id}`,
    );
  });

  it('has no hop chain bar for a single session', async () => {
    mockApi({
      '/api/v1/accounts/1/sessions': { body: { items: [OLD], nextCursor: null } },
      ...detailAnswers(),
    });
    renderApp(`/1/activity/sessions?session=${OLD.id}`);
    const region = await pane('Sun 1 Nov · 13:00–14:00');
    expect(within(region).queryByRole('navigation', { name: 'World hops' })).toBeNull();
  });

  it('shows a selected session that is not in the loaded list', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    renderApp(`/all/activity/sessions?session=${OLD.id}`);
    expect(await pane('Sun 1 Nov · 13:00–14:00')).toBeTruthy();
    // The list is as it was, without the old session.
    expect(screen.queryByRole('region', { name: 'Sun 1 Nov' })).toBeNull();
  });

  it('says Not found in the pane for an unknown or malformed ID, and keeps the list', async () => {
    mockApi({
      '/api/v1/accounts/all/sessions': sessionsAnswer,
      '/api/v1/sessions/nope': {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'x',
            details: [{ path: 'params.sessionId', message: 'Invalid' }],
          },
        },
      },
    });
    const { router } = renderApp(
      '/all/activity/sessions?session=01933c40-1111-7aaa-bbbb-999999999999',
    );
    const region = await pane('Selected session');
    expect(await within(region).findByText(SESSION_NOT_FOUND)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Sun 8 Nov' })).toBeTruthy();

    await act(() => router.navigate('/all/activity/sessions?session=nope'));
    expect(await within(await pane('Selected session')).findByText(SESSION_NOT_FOUND)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Sun 8 Nov' })).toBeTruthy();
  });

  it('polls the open session in the pane every 30 s, not in the background', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    const { queryClient } = renderApp('/all/activity/sessions');
    await pane('Sat 7 Nov · 11:00–now');
    const { query, options } = pollingOf(queryClient, OPEN.id);
    expect(options.refetchInterval(query)).toBe(LIVE_POLL_MS);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  it('polls the list while a session is live, also between the parts of a hop', async () => {
    // Only a hop that ended a minute ago: the next part has not arrived yet.
    const hop = session(21, '2026-11-10T11:00:00.000Z', '2026-11-10T11:59:00.000Z', {
      endReason: 'hop',
    });
    const answer = { items: [hop, OLD], nextCursor: null };
    mockApi({ '/api/v1/accounts/all/sessions': () => json(answer) });
    const { queryClient } = renderApp('/all/activity/sessions');
    await screen.findByRole('region', { name: 'Tue 10 Nov' });
    expect(listInterval(queryClient)).toBe(LIVE_POLL_MS);
    // 2 minutes after the hop without a next part: it stops.
    vi.setSystemTime(new Date('2026-11-10T12:01:00.000Z'));
    expect(listInterval(queryClient)).toBe(false);
  });

  it('polls the list while a session is open, and not without one', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    const { queryClient } = renderApp('/all/activity/sessions');
    await screen.findByRole('region', { name: 'Sat 7 Nov' });
    expect(listInterval(queryClient)).toBe(LIVE_POLL_MS);
  });

  it('does not poll a list with only ended sessions', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': () => json({ items: [OLD], nextCursor: null }) });
    const { queryClient } = renderApp('/all/activity/sessions');
    await screen.findByRole('region', { name: 'Sun 1 Nov' });
    expect(listInterval(queryClient)).toBe(false);
  });

  it('unfolds a short run that holds the selected session', async () => {
    const a = session(11, '2026-11-08T09:00:00.000Z', '2026-11-08T09:03:00.000Z', {
      summary: EMPTY_SUMMARY,
    });
    const b = session(12, '2026-11-08T09:10:00.000Z', '2026-11-08T09:12:00.000Z', {
      summary: EMPTY_SUMMARY,
    });
    mockApi({
      '/api/v1/accounts/1/sessions': { body: { items: [b, a], nextCursor: null } },
      ...detailAnswers({
        [a.id]: makeDetail(a, { newerId: b.id }),
        [b.id]: makeDetail(b, { olderId: a.id }),
      }),
    });
    renderApp(`/1/activity/sessions?session=${a.id}`);
    expect(await pane('Sun 8 Nov · 10:00–10:03')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: /2 short sessions/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen
        .getByRole('link', { name: 'Test Main, Sun 8 Nov 10:00–10:03' })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('opens the screen when the window gets narrow, and selects it again when wide', async () => {
    vi.unstubAllGlobals();
    const layout = stubResizableLayout(true);
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    const { router } = renderApp(`/all/activity/sessions?session=${HOP.id}`);
    await pane('Sun 8 Nov · 19:00–19:30');

    act(() => {
      layout.setDesktop(false);
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sessions/${HOP.id}`);
    });
    act(() => {
      layout.setDesktop(true);
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all/activity/sessions');
    });
    expect(search(router)).toBe(`?session=${HOP.id}`);
  });

  it('keeps the list (no screen) when narrowing without a selection in the URL', async () => {
    vi.unstubAllGlobals();
    const layout = stubResizableLayout(true);
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    const { router } = renderApp('/all/activity/sessions');
    await pane('Sat 7 Nov · 11:00–now');
    act(() => {
      layout.setDesktop(false);
    });
    expect(router.state.location.pathname).toBe('/all/activity/sessions');
    expect(screen.queryByRole('region', { name: /Sat 7 Nov · / })).toBeNull();
  });
});

describe('Sessions page on PC: the pane sticks only while it fits', () => {
  /** Height of every element; the pane's is what matters. */
  let height = 600;
  let observers: (() => void)[] = [];

  beforeEach(() => {
    stubDesktop();
    height = 600;
    observers = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
          observers.push(callback);
        }
        observe() {
          return undefined;
        }
        unobserve() {
          return undefined;
        }
        disconnect() {
          observers = observers.filter((item) => item !== this.callback);
        }
      },
    );
    vi.stubGlobal('innerHeight', 900);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      // The top bar is 68 px; everything else is the pane's height.
      return this.hasAttribute('data-top-bar') ? 68 : height;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const paneTop = async () => (await pane('Sun 8 Nov · 19:00–19:30')).style.top;

  it('sticks under the top bar when the pane fits, and stops when it grows taller', async () => {
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    renderApp(`/all/activity/sessions?session=${HOP.id}`);
    // 68 + 20 + 600 + 20 ≤ 900: under the top bar.
    await waitFor(async () => {
      expect(await paneTop()).toBe('88px');
    });

    // A section unfolds (or Older/Newer): taller than the window, so it scrolls with the page.
    height = 1400;
    act(() => {
      for (const observer of observers) observer();
    });
    await waitFor(async () => {
      expect(await paneTop()).toBe('');
    });
  });

  it('does not stick a pane that is taller than the window from the start', async () => {
    height = 1400;
    mockApi({ '/api/v1/accounts/all/sessions': sessionsAnswer, ...detailAnswers() });
    renderApp(`/all/activity/sessions?session=${HOP.id}`);
    const region = await pane('Sun 8 Nov · 19:00–19:30');
    act(() => {
      for (const observer of observers) observer();
    });
    expect(region.style.top).toBe('');
  });
});

interface PollingOptions {
  refetchInterval: (query: unknown) => number | false;
  refetchIntervalInBackground: boolean;
}

/** The polling options of a session query (the hop chain walk does not poll). */
function pollingOf(queryClient: QueryClient, sessionId: string) {
  const query = queryClient.getQueryCache().find({ queryKey: ['session', sessionId] });
  const observer = query?.observers.find(
    (item) => typeof item.options.refetchInterval === 'function',
  );
  expect(observer).toBeDefined();
  return { query, options: observer?.options as unknown as PollingOptions };
}

/** The polling interval of the sessions list right now (`false` = none). */
function listInterval(queryClient: QueryClient): number | false {
  // Not exact: the key also holds the page size.
  const query = queryClient.getQueryCache().find({ queryKey: ['sessions', 'all'], exact: false });
  const observer = query?.observers.find(
    (item) => typeof item.options.refetchInterval === 'function',
  );
  if (!observer) return false;
  const options = observer.options as unknown as PollingOptions;
  return options.refetchInterval(query);
}
