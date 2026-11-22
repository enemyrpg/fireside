import type { WeeklyResponse } from '@fireside/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import accountsFixture from '../../../shared/fixtures/api/accounts-response/valid/accounts.json';
import screentimeFixture from '../../../shared/fixtures/api/screentime-response/valid/by-day.json';
import fullWeek from '../../../shared/fixtures/api/weekly-response/valid/complete-week.json';
import completeWeek from '../../../shared/fixtures/api/weekly-response/valid/complete-week-without-new-sections.json';
import emptyWeek from '../../../shared/fixtures/api/weekly-response/valid/empty-current-week.json';
import { mockApi, renderApp, stubDesktop, stubWide, type MockAnswer } from '@/test/render-app';

// "Today" is Wednesday 11 November 2026 (2026-W46) in Europe/Oslo (the health
// fixture). Both fixture accounts were first seen on Sunday 1 November
// (2026-W44), so the archive has W46, W45 and W44.
//
// The complete week (W45) has 10 h of play (8 h 20 min active, 1 h 40 min AFK)
// against 7 h 47 min the week before. The screen time fixture is the same week
// but with other totals (3 h 10 min) and 3 sessions, so the tiles must come
// from the weekly response, not from screen time.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SERVER_ERROR = () =>
  json({ error: { code: 'INTERNAL_ERROR', message: 'Boom', details: [] } }, 500);

const BAD_WEEK = () =>
  json(
    {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: [{ path: 'query.week', message: 'This year has no week 53' }],
      },
    },
    400,
  );

/** Answers `weekly?week=` from a map of weeks; others get an empty week. */
function weeklyAnswer(weeks: Record<string, WeeklyResponse>): (url: string) => Response {
  return (url) => {
    const week = new URL(url, 'http://localhost').searchParams.get('week') ?? '';
    if (week === '2025-W53') return BAD_WEEK();
    return json(weeks[week] ?? { ...emptyWeek, week, complete: true });
  };
}

const COMPLETE = completeWeek as WeeklyResponse;
/** The same week with every section: a pet, the bank, collection log and quests. */
const FULL = fullWeek as WeeklyResponse;
const CURRENT = emptyWeek as WeeklyResponse;

function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing fixture data');
  return value;
}

const PLAYTIME = defined(COMPLETE.playtime);
const DROP = defined(COMPLETE.loot?.topDrops[0]);

function mockWeeklyApi(
  scope: string,
  weeks: Record<string, WeeklyResponse> = { '2026-W45': COMPLETE, '2026-W46': CURRENT },
  answers: Record<string, MockAnswer> = {},
) {
  return mockApi({
    [`/api/v1/accounts/${scope}/weekly`]: weeklyAnswer(weeks),
    [`/api/v1/accounts/${scope}/screentime`]: { body: screentimeFixture },
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

function archive() {
  return within(screen.getByRole('region', { name: 'Archive' }));
}

describe('Weekly summary', () => {
  beforeEach(() => {
    // Only Date is faked, so Testing Library's timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    // PC: the archive in its own column (on mobile it is in the week picker).
    stubDesktop();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows every section of a complete week, with tiles from the weekly numbers', async () => {
    const fetchMock = mockWeeklyApi('1');
    renderApp('/1/activity/weekly/2026-W45');

    expect(await screen.findByRole('heading', { level: 1, name: 'Activity' })).toBeTruthy();
    // The big numbers on top: played with the change, XP, loot and kills.
    const strip = within(await screen.findByRole('region', { name: 'Week summary' }));
    expect(await strip.findByText('10 h')).toBeTruthy();
    expect(strip.getByText('▲ 2 h 13 min (+29%) vs last week')).toBeTruthy();
    expect(strip.getByText('1.5M')).toBeTruthy();
    expect(strip.getByText('XP · 4 levels')).toBeTruthy();
    expect(strip.getByText('18')).toBeTruthy();
    expect(strip.getByText('kills · 1 boss')).toBeTruthy();
    // Play time: plain numbers for active, AFK, sessions and world; the total is in the strip.
    expect(screen.getByText('8 h 20 min')).toBeTruthy();
    expect(screen.getByText('1 h 40 min')).toBeTruthy();
    expect(screen.getByText('AFK · 17%')).toBeTruthy();
    expect(screen.getByText('most played')).toBeTruthy();
    // Compact bars, with "Show as table" under them.
    expect(await screen.findByRole('button', { name: 'Show as table' })).toBeTruthy();
    // Loot rows: source and date on one line.
    expect(screen.getByText('Vorkath · Sun 8 Nov')).toBeTruthy();
    expect(screen.getByText('World 420')).toBeTruthy();
    // Screen time's own total never shows; its session count does.
    expect(screen.queryByText('3 h 10 min')).toBeNull();
    expect(await screen.findByText('3')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Active and AFK play time per day/ })).toBeTruthy();

    expect(screen.getByText('Mon 2 Nov – Sun 8 Nov')).toBeTruthy();
    expect(screen.queryByText('In progress')).toBeNull();
    expect(screen.getByText('1,500,000 XP · 4 levels gained')).toBeTruthy();
    expect(screen.getByText('Slayer')).toBeTruthy();
    expect(screen.getByText('Draconic visage')).toBeTruthy();
    // The KC row (the drop's source is on the line with its date, checked above).
    expect(screen.getAllByText('Vorkath')).toHaveLength(1);
    expect(screen.getByText('18 kills · 1 boss')).toBeTruthy();
    // Placeholder icons: Slayer's abbreviation and Vorkath's initials.
    const skills = screen.getByRole('list', { name: 'Top skills by XP gained' });
    expect(within(skills).getByText('Sl')).toBeTruthy();
    const bosses = screen.getByRole('list', { name: 'Kill count gained per boss' });
    expect(within(bosses).getByText('Vo')).toBeTruthy();

    // The week's own `[start, end)`, per day.
    const [params] = requests(fetchMock, '/api/v1/accounts/1/screentime');
    expect(params?.get('from')).toBe(COMPLETE.start);
    expect(params?.get('to')).toBe(COMPLETE.end);
    expect(params?.get('bucket')).toBe('day');
  });

  it('asks for the current week without a week in the URL and says it is in progress', async () => {
    const fetchMock = mockWeeklyApi('all');
    renderApp('/all/activity/weekly');

    expect(await screen.findByText('No play time this week.')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    // In the top bar and in the archive.
    expect(screen.getAllByText('2026 · week 46')).toHaveLength(2);
    expect(requests(fetchMock, '/api/v1/accounts/all/weekly')[0]?.get('week')).toBe('2026-W46');
    // No play time: no chart and no screen time request.
    expect(screen.queryByRole('heading', { name: 'Play time' })).toBeNull();
    expect(requests(fetchMock, '/api/v1/accounts/all/screentime')).toHaveLength(0);
  });

  it('hides null sections and shows player loot without a name', async () => {
    const week: WeeklyResponse = {
      ...COMPLETE,
      playtime: null,
      xp: null,
      kc: null,
      loot: {
        geValue: 50_000,
        topDrops: [
          {
            ...DROP,
            source: { type: 'PLAYER', name: null },
            name: 'Coins',
            itemId: 995,
            quantity: 50_000,
            gePriceEach: 1,
            geValue: 50_000,
            haPriceEach: 1,
            haValue: 50_000,
          },
        ],
      },
    };
    mockWeeklyApi('1', { '2026-W45': week });
    renderApp('/1/activity/weekly/2026-W45');

    expect(await screen.findByText(/^Player · /)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Play time' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'XP' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Kill count' })).toBeNull();
    expect(screen.queryByText('No play time this week.')).toBeNull();
  });

  it('shows the new pet, the bank, the collection log and quests in the design’s order', async () => {
    mockWeeklyApi('1', { '2026-W45': FULL });
    renderApp('/1/activity/weekly/2026-W45');

    // Pets: one line above everything else.
    const pet = within(await screen.findByRole('region', { name: 'New pet: Vorki' }));
    expect(pet.getByText('Vorkath · 1,204 KC')).toBeTruthy();
    expect(pet.getByText('Thu 5 Nov')).toBeTruthy();
    expect(pet.queryByText('Unconfirmed')).toBeNull();
    expect(pet.getByRole('link', { name: 'Pets →' }).getAttribute('href')).toBe(
      '/1/collections/pets',
    );

    // Bank: the change, the end and the start of a finished week, and a line per day.
    expect(screen.getByText('▲ 8.63M gp (+0.4%)')).toBeTruthy();
    expect(screen.getByText('net worth at the end of the week')).toBeTruthy();
    expect(screen.getByText('at the start of the week')).toBeTruthy();
    // The big number with a smaller "gp", and the start value.
    expect(screen.getByText('2.42B')).toBeTruthy();
    expect(screen.getByText('2.41B gp')).toBeTruthy();
    // Under the area line: the first day and the last (a finished week).
    expect(screen.getByText('Sun')).toBeTruthy();
    expect(
      screen.getByRole('img', {
        name: 'Net worth per day, 2026 · week 45: 2.41B gp to 2.42B gp',
      }),
    ).toBeTruthy();

    // Collection log: the summary and the newest items with page and day.
    expect(screen.getByText('3 new items · 712 of 1,568')).toBeTruthy();
    const items = within(screen.getByRole('list', { name: 'New collection log items' }));
    expect(items.getAllByRole('listitem')).toHaveLength(3);
    expect(items.getByText('Skeletal visage')).toBeTruthy();
    // The sync that found it, not the drop.
    expect(items.getByText(/ · ~Tue 3 Nov$/)).toBeTruthy();
    expect(screen.getByText('~ is the sync that found it, not the drop.')).toBeTruthy();

    // Quests & diaries: newest first, the diary tier with its badge.
    expect(screen.getByText('1 quest · 1 diary tier · +2 quest points')).toBeTruthy();
    const done = within(screen.getByRole('list', { name: 'Completed quests and diary tiers' }));
    expect(done.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'Dragon Slayer IIFri 6 Nov',
      'Kandarin diaryHardWed 4 Nov',
    ]);

    // The order in docs/design.md#weekly.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Play time',
      'Bank',
      'XP',
      'Loot',
      'Kill count',
      'Collection log',
      'Quests & diaries',
      'Archive',
    ]);
    const all = screen.getAllByRole('region').map((card) => card.getAttribute('aria-label'));
    // The week's numbers, then the pet above every section.
    expect(all.slice(0, 2)).toEqual(['Week summary', 'New pet: Vorki']);
  });

  it('stacks two columns on wide screens: left column first, then right, in the DOM', async () => {
    stubWide();
    mockWeeklyApi('1', { '2026-W45': FULL });
    renderApp('/1/activity/weekly/2026-W45');
    await screen.findByRole('heading', { name: 'Collection log' });
    // The order a keyboard or screen reader goes through them.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Play time',
      'XP',
      'Kill count',
      'Quests & diaries',
      'Bank',
      'Loot',
      'Collection log',
      'Archive',
    ]);
    const column = (name: string) =>
      screen.getByRole('heading', { name }).closest('[data-column]')?.getAttribute('data-column');
    expect(['Play time', 'XP', 'Kill count', 'Quests & diaries'].map(column)).toEqual([
      'left',
      'left',
      'left',
      'left',
    ]);
    expect(['Bank', 'Loot', 'Collection log'].map(column)).toEqual(['right', 'right', 'right']);
    // The pet stays above both columns.
    expect(
      screen.getByRole('region', { name: 'New pet: Vorki' }).closest('[data-column]'),
    ).toBeNull();
  });

  it('leaves a column shorter when its sections are null', async () => {
    stubWide();
    mockWeeklyApi('1', { '2026-W45': { ...FULL, xp: null, kc: null, bank: null } });
    renderApp('/1/activity/weekly/2026-W45');
    await screen.findByRole('heading', { name: 'Collection log' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Play time',
      'Quests & diaries',
      'Loot',
      'Collection log',
      'Archive',
    ]);
  });

  it('hides the new sections that are null, and the change without a start value', async () => {
    const week: WeeklyResponse = {
      ...COMPLETE,
      bank: { startGeValue: null, endGeValue: 5000, days: [{ date: '2026-11-08', geValue: 5000 }] },
    };
    mockWeeklyApi('1', { '2026-W45': week });
    renderApp('/1/activity/weekly/2026-W45');

    expect(await screen.findByText('net worth at the end of the week')).toBeTruthy();
    expect(screen.queryByText('at the start of the week')).toBeNull();
    expect(screen.queryByText(/[▲▼] .* gp/)).toBeNull();
    expect(screen.queryByText('No change')).toBeNull();
    // One day is no trend.
    expect(screen.queryByRole('img', { name: /Net worth per day/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /New pet/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Collection log' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Quests & diaries' })).toBeNull();
  });

  it('shows a week with only a bank, as now while it is in progress', async () => {
    const week: WeeklyResponse = {
      ...CURRENT,
      bank: {
        startGeValue: 5000,
        endGeValue: 5000,
        days: [
          { date: '2026-11-09', geValue: 5000 },
          { date: '2026-11-10', geValue: 5000 },
        ],
      },
    };
    mockWeeklyApi('1', { '2026-W46': week });
    renderApp('/1/activity/weekly');

    expect(await screen.findByText('net worth now')).toBeTruthy();
    expect(screen.getByText('No change')).toBeTruthy();
    expect(screen.queryByText('No play time this week.')).toBeNull();
  });

  it('says whose pet, item and quest it is for all accounts, and marks an unconfirmed pet', async () => {
    const pets = defined(FULL.pets).pets.map((pet) => ({ ...pet, accountId: 2, confirmed: false }));
    mockWeeklyApi('all', { '2026-W45': { ...FULL, pets: { pets } } });
    renderApp('/all/activity/weekly/2026-W45');

    const pet = within(await screen.findByRole('region', { name: 'New pet: Vorki' }));
    expect(await pet.findByText('Alt')).toBeTruthy();
    expect(pet.getByText('Unconfirmed')).toBeTruthy();
    expect(pet.getByRole('link', { name: 'Pets →' }).getAttribute('href')).toBe(
      '/all/collections/pets',
    );
    const items = within(screen.getByRole('list', { name: 'New collection log items' }));
    expect(items.getAllByText('Test Main')).toHaveLength(3);
    const done = within(screen.getByRole('list', { name: 'Completed quests and diary tiers' }));
    expect(done.getAllByText('Test Main')).toHaveLength(2);
  });

  it('has no comparison against a week without play time', async () => {
    mockWeeklyApi('1', {
      '2026-W45': {
        ...COMPLETE,
        playtime: { ...PLAYTIME, previousWeekPlayedSeconds: 0 },
      },
    });
    renderApp('/1/activity/weekly/2026-W45');
    expect(await screen.findByText('No play time last week')).toBeTruthy();
  });

  it('moves between weeks with the arrows and the archive', async () => {
    const user = userEvent.setup();
    mockWeeklyApi('1');
    const { router } = renderApp('/1/activity/weekly/2026-W45');
    await screen.findByText('10 h');

    // W45 lies between W44 (first seen) and W46 (now).
    const next = screen.getByRole('link', { name: 'Next week' });
    expect(next.getAttribute('href')).toBe('/1/activity/weekly');
    expect(screen.getByRole('link', { name: 'Previous week' }).getAttribute('href')).toBe(
      '/1/activity/weekly/2026-W44',
    );

    const rows = archive().getAllByRole('link');
    expect(rows.map((row) => row.textContent)).toEqual([
      '2026 · week 469 Nov – 15 Nov',
      '2026 · week 452 Nov – 8 Nov',
      '2026 · week 4426 Oct – 1 Nov',
    ]);
    expect(rows[1]?.getAttribute('aria-current')).toBe('page');

    await user.click(defined(rows[2]));
    expect(router.state.location.pathname).toBe('/1/activity/weekly/2026-W44');
    // The oldest week has no earlier one.
    expect(
      (await screen.findByRole('button', { name: 'Previous week' })).hasAttribute('disabled'),
    ).toBe(true);

    await user.click(screen.getByRole('link', { name: 'Next week' }));
    await user.click(screen.getByRole('link', { name: 'Next week' }));
    expect(router.state.location.pathname).toBe('/1/activity/weekly');
    expect(screen.getByRole('button', { name: 'Next week' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows the full-page not found for a week that does not exist', async () => {
    mockWeeklyApi('1');
    renderApp('/1/activity/weekly/2025-W53');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
  });

  it.each(['foo', '2026-46', '2026-W54'])(
    'shows not found for the malformed week %s without asking the server',
    async (week) => {
      const fetchMock = mockWeeklyApi('1');
      renderApp(`/1/activity/weekly/${week}`);
      expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
      expect(screen.getByText("That week doesn't exist.")).toBeTruthy();
      expect(requests(fetchMock, '/api/v1/accounts/1/weekly')).toHaveLength(0);
    },
  );

  it('lists a week far back in the archive when opened directly', async () => {
    // Accounts first seen in May: W20 is the 27th week back from W46, past the first 12.
    const accounts = {
      accounts: accountsFixture.accounts.map((account) => ({
        ...account,
        firstSeenAt: '2026-05-01T12:00:00.000Z',
      })),
    };
    mockWeeklyApi('1', undefined, { '/api/v1/accounts': { body: accounts } });
    renderApp('/1/activity/weekly/2026-W20');

    await screen.findByRole('region', { name: 'Archive' });
    const marked = await archive().findByRole('link', { current: 'page' });
    expect(marked.textContent).toContain('2026 · week 20');
    expect(archive().getAllByRole('link')).toHaveLength(27);
  });

  it('offers a retry when the week fails to load', async () => {
    const user = userEvent.setup();
    let fail = true;
    mockWeeklyApi('1', undefined, {
      '/api/v1/accounts/1/weekly': (url) =>
        fail ? SERVER_ERROR() : weeklyAnswer({ '2026-W45': COMPLETE })(url),
    });
    renderApp('/1/activity/weekly/2026-W45');

    const retry = await screen.findByRole('button', { name: 'Retry' }, { timeout: 5000 });
    // The archive keeps working.
    expect(archive().getAllByRole('link')).toHaveLength(3);
    fail = false;
    await user.click(retry);
    expect(await screen.findByText('10 h')).toBeTruthy();
  });

  it('keeps the week summary when a refetch fails and the week stays on screen', async () => {
    let fail = false;
    mockWeeklyApi('1', undefined, {
      '/api/v1/accounts/1/weekly': (url) =>
        fail ? SERVER_ERROR() : weeklyAnswer({ '2026-W45': COMPLETE })(url),
    });
    const { queryClient } = renderApp('/1/activity/weekly/2026-W45');
    const strip = await screen.findByRole('region', { name: 'Week summary' });
    expect(await within(strip).findByText('10 h')).toBeTruthy();

    fail = true;
    await act(() => queryClient.refetchQueries({ queryKey: ['weekly'] }));
    await waitFor(() => {
      expect(queryClient.getQueryState(['weekly', 1, { week: '2026-W45' }])?.status).toBe('error');
    });
    // The sections stay, and so do the numbers on top and the dates.
    expect(screen.getByRole('heading', { name: 'Play time' })).toBeTruthy();
    const kept = screen.getByRole('region', { name: 'Week summary' });
    expect(within(kept).getByText('10 h')).toBeTruthy();
    expect(screen.getByText('Mon 2 Nov – Sun 8 Nov')).toBeTruthy();
  });

  it('keeps the weekly tiles when the day chart fails', async () => {
    mockWeeklyApi('1', undefined, { '/api/v1/accounts/1/screentime': () => SERVER_ERROR() });
    renderApp('/1/activity/weekly/2026-W45');
    expect(await screen.findByRole('button', { name: 'Retry' }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('10 h')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show as table' })).toBeNull();
    await waitFor(() => {
      expect(screen.getByText('World 420')).toBeTruthy();
    });
  });
});

describe('Weekly summary on mobile', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has the archive in the week picker, not in a column, and a new week goes in the history', async () => {
    const user = userEvent.setup();
    mockWeeklyApi('1');
    const { router } = renderApp('/1/activity/weekly/2026-W45');
    await screen.findByRole('region', { name: 'Week summary' });
    expect(screen.queryByRole('region', { name: 'Archive' })).toBeNull();

    const picker = screen.getByRole('combobox', { name: 'Week' });
    expect(picker.textContent).toContain('2026 · week 45');
    await user.click(picker);
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      '2026 · week 469 Nov – 15 Nov',
      '2026 · week 452 Nov – 8 Nov',
      '2026 · week 4426 Oct – 1 Nov',
    ]);
    await user.click(defined(options[2]));
    expect(router.state.location.pathname).toBe('/1/activity/weekly/2026-W44');
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Week' }).textContent).toContain(
        '2026 · week 44',
      );
    });
    // Pushed: Back returns to the week before.
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/1/activity/weekly/2026-W45');
  });
});
