import type { GainsResponse, XpResponse } from '@fireside/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import gainsFixture from '../../../shared/fixtures/api/gains-response/valid/week.json';
import xpFixture from '../../../shared/fixtures/api/xp-response/valid/slayer-by-day.json';
import { mockApi, renderApp, stubDesktop, type MockAnswer } from '@/test/render-app';
import { XP_CHART_EMPTY } from './XpPage';

// The accounts fixture has accounts 1 ("Test Main") and 2 ("Alt"). The gains
// fixture is a week with Slayer +346,332 (89 -> 90) and Hitpoints +20,000.

/** Gains with a range of the right length for the requested period. */
const RANGES: Record<string, { from: string; to: string }> = {
  day: { from: '2026-11-08T23:00:00.000Z', to: '2026-11-09T23:00:00.000Z' },
  week: { from: gainsFixture.from, to: gainsFixture.to },
  month: { from: '2026-10-31T23:00:00.000Z', to: '2026-11-30T23:00:00.000Z' },
  year: { from: '2025-12-31T23:00:00.000Z', to: '2026-12-31T23:00:00.000Z' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function gainsAnswer(body: Omit<GainsResponse, 'from' | 'to'> = gainsFixture): MockAnswer {
  return (url) => {
    const period = new URL(url, 'http://localhost').searchParams.get('period') ?? 'week';
    return json({ ...body, ...RANGES[period] });
  };
}

function xpAnswer(body: XpResponse = xpFixture as XpResponse): MockAnswer {
  return (url) => {
    const skill = new URL(url, 'http://localhost').searchParams.get('skill');
    return json({ ...body, skill });
  };
}

function mockXpApi(scope: string, answers: Record<string, MockAnswer> = {}) {
  return mockApi({
    [`/api/v1/accounts/${scope}/gains`]: gainsAnswer(),
    [`/api/v1/accounts/${scope}/xp`]: xpAnswer(),
    ...answers,
  });
}

/** Query parameters of every request to `path`. */
function requests(fetchMock: ReturnType<typeof mockApi>, path: string): URLSearchParams[] {
  return fetchMock.mock.calls
    .map(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new URL(url, 'http://localhost');
    })
    .filter((url) => url.pathname === path)
    .map((url) => url.searchParams);
}

async function gainsTable() {
  return screen.findByRole('table', { name: /^XP gained .* per skill$/ });
}

function headers(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent);
}

function rowTexts(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    );
}

/** The fixture week plus Attack and Magic without XP, for the grid under the table. */
const WITH_UNTRAINED = {
  ...gainsFixture,
  skills: [
    ...gainsFixture.skills,
    {
      skill: 'MAGIC',
      startXp: 1_000,
      endXp: 1_000,
      xpGained: 0,
      startLevel: 9,
      endLevel: 9,
      levelsGained: 0,
    },
    {
      skill: 'ATTACK',
      startXp: 500,
      endXp: 500,
      xpGained: 0,
      startLevel: 5,
      endLevel: 5,
      levelsGained: 0,
    },
  ],
};

describe('XP & gains', () => {
  // The gains table is the PC layout; mobile has a list (tested below).
  beforeEach(() => {
    stubDesktop();
  });

  it('shows the week by default with three big numbers and gains for all accounts', async () => {
    const fetchMock = mockXpApi('all');
    renderApp('/all/progress/xp');

    expect(await screen.findByRole('heading', { level: 1, name: 'Progress' })).toBeTruthy();
    expect(await screen.findByText('XP gained since Monday')).toBeTruthy();
    expect(screen.getByText('366K')).toBeTruthy();
    expect(screen.getByText('of 24 skills trained')).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/all/gains')[0]?.get('period')).toBe('week');

    const table = await gainsTable();
    // Levels are summed over accounts for `all`, so there is no Level column.
    expect(headers(table)).not.toContain('Level');
    const rows = rowTexts(table);
    expect(rows[0]?.[0]).toContain('Overall');
    expect(rows[0]).toContain('+366,332');
    expect(rows[1]?.[0]).toContain('Slayer');
    expect(rows[1]).toContain('+346,332');
    expect(rows[2]?.[0]).toContain('Hitpoints');
    expect(rows[2]).toContain('+20,000');
  });

  it('shows the level only for a single account, with the total level on Overall', async () => {
    mockXpApi('1');
    renderApp('/1/progress/xp');
    const table = await gainsTable();
    expect(headers(table)).toContain('Level');
    const [overall, slayer] = rowTexts(table);
    expect(overall).toContain('189');
    // Level 90, one level gained.
    expect(slayer).toContain('90↑1');
  });

  it('lists only skills with XP in the table and the rest in a grid that charts them', async () => {
    mockXpApi('1', { '/api/v1/accounts/1/gains': gainsAnswer(WITH_UNTRAINED) });
    const { router } = renderApp('/1/progress/xp');
    const rows = rowTexts(await gainsTable());
    // The first cell has the icon's abbreviation before the name.
    expect(rows.map((row) => row[0])).toEqual(['AllOverall', 'SlSlayer', 'HPHitpoints']);

    expect(screen.getByRole('heading', { name: 'No XP this week · 2 skills' })).toBeTruthy();
    const grid = screen.getByRole('list', { name: 'No XP this week · 2 skills' });
    // Skill order, with the level for one account.
    expect(
      within(grid)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['AtAttack5', 'MaMagic9']);
    await userEvent.click(within(grid).getByRole('button', { name: /Magic/ }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?skill=MAGIC');
    });
    expect(within(grid).getByRole('button', { name: /Magic/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('names the grid after the period on screen', async () => {
    mockXpApi('all', { '/api/v1/accounts/all/gains': gainsAnswer(WITH_UNTRAINED) });
    renderApp('/all/progress/xp?period=month');
    const grid = await screen.findByRole('list', { name: 'No XP this month · 2 skills' });
    // Levels are summed for `all`, so the grid has none.
    expect(
      within(grid)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['AtAttack', 'MaMagic']);
  });

  it('takes the period from the URL and changes it with the toggle', async () => {
    const fetchMock = mockXpApi('1');
    const { router } = renderApp('/1/progress/xp?period=day');
    expect(await screen.findByText('XP gained today')).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/1/gains')[0]?.get('period')).toBe('day');

    await userEvent.click(screen.getByRole('radio', { name: 'Month' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?period=month');
    });
    expect(await screen.findByText('XP gained this month')).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/1/gains').at(-1)?.get('period')).toBe('month');
  });

  it('falls back to the week for an unknown period', async () => {
    const fetchMock = mockXpApi('1');
    renderApp('/1/progress/xp?period=decade');
    expect(await screen.findByText('XP gained since Monday')).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/1/gains')[0]?.get('period')).toBe('week');
  });

  it('charts the chosen period by day, overall by default, and follows a new period', async () => {
    // Only Date is faked, so Testing Library's timers keep working. Wednesday 11 November 2026.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    try {
      const fetchMock = mockXpApi('1');
      renderApp('/1/progress/xp');
      expect(
        await screen.findByRole('img', { name: 'XP over time for Overall, since Monday' }),
      ).toBeTruthy();
      const [week] = requests(fetchMock, '/api/v1/accounts/1/xp');
      expect(week?.get('bucket')).toBe('day');
      expect(week?.get('skill')).toBeNull();
      expect(week?.get('to')).toBeNull();
      // Monday 9 November, local midnight in the health fixture's zone (Europe/Oslo).
      expect(week?.get('from')).toBe('2026-11-08T23:00:00.000Z');

      const fromFor = async (label: string, name: string) => {
        await userEvent.click(screen.getByRole('radio', { name: label }));
        expect(await screen.findByRole('img', { name })).toBeTruthy();
        return requests(fetchMock, '/api/v1/accounts/1/xp').at(-1)?.get('from');
      };
      // No hourly data, so Day shows the last 7 days.
      expect(await fromFor('Day', 'XP over time for Overall, last 7 days')).toBe(
        '2026-11-04T23:00:00.000Z',
      );
      expect(await fromFor('Month', 'XP over time for Overall, this month')).toBe(
        '2026-10-31T23:00:00.000Z',
      );
      expect(await fromFor('Year', 'XP over time for Overall, this year')).toBe(
        '2025-12-31T23:00:00.000Z',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the chosen skill from the URL and keeps a new choice there', async () => {
    const fetchMock = mockXpApi('1');
    const { router } = renderApp('/1/progress/xp?period=month&skill=SLAYER');
    expect(
      await screen.findByRole('img', { name: 'XP over time for Slayer, this month' }),
    ).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/1/xp')[0]?.get('skill')).toBe('SLAYER');

    await userEvent.click(screen.getByRole('combobox', { name: 'Skill' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Overall' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?period=month');
    });
    expect(await screen.findByRole('img', { name: /^XP over time for Overall/ })).toBeTruthy();
  });

  it('gives Overall a skill icon with the key OVERALL, like the skill rows', async () => {
    mockXpApi('all');
    renderApp('/all/progress/xp');
    const table = await gainsTable();
    const overall = within(table).getByRole('button', { name: 'Overall' });
    const icon = overall.querySelector('[data-icon-status]');
    if (!(icon instanceof HTMLElement)) throw new Error('No icon on the Overall row');
    // The 24 px box with the abbreviation until the real icon has loaded.
    expect(icon.className).toContain('size-6');
    expect(icon.textContent).toBe('All');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.querySelector('img')?.getAttribute('src')).toBe('/api/v1/skills/OVERALL/icon');

    const slayer = within(table).getByRole('button', { name: /Slayer/ });
    expect(slayer.querySelector('img')?.getAttribute('src')).toBe('/api/v1/skills/SLAYER/icon');
  });

  it('charts a skill when its row in the gains table is clicked', async () => {
    const fetchMock = mockXpApi('1');
    const { router } = renderApp('/1/progress/xp?period=month');
    const table = await gainsTable();
    const overall = within(table).getByRole('button', { name: 'Overall' });
    expect(overall.getAttribute('aria-pressed')).toBe('true');

    const slayer = within(table).getByRole('button', { name: /Slayer/ });
    await userEvent.click(slayer);
    await waitFor(() => {
      expect(router.state.location.search).toBe('?period=month&skill=SLAYER');
    });
    expect(
      await screen.findByRole('img', { name: 'XP over time for Slayer, this month' }),
    ).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/1/xp').at(-1)?.get('skill')).toBe('SLAYER');
    expect(
      within(table)
        .getByRole('button', { name: /Slayer/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(overall.getAttribute('aria-pressed')).toBe('false');

    // A click anywhere on the row works too; Overall clears the skill.
    const overallRow = overall.closest('tr');
    if (!overallRow) throw new Error('No Overall row');
    const lastCell = within(overallRow).getAllByRole('cell').at(-1);
    if (!lastCell) throw new Error('No cells in the Overall row');
    await userEvent.click(lastCell);
    await waitFor(() => {
      expect(router.state.location.search).toBe('?period=month');
    });
  });

  it('ignores a skill in the URL that is not a skill name', async () => {
    const fetchMock = mockXpApi('1');
    renderApp('/1/progress/xp?skill=drop%20table');
    expect(await screen.findByRole('img', { name: /^XP over time for Overall/ })).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/1/xp')[0]?.get('skill')).toBeNull();
  });

  it('invites instead of showing empty cards for an account without data', async () => {
    mockXpApi('2', {
      '/api/v1/accounts/2/gains': gainsAnswer({
        total: { xpGained: 0, levelsGained: 0 },
        skills: [],
      }),
      '/api/v1/accounts/2/xp': xpAnswer({ skill: null, bucket: 'day', points: [] }),
    });
    renderApp('/2/progress/xp');
    expect(await screen.findByText('No XP gained this week yet.')).toBeTruthy();
    expect(await screen.findByText(XP_CHART_EMPTY)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    const strip = screen.getByRole('region', { name: 'XP summary' });
    expect(within(strip).getAllByText('0')).toHaveLength(3);
    expect(within(strip).getByText('of 24 skills trained')).toBeTruthy();
  });

  it('shows the empty sentence for the chosen period when nothing was gained', async () => {
    mockXpApi('1', {
      '/api/v1/accounts/1/gains': gainsAnswer({
        total: { xpGained: 0, levelsGained: 0 },
        skills: gainsFixture.skills.map((gain) => ({
          ...gain,
          startXp: gain.endXp,
          xpGained: 0,
          startLevel: gain.endLevel,
          levelsGained: 0,
        })),
      }),
    });
    renderApp('/1/progress/xp?period=day');
    expect(await screen.findByText('No XP gained today yet.')).toBeTruthy();
  });

  it('shows a skill gained only in an unknown skill, which the total leaves out', async () => {
    mockXpApi('1', {
      '/api/v1/accounts/1/gains': gainsAnswer({
        total: { xpGained: 0, levelsGained: 0 },
        skills: [
          {
            skill: 'ATTACK',
            startXp: 100,
            endXp: 100,
            xpGained: 0,
            startLevel: 2,
            endLevel: 2,
            levelsGained: 0,
          },
          {
            skill: 'NEW_SKILL',
            startXp: 0,
            endXp: 50_000,
            xpGained: 50_000,
            startLevel: 1,
            endLevel: 30,
            levelsGained: 29,
          },
        ],
      }),
    });
    renderApp('/1/progress/xp');
    const rows = rowTexts(await gainsTable());
    expect(rows[1]?.[0]).toContain('New skill');
    expect(rows[1]).toContain('+50,000');
    expect(screen.queryByText('No XP gained this week yet.')).toBeNull();
    // The big numbers follow the total (known skills only), so they agree with each other.
    const strip = screen.getByRole('region', { name: 'XP summary' });
    expect(within(strip).getAllByText('0')).toHaveLength(3);
  });

  it('only says "first session" for Overall when a chart has no points', async () => {
    mockXpApi('1', {
      '/api/v1/accounts/1/xp': xpAnswer({ skill: null, bucket: 'day', points: [] }),
    });
    renderApp('/1/progress/xp?skill=NEW_SKILL');
    expect(await screen.findByText('No New skill XP to show yet.')).toBeTruthy();
    expect(screen.queryByText(XP_CHART_EMPTY)).toBeNull();
  });

  it('shows an error with Retry per card and keeps the rest of the page', async () => {
    let fail = true;
    mockXpApi('1', {
      '/api/v1/accounts/1/gains': (url) =>
        fail
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'Boom', details: [] } }, 500)
          : (gainsAnswer() as (url: string) => Response)(url),
    });
    renderApp('/1/progress/xp');
    // The number row and the gains table share the gains request.
    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(2);
    });
    expect(screen.queryByText('Boom')).toBeNull();
    expect(await screen.findByRole('img', { name: /^XP over time/ })).toBeTruthy();

    fail = false;
    const [retry] = screen.getAllByRole('button', { name: 'Retry' });
    if (!retry) throw new Error('No Retry button');
    await userEvent.click(retry);
    expect(await gainsTable()).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});

describe('XP & gains on mobile', () => {
  it('lists Overall and six skills, then Show all, and charts a tapped skill', async () => {
    const skills = [
      'ATTACK',
      'STRENGTH',
      'DEFENCE',
      'RANGED',
      'PRAYER',
      'MAGIC',
      'COOKING',
      'WOODCUTTING',
    ].map((skill, index) => ({
      skill,
      startXp: 1_000,
      endXp: 1_000 + (8 - index) * 100,
      xpGained: (8 - index) * 100,
      startLevel: 10,
      endLevel: 10,
      levelsGained: 0,
    }));
    mockXpApi('1', {
      '/api/v1/accounts/1/gains': gainsAnswer({
        total: { xpGained: 3_600, levelsGained: 0 },
        skills: [
          ...skills,
          {
            skill: 'FISHING',
            startXp: 5,
            endXp: 5,
            xpGained: 0,
            startLevel: 1,
            endLevel: 1,
            levelsGained: 0,
          },
        ],
      }),
    });
    const { router } = renderApp('/1/progress/xp');
    const list = await screen.findByRole('list', { name: 'XP gained since Monday per skill' });
    expect(screen.queryByRole('table')).toBeNull();
    const buttons = within(list).getAllByRole('button');
    expect(buttons).toHaveLength(7);
    expect(buttons[0]?.textContent).toContain('Total level');
    expect(buttons[1]?.textContent).toContain('Level 10');

    await userEvent.click(screen.getByRole('button', { name: 'Show all (8)' }));
    expect(within(list).getAllByRole('button')).toHaveLength(9);

    await userEvent.click(within(list).getByRole('button', { name: /Cooking/ }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?skill=COOKING');
    });

    // The skills without XP fold out from one row.
    const fold = screen.getByRole('button', { name: 'No XP this week · 1 skill' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'No XP this week · 1 skill' })).toBeNull();
    await userEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list', { name: 'No XP this week · 1 skill' })).toBeTruthy();
  });

  it('shows levels gained next to the level', async () => {
    mockXpApi('1');
    renderApp('/1/progress/xp');
    const list = await screen.findByRole('list', { name: 'XP gained since Monday per skill' });
    // The fixture: Slayer 89 -> 90, Hitpoints without a level-up.
    const slayer = within(list).getByRole('button', { name: /Slayer/ });
    expect(slayer.textContent).toContain('Level 90↑1 (1 level gained)');
    expect(within(slayer).getByText('↑').getAttribute('aria-hidden')).toBe('true');
    expect(within(list).getByRole('button', { name: /Hitpoints/ }).textContent).not.toContain('↑');
  });

  it('shows "8 of 24" over "skills trained"', async () => {
    mockXpApi('1');
    renderApp('/1/progress/xp');
    const strip = await screen.findByRole('region', { name: 'XP summary' });
    expect(await within(strip).findByText('skills trained')).toBeTruthy();
    const of = within(strip).getByText((_, element) => element?.textContent === ' of 24');
    expect(of.className).toContain('desk:hidden');
  });
});
