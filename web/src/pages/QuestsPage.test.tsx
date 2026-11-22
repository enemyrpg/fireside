import type { DiariesResponse, QuestsResponse } from '@fireside/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import accountsFixture from '../../../shared/fixtures/api/accounts-response/valid/accounts.json';
import diariesNoData from '../../../shared/fixtures/api/diaries-response/valid/no-data.json';
import diariesOne from '../../../shared/fixtures/api/diaries-response/valid/one-account.json';
import diariesUnknown from '../../../shared/fixtures/api/diaries-response/valid/unknown-region.json';
import questsEmpty from '../../../shared/fixtures/api/quests-response/valid/empty-snapshot.json';
import questsNoData from '../../../shared/fixtures/api/quests-response/valid/no-data.json';
import questsOne from '../../../shared/fixtures/api/quests-response/valid/one-account.json';
import questsUnknown from '../../../shared/fixtures/api/quests-response/valid/unknown-quest.json';
import { findMainNav, mockApi, renderApp, type MockAnswer } from '@/test/render-app';

// The accounts fixture has 1 ("Test Main", ironman) and 2 ("Alt"). Account 1's
// quests fixture: 3 quest points; quests Cook's Assistant (finished before
// tracking), Dragon Slayer I (finished 20 Oct), Dragon Slayer II (in
// progress), Desert Treasure II (not started); miniquests Alfred Grimhand's
// Barcrawl (finished) and Bear Your Soul (not started). Its diaries fixture:
// Ardougne 3 of 4 (Hard on 20 Oct), Falador 4, Kourend & Kebos 1,
// Wilderness 0: 8 of 16 tiers, 1 region fully done.

interface Data {
  /** Per account ID. Accounts left out answer "no data". */
  quests?: Record<number, unknown>;
  diaries?: Record<number, unknown>;
  answers?: Record<string, MockAnswer>;
}

function mockQuests({
  quests = { 1: questsOne },
  diaries = { 1: diariesOne },
  answers = {},
}: Data = {}) {
  const byAccount: Record<string, MockAnswer> = {};
  for (const [id, body] of Object.entries(quests)) {
    byAccount[`/api/v1/accounts/${id}/quests`] = { body };
  }
  for (const [id, body] of Object.entries(diaries)) {
    byAccount[`/api/v1/accounts/${id}/diaries`] = { body };
  }
  return mockApi({ ...byAccount, ...answers });
}

function calls(fetchMock: ReturnType<typeof mockApi>, path: string): number {
  return fetchMock.mock.calls.filter(([input]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, 'http://localhost').pathname === path;
  }).length;
}

/** The card (`section`) with the heading `name`. */
async function card(name: string) {
  const heading = await screen.findByRole('heading', { level: 2, name });
  const section = heading.closest('section');
  if (!section) throw new Error(`No card for ${name}`);
  return { section, ...within(section) };
}

/**
 * A number in the row at the top, found by its key ('points', 'quests',
 * 'tiers'): the PC value, the PC label and the note, joined by "|".
 */
async function tile(key: 'points' | 'quests' | 'tiers'): Promise<string> {
  const region = await waitFor(() => {
    const element = screen.getByRole('region', { name: 'Quests and diaries summary' });
    if (element.getAttribute('aria-busy') === 'true') throw new Error('Still loading');
    return element;
  });
  const item = [...region.children][['points', 'quests', 'tiers'].indexOf(key)];
  if (!item) throw new Error(`No number ${key}`);
  const [value, label, note] = [...item.children];
  const pc = (element: Element | undefined) =>
    element?.querySelector('[class~="max-desk:hidden"]')?.textContent ?? element?.textContent;
  return [pc(value), pc(label), note?.textContent].filter((part) => part !== undefined).join('|');
}

function names(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.firstElementChild?.textContent ?? '');
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function serverError(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'x', details: [] } }),
    {
      status: 500,
      headers: { 'content-type': 'application/json' },
    },
  );
}

describe('Quests & diaries', () => {
  beforeEach(() => {
    // Only Date is faked, so Testing Library's timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the three numbers, with quests only in "Quests completed"', async () => {
    mockQuests();
    renderApp('/1/collections/quests');
    expect(await tile('points')).toMatch(/^3\|quest points · updated /);
    expect(await tile('quests')).toBe('2|of 4 quests completed|1 in progress');
    expect(await tile('tiers')).toBe('8|of 16 diary tiers|1 region fully done');
  });

  it('shows the diary tiers per region as four labelled pips', async () => {
    mockQuests();
    renderApp('/1/collections/quests');
    const diaries = await card('Achievement diaries');
    expect(diaries.getByText('8 of 16 tiers')).toBeTruthy();
    const rows = within(diaries.getByRole('list')).getAllByRole('listitem');
    expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual([
      'Ardougne',
      'Falador',
      'Kourend & Kebos',
      'Wilderness',
    ]);
    const [ardougne] = rows as [HTMLElement];
    expect(
      within(ardougne)
        .getAllByRole('img')
        .map((pip) => pip.getAttribute('aria-label')),
    ).toEqual(['Easy: completed', 'Medium: completed', 'Hard: completed', 'Elite: not completed']);
  });

  it('shows an unknown region by name and leaves the place of a missing tier empty', async () => {
    const unknown = diariesUnknown as DiariesResponse;
    const [firstRegion] = unknown.regions as [DiariesResponse['regions'][number]];
    // The first region loses its Elite tier (not completed in the fixture).
    const regions = [{ ...firstRegion, tiers: firstRegion.tiers.slice(0, 3) }].concat(
      unknown.regions.slice(1),
    );
    const diaries: DiariesResponse = {
      ...unknown,
      regions,
      totals: { ...unknown.totals, tiers: unknown.totals.tiers - 1 },
    };
    mockQuests({ diaries: { 1: diaries } });
    renderApp('/1/collections/quests');
    const view = await card('Achievement diaries');
    const rows = within(view.getByRole('list')).getAllByRole('listitem');
    const unknownName = unknown.regions.find(
      (region) => !['Ardougne', 'Falador', 'Kourend & Kebos', 'Wilderness'].includes(region.name),
    )?.name;
    expect(unknownName).toBeTruthy();
    expect(rows.some((row) => row.firstElementChild?.textContent === unknownName)).toBe(true);
    const [firstRow] = rows as [HTMLElement];
    expect(within(firstRow).getAllByRole('img')).toHaveLength(3);
  });

  it('lists the newest completions with their date, diary tiers with a tier badge', async () => {
    mockQuests();
    renderApp('/1/collections/quests');
    const recent = await card('Recently completed');
    const rows = within(recent.getByRole('list')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Dragon Slayer ITue 20 Oct',
      'Ardougne diaryHardTue 20 Oct',
    ]);
  });

  it('hides "Recently completed" when nothing has a date', async () => {
    const quests = questsOne as QuestsResponse;
    const diaries = diariesOne as DiariesResponse;
    mockQuests({
      quests: {
        1: { ...quests, quests: quests.quests.map((quest) => ({ ...quest, finishedAt: null })) },
      },
      diaries: {
        1: {
          ...diaries,
          regions: diaries.regions.map((region) => ({
            ...region,
            tiers: region.tiers.map((tier) => ({ ...tier, completedAt: null })),
          })),
        },
      },
    });
    renderApp('/1/collections/quests');
    await card('Achievement diaries');
    expect(screen.queryByRole('heading', { name: 'Recently completed' })).toBeNull();
  });

  it('groups quests by state with counts, Completed and Miniquests folded', async () => {
    mockQuests();
    renderApp('/1/collections/quests');
    const quests = await card('Quests');
    const button = (name: RegExp) => quests.getByRole('button', { name });
    expect(button(/^In progress/).textContent).toBe('In progress1');
    expect(button(/^Not started/).textContent).toBe('Not started1');
    expect(button(/^Completed/).textContent).toBe('Completed2');
    expect(button(/^Miniquests/).textContent).toBe('Miniquests1 of 2 completed');
    expect(button(/^In progress/).getAttribute('aria-expanded')).toBe('true');
    expect(button(/^Not started/).getAttribute('aria-expanded')).toBe('true');
    expect(button(/^Completed/).getAttribute('aria-expanded')).toBe('false');
    expect(button(/^Miniquests/).getAttribute('aria-expanded')).toBe('false');

    expect(names(quests.getByRole('list', { name: 'In progress' }))).toEqual(['Dragon Slayer II']);
    expect(names(quests.getByRole('list', { name: 'Not started' }))).toEqual([
      'Desert Treasure II - The Fallen Empire',
    ]);
    expect(quests.queryByRole('list', { name: 'Completed' })).toBeNull();
    expect(quests.queryByText("Alfred Grimhand's Barcrawl")).toBeNull();
  });

  it('unfolds a group on click: completed quests with the date when known, miniquests with their state', async () => {
    const user = userEvent.setup();
    mockQuests();
    renderApp('/1/collections/quests');
    const quests = await card('Quests');
    await user.click(quests.getByRole('button', { name: /^Completed/ }));
    const completed = within(quests.getByRole('list', { name: 'Completed' })).getAllByRole(
      'listitem',
    );
    expect(completed.map((row) => row.textContent)).toEqual([
      "Cook's Assistant",
      'Dragon Slayer ITue 20 Oct',
    ]);

    await user.click(quests.getByRole('button', { name: /^Miniquests/ }));
    const mini = within(quests.getByRole('list', { name: 'Miniquests' })).getAllByRole('listitem');
    expect(mini.map((row) => row.textContent)).toEqual([
      "Alfred Grimhand's BarcrawlCompleted",
      'Bear Your Soul',
    ]);

    await user.click(quests.getByRole('button', { name: /^In progress/ }));
    expect(quests.queryByRole('list', { name: 'In progress' })).toBeNull();
  });

  it('leaves the Miniquests group out for an account without miniquests', async () => {
    const quests = questsOne as QuestsResponse;
    mockQuests({
      quests: {
        1: {
          ...quests,
          quests: quests.quests.filter((quest) => quest.kind === 'QUEST'),
          miniquestTotals: { total: 0, finished: 0, inProgress: 0, notStarted: 0 },
        },
      },
    });
    renderApp('/1/collections/quests');
    const view = await card('Quests');
    expect(view.getByRole('button', { name: /^Completed/ })).toBeTruthy();
    expect(view.queryByRole('button', { name: /^Miniquests/ })).toBeNull();
  });

  it('searches every group from the URL, opening the groups with matches and hiding the rest', async () => {
    mockQuests();
    renderApp('/1/collections/quests?q=dragon');
    const quests = await card('Quests');
    expect(quests.getByRole<HTMLInputElement>('searchbox', { name: 'Search quests' }).value).toBe(
      'dragon',
    );
    expect(names(quests.getByRole('list', { name: 'In progress' }))).toEqual(['Dragon Slayer II']);
    expect(names(quests.getByRole('list', { name: 'Completed' }))).toEqual(['Dragon Slayer I']);
    expect(quests.getByRole('button', { name: /^Completed/ }).textContent).toBe('Completed1');
    expect(quests.queryByRole('button', { name: /^Not started/ })).toBeNull();
    expect(quests.queryByRole('button', { name: /^Miniquests/ })).toBeNull();
    // The numbers are not filtered.
    expect(await tile('quests')).toBe('2|of 4 quests completed|1 in progress');
  });

  it('searches miniquests too, replaces the URL, and folds back when the search is cleared', async () => {
    const user = userEvent.setup();
    mockQuests();
    const { router } = renderApp('/1/collections/quests');
    const quests = await card('Quests');
    const field = quests.getByRole('searchbox', { name: 'Search quests' });
    await user.type(field, 'soul');
    await waitFor(() => {
      expect(router.state.location.search).toBe('?q=soul');
    });
    expect(names(quests.getByRole('list', { name: 'Miniquests' }))).toEqual(['Bear Your Soul']);
    expect(quests.getByRole('button', { name: /^Miniquests/ }).textContent).toBe(
      'Miniquests0 of 1 completed',
    );
    expect(quests.queryByRole('button', { name: /^In progress/ })).toBeNull();

    await user.clear(field);
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(quests.getByRole('button', { name: /^Miniquests/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(quests.getByRole('list', { name: 'In progress' })).toBeTruthy();
    // Typing replaced the URL: nothing to go back to.
    expect(router.state.historyAction).not.toBe('PUSH');
  });

  it('says so when no quest matches the search', async () => {
    mockQuests();
    renderApp('/1/collections/quests?q=zzz');
    const quests = await card('Quests');
    expect(quests.getByText('No quests match “zzz”.')).toBeTruthy();
    expect(quests.queryByRole('button', { name: /^Completed/ })).toBeNull();
  });

  it('shows an unknown quest by the name from the plugin', async () => {
    mockQuests({ quests: { 1: questsUnknown } });
    renderApp('/1/collections/quests');
    const quests = await card('Quests');
    const known = new Set((questsOne as QuestsResponse).quests.map((quest) => quest.quest));
    const unknown = (questsUnknown as QuestsResponse).quests.find(
      (quest) => !known.has(quest.quest),
    );
    expect(unknown).toBeTruthy();
    expect(quests.getByText(unknown?.name ?? '')).toBeTruthy();
    expect(await tile('quests')).toBe('2|of 5 quests completed|2 in progress');
  });

  it('shows what it has for an account with quests but no diary snapshot', async () => {
    mockQuests({ diaries: { 1: diariesNoData } });
    renderApp('/1/collections/quests');
    await card('Quests');
    expect(await tile('tiers')).toBe('–|diary tiers|No data yet');
    expect(await tile('quests')).toBe('2|of 4 quests completed|1 in progress');
    expect(screen.queryByRole('heading', { name: 'Achievement diaries' })).toBeNull();
  });

  it('shows what it has for an account with diaries but no quest snapshot', async () => {
    mockQuests({ quests: { 1: questsNoData } });
    renderApp('/1/collections/quests');
    await card('Achievement diaries');
    expect(await tile('points')).toBe('–|quest points · no data yet');
    expect(await tile('quests')).toBe('–|quests completed|No data yet');
    expect(screen.queryByRole('heading', { name: 'Quests' })).toBeNull();
  });

  it('says so for a snapshot without quests', async () => {
    mockQuests({ quests: { 1: questsEmpty } });
    renderApp('/1/collections/quests');
    const quests = await card('Quests');
    expect(quests.getByText('No quests in the latest snapshot.')).toBeTruthy();
  });

  it('shows one card per account with data for all accounts, linking to the account', async () => {
    mockQuests({ diaries: { 1: diariesNoData } });
    renderApp('/all/collections/quests');
    const list = await screen.findByRole('list', { name: 'Quests and diaries per account' });
    const links = within(list).getAllByRole('link');
    // Account 2 has no data and is left out.
    expect(links).toHaveLength(1);
    const [link] = links as [HTMLElement];
    expect(link.getAttribute('href')).toBe('/1/collections/quests');
    expect(link.textContent).toBe('Test MainIronman3quest points2 of 4quests–diary tiers→');
    expect(
      screen.getByText('Quests and diaries belong to one account. Pick an account to see them.'),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Quests' })).toBeNull();
  });

  it('invites an account without a snapshot, while another account has one', async () => {
    mockQuests();
    renderApp('/2/collections/quests');
    expect(await screen.findByText(/Log in to the game with the plugin running/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Not found' })).toBeNull();
  });

  it('offers a retry when the quests fail to load', async () => {
    const user = userEvent.setup();
    let fail = true;
    mockQuests({
      answers: {
        '/api/v1/accounts/1/quests': () =>
          fail
            ? new Response(
                JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'x', details: [] } }),
                { status: 500, headers: { 'content-type': 'application/json' } },
              )
            : new Response(JSON.stringify(questsOne), {
                headers: { 'content-type': 'application/json' },
              }),
      },
    });
    renderApp('/1/collections/quests');
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    await user.click(retry);
    expect(await tile('quests')).toBe('2|of 4 quests completed|1 in progress');
  });

  it('keeps a group folded during a search while typing on', async () => {
    const user = userEvent.setup();
    mockQuests();
    renderApp('/1/collections/quests?q=dragon');
    const quests = await card('Quests');
    const completed = () => quests.getByRole('button', { name: /^Completed/ });
    expect(completed().getAttribute('aria-expanded')).toBe('true');
    await user.click(completed());
    expect(completed().getAttribute('aria-expanded')).toBe('false');

    await user.type(quests.getByRole('searchbox', { name: 'Search quests' }), ' slayer');
    expect(completed().getAttribute('aria-expanded')).toBe('false');
    expect(names(quests.getByRole('list', { name: 'In progress' }))).toEqual(['Dragon Slayer II']);
  });

  it('opens every group for a search that starts without typing', async () => {
    mockQuests();
    const { router } = renderApp('/1/collections/quests');
    const quests = await card('Quests');
    expect(quests.getByRole('button', { name: /^Completed/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    await router.navigate('/1/collections/quests?q=dragon');
    await waitFor(() => {
      expect(quests.getByRole('button', { name: /^Completed/ }).getAttribute('aria-expanded')).toBe(
        'true',
      );
    });
  });

  it('keeps the cards of the accounts that loaded when another account fails', async () => {
    const user = userEvent.setup();
    let fail = true;
    mockQuests({
      answers: {
        '/api/v1/accounts/2/diaries': () =>
          fail ? serverError() : json({ ...diariesOne, accountId: 2 }),
      },
    });
    renderApp('/all/collections/quests');
    const list = await screen.findByRole('list', { name: 'Quests and diaries per account' });
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    const retry = await screen.findByRole('button', { name: 'Retry' });

    fail = false;
    await user.click(retry);
    await waitFor(() => {
      expect(within(list).getAllByRole('link')).toHaveLength(2);
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows the page of an account with data without waiting for the other accounts', async () => {
    mockQuests({
      answers: {
        // Never answers.
        '/api/v1/accounts/2/quests': () => new Promise<Response>(() => undefined),
      },
    });
    renderApp('/1/collections/quests');
    expect(await tile('quests')).toBe('2|of 4 quests completed|1 in progress');
  });

  it('never polls', async () => {
    const fetchMock = mockQuests();
    renderApp('/1/collections/quests');
    await card('Quests');
    const before = calls(fetchMock, '/api/v1/accounts/1/quests');
    vi.setSystemTime(new Date('2026-11-11T12:05:00Z'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls(fetchMock, '/api/v1/accounts/1/quests')).toBe(before);
  });
});

describe('Quests & diaries in the menu', () => {
  it('has no page until an account has a quest or diary snapshot', async () => {
    mockApi();
    renderApp('/1/collections/quests');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
  });

  it('opens the page after the first snapshot, also with "no data" still in the cache', async () => {
    let diaries: unknown = diariesNoData;
    mockApi({
      '/api/v1/accounts/1/diaries': () =>
        new Response(JSON.stringify(diaries), { headers: { 'content-type': 'application/json' } }),
    });
    const { router } = renderApp('/settings');
    const nav = await findMainNav();
    await within(nav).findByRole('link', { name: 'Progress' });
    expect(within(nav).queryByRole('link', { name: 'Collections' })).toBeNull();

    // The account logs in; the cached answers are still fresh.
    diaries = diariesOne;
    await router.navigate('/1/collections/quests');
    expect(await screen.findByRole('heading', { name: 'Achievement diaries' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Not found' })).toBeNull();
    expect(await within(nav).findByRole('link', { name: 'Collections' })).toBeTruthy();
  });

  it('asks an account that was added after the account list was cached', async () => {
    let accounts: unknown = { accounts: accountsFixture.accounts.slice(0, 1) };
    mockQuests({
      quests: {},
      diaries: { 2: { ...diariesOne, accountId: 2 } },
      answers: { '/api/v1/accounts': () => json(accounts) },
    });
    const { router } = renderApp('/settings');
    const nav = await findMainNav();
    await within(nav).findByRole('link', { name: 'Progress' });
    expect(within(nav).queryByRole('link', { name: 'Collections' })).toBeNull();

    // The second account logs in for the first time; the cached list is still fresh.
    accounts = accountsFixture;
    await router.navigate('/all/collections/quests');
    const list = await screen.findByRole('list', { name: 'Quests and diaries per account' });
    expect(within(list).getByRole('link').getAttribute('href')).toBe('/2/collections/quests');
    expect(screen.queryByRole('heading', { name: 'Not found' })).toBeNull();
  });

  it('turns the page away after a retry that answers "no data"', async () => {
    const user = userEvent.setup();
    let fail = true;
    mockApi({
      '/api/v1/accounts/2/diaries': () =>
        fail ? serverError() : json({ ...diariesNoData, accountId: 2 }),
    });
    renderApp('/all/collections/quests');
    // Can't tell yet: the page shows with its own Retry, not the 404.
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByRole('heading', { name: 'Not found' })).toBeNull();

    fail = false;
    await user.click(retry);
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
  });

  it('leaves Collections out of the menus without data', async () => {
    mockApi();
    renderApp('/settings');
    const nav = await findMainNav();
    await within(nav).findByRole('link', { name: 'Progress' });
    expect(screen.queryByRole('link', { name: 'Collections' })).toBeNull();
  });

  it('makes Collections open it once one account has data', async () => {
    // Only a diary snapshot, and only on the second account.
    mockQuests({ quests: {}, diaries: { 2: { ...diariesOne, accountId: 2 } } });
    renderApp('/settings');
    const nav = await findMainNav();
    const link = await within(nav).findByRole('link', { name: 'Collections' });
    expect(link.getAttribute('href')).toBe('/all/collections/quests');
    expect(screen.getAllByRole('link', { name: 'Collections' })).toHaveLength(2);
  });

  it('marks Collections in the menu on the page', async () => {
    mockQuests();
    renderApp('/1/collections/quests');
    const nav = await findMainNav();
    const link = await within(nav).findByRole('link', { name: 'Collections' });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.getAttribute('href')).toBe('/1/collections/quests');
  });
});
