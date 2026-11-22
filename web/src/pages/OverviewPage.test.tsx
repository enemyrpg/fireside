import type {
  AccountsResponse,
  FeedEntry,
  FeedResponse,
  Session,
  SessionDetailResponse,
  SessionsResponse,
} from '@fireside/shared';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import accountsFixture from '../../../shared/fixtures/api/accounts-response/valid/accounts.json';
import historyFixture from '../../../shared/fixtures/api/bank-history-response/valid/dst-carry-forward.json';
import summaryNoData from '../../../shared/fixtures/api/bank-summary-response/valid/no-data.json';
import summaryFixture from '../../../shared/fixtures/api/bank-summary-response/valid/one-account.json';
import calendarFixture from '../../../shared/fixtures/api/calendar-response/valid/range.json';
import feedFixture from '../../../shared/fixtures/api/feed-response/valid/all-types.json';
import gainsFixture from '../../../shared/fixtures/api/gains-response/valid/week.json';
import screentimeFixture from '../../../shared/fixtures/api/screentime-response/valid/by-day.json';
import detailFixture from '../../../shared/fixtures/api/session-detail-response/valid/session.json';
import sessionsFixture from '../../../shared/fixtures/api/sessions-response/valid/page.json';
import completeWeek from '../../../shared/fixtures/api/weekly-response/valid/complete-week.json';
import emptyWeek from '../../../shared/fixtures/api/weekly-response/valid/empty-current-week.json';
import { LIVE_POLL_MS } from '@/api/query-client';
import { calendarRange } from '@/lib/calendar';
import { mockApi, renderApp, stubDesktop, type MockAnswer } from '@/test/render-app';

// "Today" is Wednesday 11 November 2026, 13:00 in Europe/Oslo (the health
// fixture). The accounts fixture has 1 ("Test Main") and 2 ("Alt"), both last
// seen on 8 November, so nobody is online unless a test says so.
//
// The sessions fixture has an open session (first) and a closed one; the
// detail fixture is the closed one: 2 h, 120,000 XP (Slayer, Hitpoints),
// 2.86M gp in 2 drops, Vorkath +18 and Zulrah +4.
//
// The feed fixture has that closed session (ended 21:00 on Sun 8 Nov in Oslo),
// Slayer 89 → 90 in it, two new collection log items (one with a 2.85M drop),
// a 1.2M Dragon spear and, the day before, the pet Vorki. It has a next page.

const SESSIONS = sessionsFixture as SessionsResponse;
const DETAIL = detailFixture as SessionDetailResponse;
const [OPEN, CLOSED] = SESSIONS.items as [
  SessionsResponse['items'][0],
  SessionsResponse['items'][0],
];

const OPEN_DETAIL: SessionDetailResponse = {
  ...DETAIL,
  session: { ...OPEN },
  neighbors: { olderId: CLOSED.id, newerId: null },
};

const FEED = feedFixture as FeedResponse;
const EMPTY_FEED: FeedResponse = { items: [], nextCursor: null };

function sessionEntry(session: Session, at = session.endedAt ?? session.startedAt): FeedEntry {
  return {
    type: 'session',
    id: `session:${session.id}`,
    at,
    accountId: session.accountId,
    session,
  };
}
const NO_SESSIONS: SessionsResponse = { items: [], nextCursor: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SERVER_ERROR = () =>
  json({ error: { code: 'INTERNAL_ERROR', message: 'Boom', details: [] } }, 500);

interface Data {
  sessions?: SessionsResponse;
  details?: SessionDetailResponse[];
  answers?: Record<string, MockAnswer>;
}

function mockOverview(scope: string, { sessions, details = [DETAIL], answers = {} }: Data = {}) {
  return mockApi({
    [`/api/v1/accounts/${scope}/sessions`]: {
      body: sessions ?? { items: [CLOSED], nextCursor: null },
    },
    ...Object.fromEntries(
      details.map((detail) => [`/api/v1/sessions/${detail.session.id}`, { body: detail }]),
    ),
    [`/api/v1/accounts/${scope}/weekly`]: { body: completeWeek },
    [`/api/v1/accounts/${scope}/gains`]: { body: gainsFixture },
    [`/api/v1/accounts/${scope}/screentime`]: { body: screentimeFixture },
    [`/api/v1/accounts/${scope}/feed`]: { body: FEED },
    [`/api/v1/accounts/${scope}/calendar`]: { body: calendarFixture },
    ...answers,
  });
}

function requests(fetchMock: ReturnType<typeof mockApi>, path: string): URLSearchParams[] {
  return fetchMock.mock.calls
    .map(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new URL(url, 'http://localhost');
    })
    .filter((url) => url.pathname === path)
    .map((url) => url.searchParams);
}

/** The polling interval Home's observer of a query uses (`false` = none). */
function pollInterval(queryClient: QueryClient, key: readonly unknown[]): number | false {
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: false });
  if (!query) throw new Error(`No query ${JSON.stringify(key)}`);
  const intervals = query.observers.map((observer) => {
    const { refetchInterval } = observer.options;
    const value = typeof refetchInterval === 'function' ? refetchInterval(query) : refetchInterval;
    return value ?? false;
  });
  return intervals.find((value) => value !== false) ?? false;
}

/** The card (`section`) with a heading that starts with `name`. */
async function card(name: string) {
  const heading = await screen.findByRole('heading', { level: 2, name: new RegExp(`^${name}`) });
  const section = heading.closest('section');
  if (!section) throw new Error(`No card for ${name}`);
  return within(section);
}

const strip = () => screen.findByRole('region', { name: 'This week' });
const latest = async () => within(await screen.findByRole('region', { name: 'Latest' }));

describe('Home', () => {
  beforeEach(() => {
    // Only Date is faked, so Testing Library's timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows this week, Latest, the top skills and the calendar for one account', async () => {
    const fetchMock = mockOverview('1');
    const { queryClient } = renderApp('/1');

    // The complete week fixture: 10 h (7 h 46 min the week before), 1.5M XP, 12M gp and 18 Vorkath kills.
    const week = within(await strip());
    expect(await week.findByText('10 h')).toBeTruthy();
    expect(week.getByText(/^played · ▲ .+ vs last week$/)).toBeTruthy();
    expect(week.getByText('1.5M')).toBeTruthy();
    // The gains fixture: Slayer and Hitpoints.
    expect(await week.findByText('XP · 2 skills')).toBeTruthy();
    expect(week.getByText('12M')).toBeTruthy();
    expect(week.getByText('18')).toBeTruthy();
    expect(week.getByText('kills · 1 boss')).toBeTruthy();
    expect(week.getByText('Week 45 · Mon 2 – Sun 8 Nov')).toBeTruthy();
    expect(week.getByText('Offline · last played 8 Nov, 22:00')).toBeTruthy();
    // The screen time fixture: the Saturday and the Sunday.
    expect(
      (await week.findByRole('img', { name: /^Play time per day/ })).getAttribute('aria-label'),
    ).toBe('Play time per day this week: Saturday 1 h, Sunday 2 h 10 min');
    // One account: no account chips. No greeting any more.
    expect(screen.queryByRole('list', { name: 'Accounts' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Good / })).toBeNull();

    const feed = await latest();
    expect(await feed.findByRole('heading', { level: 3, name: 'Sun 8 Nov' })).toBeTruthy();
    expect(feed.getByRole('heading', { level: 3, name: 'Sat 7 Nov' })).toBeTruthy();
    const session = feed.getByRole('link', { name: /Session · 2 h/ });
    // Mobile: the session's own screen.
    expect(session.getAttribute('href')).toBe(`/sessions/${CLOSED.id}`);
    expect(within(session).getByText('120K XP')).toBeTruthy();
    expect(within(session).getByText('Vorkath')).toBeTruthy();
    // The end in the time column, the whole span in the line under the title.
    expect(within(session).getAllByText('19:00–21:00').length).toBeGreaterThan(0);
    expect(within(session).getByText('21:00')).toBeTruthy();
    expect(feed.getByRole('link', { name: /Slayer level 90.*up from 89/ })).toBeTruthy();
    const visage = feed.getByRole('link', { name: /Draconic visage/ });
    expect(within(visage).getByText('· new collection log')).toBeTruthy();
    expect(within(visage).getByText('340 of 1,734 slots')).toBeTruthy();
    expect(within(visage).getByText('2.85M')).toBeTruthy();
    expect(visage.getAttribute('href')).toBe('/1/collections/log?tab=bosses&page=vorkath');
    expect(feed.getByRole('link', { name: /Dragon spear/ }).getAttribute('href')).toBe(
      `/sessions/${CLOSED.id}`,
    );
    const pet = feed.getByRole('link', { name: /Vorki/ });
    expect(within(pet).getByText('· new pet')).toBeTruthy();
    expect(pet.getAttribute('href')).toBe('/1/collections/pets');
    // One account: no account name on a row.
    expect(feed.queryByText('Test Main')).toBeNull();
    expect(feed.getByRole('link', { name: 'All sessions →' }).getAttribute('href')).toBe(
      '/1/activity/sessions',
    );
    // Nothing is live.
    expect(screen.queryByRole('region', { name: 'Live session' })).toBeNull();

    const skills = await card('Top skills this week');
    expect(await skills.findByText('Slayer')).toBeTruthy();
    expect(skills.getByText('800K')).toBeTruthy();
    expect(skills.getByRole('link', { name: 'XP →' }).getAttribute('href')).toBe('/1/progress/xp');

    const activity = await card('Activity');
    expect(await activity.findByText('4 days played in the last year')).toBeTruthy();
    expect(activity.getByRole('img', { name: /^Activity calendar/ })).toBeTruthy();

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'This week',
      'Latest',
      'Top skills this week',
      'Activity',
    ]);

    // The asked-for parameters.
    expect(requests(fetchMock, '/api/v1/accounts/1/sessions')[0]?.get('limit')).toBe('20');
    expect(Object.fromEntries(requests(fetchMock, '/api/v1/accounts/1/feed')[0] ?? [])).toEqual({});
    expect(Object.fromEntries(requests(fetchMock, '/api/v1/accounts/1/gains')[0] ?? [])).toEqual({
      period: 'week',
    });
    expect(
      Object.fromEntries(requests(fetchMock, '/api/v1/accounts/1/screentime')[0] ?? []),
    ).toEqual({ from: completeWeek.start, to: completeWeek.end, bucket: 'day' });
    const [calendarParams] = requests(fetchMock, '/api/v1/accounts/1/calendar');
    const range = calendarRange('2026-11-11', 'Europe/Oslo');
    expect(calendarParams?.get('from')).toBe(range.from);
    expect(calendarParams?.get('to')).toBe(range.to);
    expect(requests(fetchMock, '/api/v1/accounts/1/weekly')[0]?.get('week')).toBeNull();

    // Nothing is open, so nothing polls.
    for (const key of [
      ['sessions', 1],
      ['accounts'],
      ['weekly', 1],
      ['gains', 1],
      ['screentime', 1],
      ['feed', 1],
      ['calendar', 1],
    ]) {
      expect(pollInterval(queryClient, key)).toBe(false);
    }
  });

  it('pins the live session on top, once, and polls everything while it is open', async () => {
    const online: AccountsResponse = {
      accounts: (accountsFixture as AccountsResponse).accounts.map((account) =>
        account.id === 1 ? { ...account, lastSeenAt: '2026-11-11T11:59:30.000Z' } : account,
      ),
    };
    // The feed has the open session too, at its last heartbeat.
    const feed: FeedResponse = {
      items: [sessionEntry(OPEN, '2026-11-08T21:10:00.000Z'), ...FEED.items],
      nextCursor: null,
    };
    mockOverview('all', {
      sessions: SESSIONS,
      details: [OPEN_DETAIL],
      answers: {
        '/api/v1/accounts': { body: online },
        '/api/v1/accounts/all/feed': { body: feed },
      },
    });
    const { queryClient } = renderApp('/all');

    expect(await screen.findByText('Test Main is online · World 420')).toBeTruthy();
    const pinned = within(await screen.findByRole('region', { name: 'Live session' }));
    expect(pinned.getByText('Session · 10 min')).toBeTruthy();
    expect(pinned.getByText('Live')).toBeTruthy();
    // The open part has no summary: its numbers come from the session itself.
    expect(await pinned.findByText('120K XP')).toBeTruthy();
    // `all` names the account.
    expect(pinned.getByText('Test Main')).toBeTruthy();

    // Not repeated among the days; the closed session still is there.
    const list = await latest();
    await list.findByRole('link', { name: /Session · 2 h/ });
    expect(list.getAllByText('Session · 10 min')).toHaveLength(1);
    expect(list.getAllByText('Live')).toHaveLength(1);

    await waitFor(() => {
      expect(pollInterval(queryClient, ['sessions', 'all'])).toBe(LIVE_POLL_MS);
    });
    for (const key of [
      ['accounts'],
      ['weekly', 'all'],
      ['gains', 'all'],
      // With the week's range: the query before `weekly` arrived has none and is disabled.
      ['screentime', 'all', { from: completeWeek.start, to: completeWeek.end, bucket: 'day' }],
      ['feed', 'all'],
      ['calendar', 'all'],
    ]) {
      await waitFor(() => {
        expect([key, pollInterval(queryClient, key)]).toEqual([key, LIVE_POLL_MS]);
      });
    }
    expect(pollInterval(queryClient, ['session', OPEN.id])).toBe(LIVE_POLL_MS);
  });

  it('pins the live session under Sessions, but not under Drops', async () => {
    mockOverview('1', { sessions: SESSIONS, details: [OPEN_DETAIL] });
    const { router } = renderApp('/1?show=drops');
    const list = await latest();
    await list.findByRole('link', { name: /Dragon spear/ });
    expect(screen.queryByRole('region', { name: 'Live session' })).toBeNull();

    await router.navigate('/1?show=sessions');
    expect(await screen.findByRole('region', { name: 'Live session' })).toBeTruthy();
  });

  it('keeps the filter in the URL, replacing the history entry', async () => {
    stubDesktop();
    const fetchMock = mockOverview('1');
    const { router } = renderApp('/1?show=drops');

    const filter = within(await screen.findByRole('radiogroup', { name: 'Filter' }));
    expect(filter.getByRole('radio', { name: 'Drops' }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => {
      expect(requests(fetchMock, '/api/v1/accounts/1/feed')[0]?.get('types')).toBe('drop');
    });

    await userEvent.click(filter.getByRole('radio', { name: 'Collection log' }));
    expect(router.state.location.search).toBe('?show=clog');
    expect(router.state.historyAction).toBe('REPLACE');
    await waitFor(() => {
      expect(requests(fetchMock, '/api/v1/accounts/1/feed').at(-1)?.get('types')).toBe('clog,pet');
    });

    await userEvent.click(filter.getByRole('radio', { name: 'Levels' }));
    expect(router.state.location.search).toBe('?show=levels');
    await waitFor(() => {
      expect(requests(fetchMock, '/api/v1/accounts/1/feed').at(-1)?.get('types')).toBe('level');
    });

    // All is the URL without the parameter.
    await userEvent.click(filter.getByRole('radio', { name: 'All' }));
    expect(router.state.location.search).toBe('');
    // PC: a session opens selected in the Sessions list.
    const session = await (await latest()).findByRole('link', { name: /Session · 2 h/ });
    expect(session.getAttribute('href')).toBe(`/1/activity/sessions?session=${CLOSED.id}`);
  });

  it('has one menu for the filter on mobile, and reads an unknown filter as All', async () => {
    const fetchMock = mockOverview('1');
    const { router } = renderApp('/1?show=pills');
    const button = await screen.findByRole('button', { name: 'Filter: All' });
    expect(screen.queryByRole('radiogroup', { name: 'Filter' })).toBeNull();
    expect(requests(fetchMock, '/api/v1/accounts/1/feed')[0]?.get('types')).toBeNull();

    await userEvent.click(button);
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Levels' }));
    expect(router.state.location.search).toBe('?show=levels');
    expect(await screen.findByRole('button', { name: 'Filter: Levels' })).toBeTruthy();
  });

  it('shows six rows from one page, with no "Load more" and no second request', async () => {
    const fetchMock = mockOverview('1');
    renderApp('/1');

    const list = await latest();
    await list.findByRole('link', { name: /Vorki/ });
    // The fixture's six entries are six rows.
    expect(list.getAllByRole('listitem')).toHaveLength(6);
    expect(list.queryByRole('button', { name: 'Load more' })).toBeNull();
    // It has a next page, which nobody asks for.
    expect(FEED.nextCursor).not.toBeNull();
    expect(requests(fetchMock, '/api/v1/accounts/1/feed')).toHaveLength(1);
  });

  it('leaves out empty short sessions and follows the cursor only to fill six rows', async () => {
    const olderSession = (n: number, hour: number): Session => ({
      ...CLOSED,
      id: `01933c40-0${String(n)}99-7aaa-bbbb-ccccdddd000${String(n)}`,
      startedAt: `2026-11-0${String(n)}T${String(hour)}:00:00.000Z`,
      endedAt: `2026-11-0${String(n)}T${String(hour + 1)}:30:00.000Z`,
      durationSeconds: 5400,
      activeSeconds: 5400,
      afkSeconds: 0,
    });
    // Four minutes with nothing in them: on the Sessions page only.
    const emptyShort: Session = {
      ...CLOSED,
      id: '01933c40-0888-7aaa-bbbb-ccccdddd0008',
      startedAt: '2026-11-08T20:30:00.000Z',
      endedAt: '2026-11-08T20:34:00.000Z',
      durationSeconds: 240,
      activeSeconds: 240,
      afkSeconds: 0,
      summary: {
        xpGainedTotal: 0,
        xpGainedBySkill: {},
        lootGeValue: 0,
        lootCount: 0,
        kcGainedByBoss: {},
      },
      newCollectionLogCount: 0,
    };
    // Five entries, four rows: fewer than six, so the next page is asked for.
    const firstPage: FeedResponse = {
      items: [sessionEntry(emptyShort), ...FEED.items.slice(0, 4)],
      nextCursor: 'next',
    };
    const secondPage: FeedResponse = {
      items: [5, 4, 3].map((n) => sessionEntry(olderSession(n, 18))),
      nextCursor: 'further',
    };
    const fetchMock = mockOverview('1', {
      answers: {
        '/api/v1/accounts/1/feed': (url) =>
          json(
            new URL(url, 'http://localhost').searchParams.has('cursor') ? secondPage : firstPage,
          ),
      },
    });
    renderApp('/1');

    const list = await latest();
    expect(await list.findByRole('heading', { level: 3, name: 'Wed 4 Nov' })).toBeTruthy();
    // Four from the first page and two of the second page's three.
    expect(list.getAllByRole('listitem')).toHaveLength(6);
    expect(list.queryByRole('heading', { level: 3, name: 'Tue 3 Nov' })).toBeNull();
    expect(list.queryByRole('link', { name: /Session · 4 min/ })).toBeNull();
    // One more request, with the first page's cursor, and no third.
    const feedRequests = requests(fetchMock, '/api/v1/accounts/1/feed');
    expect(feedRequests.map((params) => params.get('cursor'))).toEqual([null, 'next']);
  });

  it('links to the page that has the rest of what the filter shows', async () => {
    mockOverview('1');
    const { router } = renderApp('/1');
    const list = await latest();
    expect(list.getByRole('link', { name: 'All sessions →' }).getAttribute('href')).toBe(
      '/1/activity/sessions',
    );

    await router.navigate('/1?show=sessions');
    expect((await list.findByRole('link', { name: 'All sessions →' })).getAttribute('href')).toBe(
      '/1/activity/sessions',
    );
    await router.navigate('/1?show=drops');
    expect((await list.findByRole('link', { name: 'Loot & KC →' })).getAttribute('href')).toBe(
      '/1/progress/loot',
    );
    await router.navigate('/1?show=levels');
    expect((await list.findByRole('link', { name: 'XP →' })).getAttribute('href')).toBe(
      '/1/progress/xp',
    );
    // No account has a collection log here, so there is no page to link to.
    await router.navigate('/1?show=clog');
    await waitFor(() => {
      expect(list.queryByRole('link', { name: /→$/ })).toBeNull();
    });
    expect(await list.findByRole('link', { name: /Draconic visage/ })).toBeTruthy();
    expect(list.queryByRole('link', { name: /→$/ })).toBeNull();
  });

  it('shows a chain of three world hops as one session', async () => {
    const part = (n: number, startedAt: string, endedAt: string, hop: boolean): Session => ({
      ...CLOSED,
      id: `01933c40-0${String(n)}00-7aaa-bbbb-ccccdddd000${String(n)}`,
      startedAt,
      endedAt,
      endReason: hop ? 'hop' : 'logout',
      durationSeconds: 1800,
      activeSeconds: 1800,
      afkSeconds: 0,
    });
    const parts = [
      part(3, '2026-11-08T19:02:00.000Z', '2026-11-08T19:32:00.000Z', false),
      part(2, '2026-11-08T18:31:00.000Z', '2026-11-08T19:01:00.000Z', true),
      part(1, '2026-11-08T18:00:00.000Z', '2026-11-08T18:30:00.000Z', true),
    ];
    mockOverview('1', {
      sessions: NO_SESSIONS,
      answers: {
        '/api/v1/accounts/1/feed': {
          body: { items: parts.map((value) => sessionEntry(value)), nextCursor: null },
        },
      },
    });
    renderApp('/1');

    const list = await latest();
    // 3 × 30 min and 3 × 120,000 XP in one row, which opens the first part.
    const row = await list.findByRole('link', { name: /Session · 1 h 30 min/ });
    expect(within(row).getByText('360K XP')).toBeTruthy();
    expect(row.getAttribute('href')).toBe(`/sessions/${parts[2]?.id ?? ''}`);
    expect(list.getAllByRole('link', { name: /Session · / })).toHaveLength(1);
  });

  it('shows account chips and names rows by account for all accounts', async () => {
    mockOverview('all');
    renderApp('/all');

    expect(await screen.findByText('No accounts online · last played 8 Nov, 22:00')).toBeTruthy();
    const chips = within(screen.getByRole('list', { name: 'Accounts' }));
    expect(chips.getByRole('link', { name: 'Test Main' }).getAttribute('href')).toBe('/1');
    expect(chips.getByRole('link', { name: 'Alt' }).getAttribute('href')).toBe('/2');
    const session = await (await latest()).findByRole('link', { name: /Session · 2 h/ });
    expect(within(session).getByText('Test Main')).toBeTruthy();
  });

  it('invites instead of looking empty or broken in a week without play', async () => {
    const fetchMock = mockOverview('2', {
      sessions: NO_SESSIONS,
      details: [],
      answers: {
        '/api/v1/accounts/2/weekly': { body: emptyWeek },
        '/api/v1/accounts/2/gains': { body: { ...gainsFixture, skills: [] } },
        '/api/v1/accounts/2/feed': { body: EMPTY_FEED },
        '/api/v1/accounts/2/calendar': { body: { ...calendarFixture, days: [] } },
      },
    });
    renderApp('/2');

    expect(await screen.findByText('Your last session shows up here after you play.')).toBeTruthy();
    expect(await screen.findByText('No XP gained this week yet.')).toBeTruthy();
    expect(await screen.findByText('0 days played in the last year')).toBeTruthy();
    // The week shows zeros rather than hiding, with plain labels and seven empty days.
    const week = within(await strip());
    expect(await week.findByText('0 min')).toBeTruthy();
    expect(week.getByText('played')).toBeTruthy();
    expect(week.getAllByText('XP').length).toBeGreaterThan(0);
    expect(week.queryByText(/skills?$/)).toBeNull();
    expect(week.getAllByText('kills').length).toBeGreaterThan(0);
    expect(week.getByRole('img', { name: 'Play time per day this week: none yet' })).toBeTruthy();
    expect(week.getAllByTestId('week-day-bar')).toHaveLength(7);
    // No play time: the bars need no request.
    expect(requests(fetchMock, '/api/v1/accounts/2/screentime')).toEqual([]);
  });

  it('says what a filter is for when it finds nothing', async () => {
    mockOverview('1', { answers: { '/api/v1/accounts/1/feed': { body: EMPTY_FEED } } });
    renderApp('/1?show=levels');
    expect(await screen.findByText('Level-ups show up here.')).toBeTruthy();
  });

  it('keeps the rest of the page working when one part fails, and retries it', async () => {
    let fail = true;
    mockOverview('1', {
      answers: {
        '/api/v1/accounts/1/weekly': () => (fail ? SERVER_ERROR() : json(completeWeek)),
      },
    });
    renderApp('/1');

    const numbers = within(await screen.findByRole('region', { name: 'This week’s numbers' }));
    expect(await numbers.findByText("Couldn't load this.")).toBeTruthy();
    expect(await (await latest()).findByRole('link', { name: /Session · 2 h/ })).toBeTruthy();
    expect(await screen.findByText('4 days played in the last year')).toBeTruthy();

    fail = false;
    await userEvent.click(numbers.getByRole('button', { name: 'Retry' }));
    expect(await within(await strip()).findByText('10 h')).toBeTruthy();
  });

  it('keeps Latest apart from a feed that fails', async () => {
    let fail = true;
    mockOverview('1', {
      answers: { '/api/v1/accounts/1/feed': () => (fail ? SERVER_ERROR() : json(FEED)) },
    });
    renderApp('/1');
    const list = await latest();
    expect(await list.findByText("Couldn't load this.")).toBeTruthy();
    expect(await within(await strip()).findByText('10 h')).toBeTruthy();
    fail = false;
    await userEvent.click(list.getByRole('button', { name: 'Retry' }));
    expect(await list.findByRole('link', { name: /Session · 2 h/ })).toBeTruthy();
  });

  it('says so and retries when the sessions list fails, with the feed still shown', async () => {
    let fail = true;
    mockOverview('1', {
      answers: {
        '/api/v1/accounts/1/sessions': () =>
          fail ? SERVER_ERROR() : json({ items: [CLOSED], nextCursor: null }),
      },
    });
    renderApp('/1');

    const list = await latest();
    expect(await list.findByText("Couldn't load this.")).toBeTruthy();
    expect(await list.findByRole('link', { name: /Session · 2 h/ })).toBeTruthy();

    fail = false;
    await userEvent.click(list.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(list.queryByText("Couldn't load this.")).toBeNull();
    });
  });

  it('shows no day bars while they load or after they fail, only the numbers', async () => {
    mockOverview('1', { answers: { '/api/v1/accounts/1/screentime': SERVER_ERROR } });
    renderApp('/1');
    const week = within(await strip());
    expect(await week.findByText('10 h')).toBeTruthy();
    expect(await week.findByText('XP · 2 skills')).toBeTruthy();
    expect(week.queryByRole('img', { name: /^Play time per day/ })).toBeNull();
    expect(week.queryAllByTestId('week-day-bar')).toEqual([]);
  });

  it('counts the kills of a boss with any name in the live session', async () => {
    const detail: SessionDetailResponse = {
      ...OPEN_DETAIL,
      kc: [{ boss: 'constructor', startKillCount: 10, endKillCount: 13, gained: 3 }],
    };
    mockOverview('1', { sessions: SESSIONS, details: [detail] });
    renderApp('/1');
    const pinned = within(await screen.findByRole('region', { name: 'Live session' }));
    expect(await pinned.findByText('constructor')).toBeTruthy();
    expect(pinned.getByText('+3')).toBeTruthy();
  });

  it('fetches the feed once more when the live session closes, and shows it once, not live', async () => {
    let closed = false;
    const ended: Session = {
      ...OPEN,
      endedAt: '2026-11-08T21:10:00.000Z',
      endReason: 'logout',
      summary: CLOSED.summary,
    };
    const fetchMock = mockOverview('1', {
      details: [OPEN_DETAIL],
      answers: {
        '/api/v1/accounts/1/sessions': () =>
          json({ items: closed ? [ended, CLOSED] : [OPEN, CLOSED], nextCursor: null }),
        '/api/v1/accounts/1/feed': () =>
          json({
            items: [
              closed ? sessionEntry(ended) : sessionEntry(OPEN, '2026-11-08T21:09:30.000Z'),
              ...FEED.items,
            ],
            nextCursor: null,
          }),
      },
    });
    const { queryClient } = renderApp('/1');
    await screen.findByRole('region', { name: 'Live session' });
    const before = requests(fetchMock, '/api/v1/accounts/1/feed').length;

    // The next poll of the sessions list sees the logout.
    closed = true;
    await queryClient.refetchQueries({ queryKey: ['sessions', 1] });

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Live session' })).toBeNull();
    });
    await waitFor(() => {
      expect(requests(fetchMock, '/api/v1/accounts/1/feed').length).toBe(before + 1);
    });
    const list = await latest();
    expect(list.getAllByRole('link', { name: /Session · 10 min/ })).toHaveLength(1);
    expect(list.queryByText('Live')).toBeNull();
  });

  it('shows the net worth beside Latest once there is bank data', async () => {
    const fetchMock = mockOverview('1', {
      answers: {
        '/api/v1/accounts/1/bank/summary': { body: summaryFixture },
        '/api/v1/accounts/1/bank/history': { body: historyFixture },
      },
    });
    const { queryClient } = renderApp('/1');

    const worth = await card('Net worth');
    expect(worth.getByText('1.48B')).toBeTruthy();
    expect(worth.getByText(/^GE value · updated \w{3} \d+ \w{3}, \d\d:\d\d$/)).toBeTruthy();
    expect(worth.getByText('Cash')).toBeTruthy();
    expect(worth.getByText('16.83M gp')).toBeTruthy();
    expect(worth.getByRole('link', { name: 'Bank →' }).getAttribute('href')).toBe('/1/bank');
    // The last 30 local days, today (11 Nov, Europe/Oslo) included, as an area with its ends named.
    const spark = await worth.findByRole('img');
    expect(spark.getAttribute('aria-label')).toBe('Net worth, last 30 days: 1.02M gp to 1.25M gp');
    expect(
      Object.fromEntries(requests(fetchMock, '/api/v1/accounts/1/bank/history')[0] ?? []),
    ).toEqual({ from: '2026-10-12T22:00:00.000Z', to: '2026-11-11T23:00:00.000Z' });

    // Above the top skills, after Latest.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'This week',
      'Latest',
      'Net worth',
      'Top skills this week',
      'Activity',
    ]);
    // No open session: nothing polls.
    expect(pollInterval(queryClient, ['bank-summary', 1])).toBe(false);
    expect(pollInterval(queryClient, ['bank-history', 1])).toBe(false);
  });

  it('polls the net worth only while a session is open', async () => {
    mockOverview('all', {
      sessions: SESSIONS,
      details: [OPEN_DETAIL],
      answers: {
        '/api/v1/accounts/all/bank/summary': { body: summaryFixture },
        '/api/v1/accounts/all/bank/history': { body: historyFixture },
      },
    });
    const { queryClient } = renderApp('/all');
    const worth = await card('Net worth');
    await worth.findByRole('img');
    await waitFor(() => {
      expect(pollInterval(queryClient, ['bank-history', 'all'])).toBe(LIVE_POLL_MS);
    });
  });

  it("never shows one account's net worth under another account", async () => {
    // Account 2's answer never arrives, so anything shown would be account 1's.
    const pending = () => new Promise<Response>(() => undefined);
    mockOverview('1', {
      answers: {
        '/api/v1/accounts/1/bank/summary': { body: summaryFixture },
        '/api/v1/accounts/1/bank/history': { body: historyFixture },
        '/api/v1/accounts/2/sessions': { body: NO_SESSIONS },
        '/api/v1/accounts/2/weekly': { body: emptyWeek },
        '/api/v1/accounts/2/gains': { body: gainsFixture },
        '/api/v1/accounts/2/feed': { body: EMPTY_FEED },
        '/api/v1/accounts/2/calendar': { body: calendarFixture },
        '/api/v1/accounts/2/bank/summary': pending,
        '/api/v1/accounts/2/bank/history': pending,
      },
    });
    const { router } = renderApp('/1');
    const worth = await card('Net worth');
    await worth.findByRole('img');

    await router.navigate('/2');
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Net worth' })).toBeNull();
    });
    expect(screen.queryByText('1.48B')).toBeNull();
  });

  it('hides the net worth until an account has a bank snapshot', async () => {
    const fetchMock = mockOverview('1', {
      answers: { '/api/v1/accounts/1/bank/summary': { body: summaryNoData } },
    });
    renderApp('/1');
    expect(await within(await strip()).findByText('10 h')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Net worth' })).toBeNull();
    // Without bank data the history is never asked for.
    expect(requests(fetchMock, '/api/v1/accounts/1/bank/history')).toEqual([]);
  });

  it('shows the net worth without the line when the history fails', async () => {
    mockOverview('1', {
      answers: {
        '/api/v1/accounts/1/bank/summary': { body: summaryFixture },
        '/api/v1/accounts/1/bank/history': SERVER_ERROR,
      },
    });
    renderApp('/1');
    const worth = await card('Net worth');
    expect(worth.getByText('1.48B')).toBeTruthy();
    await waitFor(() => {
      expect(worth.queryByRole('img')).toBeNull();
    });
    expect(worth.getByText('16.83M gp')).toBeTruthy();
  });

  it('welcomes a new instance with three numbered steps and no account switcher', async () => {
    mockApi({ '/api/v1/accounts': { body: { accounts: [] } } });
    renderApp('/all');

    expect(await screen.findByRole('heading', { level: 2, name: /^Welcome to / })).toBeTruthy();
    const steps = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(
      steps.map((step) => within(step).getByRole('heading', { level: 3 }).textContent),
    ).toEqual(['Create an API key', 'Install the plugin and paste the key', 'Log in to the game']);
    expect(steps.map((step) => step.querySelector('[aria-hidden]')?.textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(screen.getByRole('link', { name: 'Create a key →' }).getAttribute('href')).toBe(
      '/settings/keys',
    );
    expect(screen.queryByRole('heading', { name: 'This week' })).toBeNull();
    // Nothing to pick: no account switcher, on mobile (here) or PC.
    expect(screen.queryByRole('button', { name: /^Choose account/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Settings and profile' })).toBeTruthy();
  });

  it('has no account switcher in the top bar of a new instance either', async () => {
    stubDesktop();
    mockApi({ '/api/v1/accounts': { body: { accounts: [] } } });
    renderApp('/all');
    await screen.findByRole('heading', { level: 2, name: /^Welcome to / });
    expect(screen.queryByRole('button', { name: /^Choose account/ })).toBeNull();
  });
});
