import type { ScreentimeResponse, ScreentimeWorldsResponse } from '@fireside/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import heatmapFixture from '../../../shared/fixtures/api/screentime-heatmap-response/valid/heatmap.json';
import screentimeFixture from '../../../shared/fixtures/api/screentime-response/valid/by-day.json';
import worldsFixture from '../../../shared/fixtures/api/screentime-worlds-response/valid/worlds.json';
import { mockApi, renderApp, stubDesktop, type MockAnswer } from '@/test/render-app';

// The screen time fixture is 7 days with play on 2 of them: 3 h 10 min in
// total (2 h 55 min active, 15 min AFK), 2 h 30 min the previous period. The
// worlds fixture has members world 420 (Germany), F2P world 301 (UK) and
// world 999 without a location. The health fixture's zone is Europe/Oslo.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SERVER_ERROR = () =>
  json({ error: { code: 'INTERNAL_ERROR', message: 'Boom', details: [] } }, 500);

/** Echoes the requested `from`/`to`, like the server. */
function echo(body: {
  from: string;
  to: string;
  [key: string]: unknown;
}): (url: string) => Response {
  return (url) => {
    const params = new URL(url, 'http://localhost').searchParams;
    return json({
      ...body,
      from: params.get('from') ?? body.from,
      to: params.get('to') ?? body.to,
    });
  };
}

function mockScreentimeApi(scope: string, answers: Record<string, MockAnswer> = {}) {
  return mockApi({
    [`/api/v1/accounts/${scope}/screentime`]: echo(screentimeFixture),
    [`/api/v1/accounts/${scope}/screentime/worlds`]: echo(worldsFixture),
    [`/api/v1/accounts/${scope}/screentime/heatmap`]: echo(heatmapFixture),
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

describe('Screen time', () => {
  it('asks for the last 30 local days per day by default and shows the numbers', async () => {
    // Only Date is faked, so Testing Library's timers keep working. Wednesday 11 November 2026.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    try {
      const fetchMock = mockScreentimeApi('all');
      renderApp('/all/activity/screentime');

      expect(await screen.findByRole('heading', { level: 1, name: 'Activity' })).toBeTruthy();
      expect(await screen.findByText('3 h 10 min')).toBeTruthy();
      expect(screen.getByText('▲ 40 min (+27%) vs previous 30 days')).toBeTruthy();
      const summary = screen.getByRole('region', { name: 'Screen time summary' });
      expect(within(summary).getByText('play time · last 30 days')).toBeTruthy();
      expect(within(summary).getByText('27 min')).toBeTruthy(); // average per day
      expect(within(summary).getByText('average per day · 2 of 7 days played')).toBeTruthy();
      expect(within(summary).getByText('avg per day')).toBeTruthy(); // mobile label
      expect(within(summary).getByText('sessions · avg 1 h 3 min · longest 2 h')).toBeTruthy();
      expect(within(summary).getByText('8%')).toBeTruthy();
      expect(within(summary).getByText('AFK · 15 min')).toBeTruthy();
      expect(screen.getByRole('radio', { name: '30 days' }).getAttribute('data-state')).toBe('on');

      // Local midnights in Europe/Oslo: 29 days ago (summer time) to tomorrow.
      for (const path of ['', '/worlds', '/heatmap']) {
        const [params] = requests(fetchMock, `/api/v1/accounts/all/screentime${path}`);
        expect(params?.get('from')).toBe('2026-10-12T22:00:00.000Z');
        expect(params?.get('to')).toBe('2026-11-11T23:00:00.000Z');
      }
      const [screentime] = requests(fetchMock, '/api/v1/accounts/all/screentime');
      expect(screentime?.get('bucket')).toBe('day');
      expect(await screen.findByRole('img', { name: /per day, last 30 days/ })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for weeks for 90 days and changes the range with the toggle', async () => {
    const fixture = screentimeFixture as ScreentimeResponse;
    const weekly: ScreentimeResponse = {
      ...fixture,
      bucket: 'week',
      buckets: [
        {
          period: '2026-W45',
          start: '2026-11-01T23:00:00.000Z',
          activeSeconds: 10_500,
          afkSeconds: 900,
        },
      ],
    };
    const fetchMock = mockScreentimeApi('1', {
      '/api/v1/accounts/1/screentime': (url) =>
        echo(
          new URL(url, 'http://localhost').searchParams.get('bucket') === 'week' ? weekly : fixture,
        )(url),
    });
    const { router } = renderApp('/1/activity/screentime?range=90d');
    expect(await screen.findByRole('heading', { name: 'Play time per week' })).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/1/screentime')[0]?.get('bucket')).toBe('week');

    await userEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?range=7d');
    });
    expect(await screen.findByRole('heading', { name: 'Play time per day' })).toBeTruthy();
    expect(await screen.findByText(/vs previous 7 days/)).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/1/screentime').at(-1)?.get('bucket')).toBe('day');
  });

  it('starts a partial first week at the first day of the range', async () => {
    // Wednesday 11 November 2026: 90 days start on Friday 14 August (week 33).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    try {
      const weekly: ScreentimeResponse = {
        ...(screentimeFixture as ScreentimeResponse),
        bucket: 'week',
        buckets: [
          {
            period: '2026-W33',
            start: '2026-08-09T22:00:00.000Z',
            activeSeconds: 10_500,
            afkSeconds: 900,
          },
          {
            period: '2026-W34',
            start: '2026-08-16T22:00:00.000Z',
            activeSeconds: 0,
            afkSeconds: 0,
          },
        ],
      };
      mockScreentimeApi('1', { '/api/v1/accounts/1/screentime': echo(weekly) });
      renderApp('/1/activity/screentime?range=90d');
      await userEvent.click(await screen.findByRole('button', { name: 'Show as table' }));
      const table = screen.getByRole('table', { name: 'Play time per week, last 90 days' });
      const rows = within(table).getAllByRole('row');
      expect(rows[1]?.textContent).toContain('Week 33 · from Fri 14 Aug');
      expect(rows[2]?.textContent).toContain('Week 34 · from Mon 17 Aug');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to 30 days for an unknown range', async () => {
    mockScreentimeApi('1');
    renderApp('/1/activity/screentime?range=all');
    expect(await screen.findByText(/vs previous 30 days/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: '30 days' }).getAttribute('data-state')).toBe('on');
  });

  it('shows the bars as a table', async () => {
    mockScreentimeApi('1');
    renderApp('/1/activity/screentime');
    await userEvent.click(await screen.findByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table', { name: 'Play time per day, last 30 days' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(8); // header + 7 days
    expect(rows.at(-1)?.textContent).toContain('Sun 8 Nov');
    expect(rows.at(-1)?.textContent).toContain('1 h 55 min');
    expect(rows.at(-1)?.textContent).toContain('2 h 10 min');
    await userEvent.click(screen.getByRole('button', { name: 'Show as chart' }));
    expect(screen.queryByRole('table', { name: /Play time per day/ })).toBeNull();
  });

  it('shows world types with F2P as total minus members, locations and worlds', async () => {
    mockScreentimeApi('1');
    renderApp('/1/activity/screentime');

    const types = await screen.findByRole('list', { name: 'Play time per world type' });
    const typeLabels = within(types)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    // 3 h 1 min of play in the worlds; members 2 h 1 min, so 1 h F2P.
    expect(typeLabels).toEqual(['Members2 h 1 min', 'Free-to-play1 h']);

    const locations = screen.getByRole('list', { name: 'Play time per world location' });
    expect(
      within(locations)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Germany2 h', 'United Kingdom1 h', 'Unknown1 min']);

    // Mobile: worlds as rows with type, location and activity under the number.
    const worlds = screen.getByRole('list', { name: 'Play time per world' });
    expect(
      within(worlds)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('World 420Members') as string,
      expect.stringContaining('World 301Free-to-play · United Kingdom') as string,
      expect.stringContaining('World 999Members · Unknown') as string,
    ]);
  });

  it('shows the worlds as a table on PC', async () => {
    stubDesktop();
    mockScreentimeApi('1');
    renderApp('/1/activity/screentime');
    const table = await screen.findByRole('table', { name: 'Play time per world' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('420Members') as string,
      expect.stringContaining('301Free-to-playUnited Kingdom–') as string,
      expect.stringContaining('999MembersUnknown–') as string,
    ]);
  });

  it('shows the day and hour with most play time, summed, the earliest on a tie', async () => {
    // Saturday 19:00 1 h; Sunday 18:00 and 19:00 1 h each. Sunday has 2 h;
    // 19:00 has 2 h over both days, 18:00 only 1 h.
    mockScreentimeApi('1');
    stubDesktop();
    renderApp('/1/activity/screentime');
    expect(await screen.findByText('Sunday')).toBeTruthy();
    expect(screen.getByText('day with most play time · 2 h')).toBeTruthy();
    expect(screen.getByText('19:00')).toBeTruthy();
    expect(screen.getByText('hour with most play time · 2 h')).toBeTruthy();
  });

  it('shows the two-hour block with most play time on mobile, as the grid shows it', async () => {
    // Blocks: Sat 18–20 1 h; Sun 18–20 2 h. Summed over days, 18:00–20:00 has 3 h.
    mockScreentimeApi('1');
    renderApp('/1/activity/screentime');
    expect(await screen.findByText('18:00–20:00')).toBeTruthy();
    expect(screen.getByText('2 hours with most play time · 3 h')).toBeTruthy();
  });

  it('shows the heatmap in two-hour blocks on mobile', async () => {
    mockScreentimeApi('1');
    renderApp('/1/activity/screentime');
    const grid = await screen.findByRole('img', {
      name: 'Play time by weekday and hour, in two-hour blocks. Day with most play time: Sunday, 2 h. 2 hours with most play time: 18:00–20:00, 3 h.',
    });
    expect(grid.style.gridTemplateColumns).toBe('30px repeat(12, 18px)');
    expect(screen.getByText('2-hour blocks')).toBeTruthy();
  });

  it('shows the heatmap in fixed 16 px hours on PC', async () => {
    stubDesktop();
    mockScreentimeApi('1');
    renderApp('/1/activity/screentime');
    const grid = await screen.findByRole('img', {
      name: 'Play time by weekday and hour. Day with most play time: Sunday, 2 h. Hour with most play time: 19:00, 2 h.',
    });
    expect(grid.style.gridTemplateColumns).toBe('26px repeat(24, 16px)');
    expect(screen.getByText('Local time (Europe/Oslo)')).toBeTruthy();
    // The card is never narrower than the grid: 482 px plus padding and border.
    const card = grid.closest('section');
    expect(card?.style.getPropertyValue('--heatmap-card')).toBe('532px');
    expect(card?.className).toContain('desk:min-w-(--heatmap-card)');
  });

  it('shows all worlds on request', async () => {
    const many: ScreentimeWorldsResponse = {
      ...(worldsFixture as ScreentimeWorldsResponse),
      worlds: Array.from({ length: 12 }, (_, index) => ({
        world: 301 + index,
        seconds: 600 - index * 10,
        activeSeconds: 600 - index * 10,
        afkSeconds: 0,
        worldTypes: [],
        location: null,
        activity: null,
      })),
    };
    mockScreentimeApi('1', { '/api/v1/accounts/1/screentime/worlds': echo(many) });
    stubDesktop();
    renderApp('/1/activity/screentime');
    const table = await screen.findByRole('table', { name: 'Play time per world' });
    // Six rows and the header.
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    await userEvent.click(screen.getByRole('button', { name: 'Show all (12)' }));
    expect(within(table).getAllByRole('row')).toHaveLength(13);
  });

  it('invites to play when there is no play time', async () => {
    const empty: ScreentimeResponse = {
      ...(screentimeFixture as ScreentimeResponse),
      buckets: screentimeFixture.buckets.map((bucket) => ({
        ...bucket,
        activeSeconds: 0,
        afkSeconds: 0,
      })),
      totals: { playedSeconds: 0, activeSeconds: 0, afkSeconds: 0 },
      previous: null,
      stats: {
        sessionCount: 0,
        averagePerDaySeconds: 0,
        averageSessionSeconds: 0,
        longestSessionSeconds: 0,
        afkShare: 0,
      },
    };
    mockScreentimeApi('1', {
      '/api/v1/accounts/1/screentime': echo(empty),
      '/api/v1/accounts/1/screentime/worlds': echo({
        ...worldsFixture,
        worlds: [],
        worldTypes: [],
        locations: [],
      }),
      '/api/v1/accounts/1/screentime/heatmap': echo({
        ...heatmapFixture,
        cells: [],
      }),
    });
    renderApp('/1/activity/screentime?range=7d');
    await waitFor(() => {
      expect(screen.getAllByText('No play time in the last 7 days.')).toHaveLength(4);
    });
    // No play time before the range: nothing to compare with.
    expect(screen.queryByText(/vs previous 7 days/)).toBeNull();
    expect(screen.queryByText(/longest/)).toBeNull();
    // Nothing to show as a table.
    expect(screen.queryByRole('button', { name: 'Show as table' })).toBeNull();
  });

  it('shows Retry per card when the API fails', async () => {
    mockScreentimeApi('1', {
      '/api/v1/accounts/1/screentime': SERVER_ERROR,
      '/api/v1/accounts/1/screentime/worlds': SERVER_ERROR,
    });
    renderApp('/1/activity/screentime');
    // Numbers and bars (screentime), types and worlds (worlds); the heatmap still works.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(4);
    });
    expect(
      await screen.findByRole('img', { name: /Day with most play time: Sunday/ }),
    ).toBeTruthy();
  });

  it('is a sub-tab of Activity', async () => {
    mockScreentimeApi('1');
    renderApp('/1/activity/screentime');
    const tabs = await screen.findByRole('navigation', { name: 'Activity views' });
    const tab = within(tabs).getByRole('link', { name: 'Screen time' });
    expect(tab.getAttribute('href')).toBe('/1/activity/screentime');
    expect(tab.getAttribute('aria-current')).toBe('page');
  });
});
