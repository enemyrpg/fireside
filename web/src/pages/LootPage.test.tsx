import type { Drop, DropsResponse, LootResponse } from '@fireside/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import dropsFixture from '../../../shared/fixtures/api/drops-response/valid/page.json';
import lootFixture from '../../../shared/fixtures/api/loot-response/valid/by-source.json';
import raidsNoData from '../../../shared/fixtures/api/raids-response/valid/no-data.json';
import { findMainNav, mockApi, renderApp, type MockAnswer } from '@/test/render-app';

// The accounts fixture has accounts 1 ("Test Main") and 2 ("Alt"). The loot
// fixture has Vorkath (2,854,200 gp from 2 drops) and PLAYER loot (1,500 gp).
// The drops fixture is one Draconic visage from account 1 with a next cursor.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SERVER_ERROR = () =>
  json({ error: { code: 'INTERNAL_ERROR', message: 'Boom', details: [] } }, 500);

/** Loot that echoes the requested `from` (`null` = all time), like the server. */
function lootAnswer(body: Omit<LootResponse, 'from' | 'to'> = lootFixture as LootResponse) {
  return (url: string) => {
    const from = new URL(url, 'http://localhost').searchParams.get('from');
    return json({ ...body, from, to: null });
  };
}

const SECOND_DROP: Drop = {
  ...(dropsFixture.items[0] as Drop),
  lootEventId: 9,
  accountId: 2,
  occurredAt: '2026-11-01T12:00:00.000Z',
  itemId: 12073,
  name: 'Clue scroll (elite)',
  quantity: 1,
  gePriceEach: 1_200_000,
  haPriceEach: 0,
  geValue: 1_200_000,
  haValue: 0,
};

/** First page from the fixture; with a cursor, a last page with one more drop. */
const dropsAnswer: MockAnswer = (url) => {
  const cursor = new URL(url, 'http://localhost').searchParams.get('cursor');
  const page: DropsResponse = cursor
    ? { items: [SECOND_DROP], nextCursor: null }
    : (dropsFixture as DropsResponse);
  return json(page);
};

function mockLootApi(scope: string, answers: Record<string, MockAnswer> = {}) {
  return mockApi({
    [`/api/v1/accounts/${scope}/loot`]: lootAnswer(),
    [`/api/v1/accounts/${scope}/loot/drops`]: dropsAnswer,
    // Boss KC stands under the loot cards on the same page.
    [`/api/v1/accounts/${scope}/kc`]: { body: { bosses: [] } },
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

async function dropsList() {
  return screen.findByRole('list', { name: 'Valuable drops' });
}

/** Holds answers until `release()`: for looking at the page while a request is in flight. */
function holdable(answer: (url: string) => Response) {
  let held = false;
  const waiting: (() => void)[] = [];
  return {
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      for (const resume of waiting.splice(0)) resume();
    },
    answer: (url: string): Response | Promise<Response> =>
      held
        ? new Promise((resolve) => {
            waiting.push(() => {
              resolve(answer(url));
            });
          })
        : answer(url),
  };
}

function manySources(count: number): Omit<LootResponse, 'from' | 'to'> {
  const groups = Array.from({ length: count }, (_, index) => ({
    source: { type: 'NPC' as const, name: `Boss ${String(index + 1)}` },
    lootCount: 1,
    geValue: 1000 - index,
    haValue: 0,
    items: [],
  }));
  const geValue = groups.reduce((sum, group) => sum + group.geValue, 0);
  return { groupBy: 'source', totals: { lootCount: count, geValue, haValue: 0 }, groups };
}

/** The number row's text, or '' while it isn't there. */
function stripText(): string {
  return screen.queryByRole('region', { name: 'Loot summary' })?.textContent ?? '';
}

describe('Loot', () => {
  it('shows 30 days by source and all-time valuable drops', async () => {
    // Only Date is faked, so Testing Library's timers keep working. Wednesday 11 November 2026.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    try {
      const fetchMock = mockLootApi('all');
      renderApp('/all/progress/loot?range=30d');

      expect(await screen.findByRole('heading', { level: 1, name: 'Progress' })).toBeTruthy();
      expect(await screen.findByText('loot · last 30 days, GE value')).toBeTruthy();
      // The strip shows "gp" after the number in smaller type.
      expect(stripText()).toContain('2.86Mgp');
      expect(screen.getByText('drops')).toBeTruthy();

      const [loot] = requests(fetchMock, '/api/v1/accounts/all/loot');
      expect(loot?.get('groupBy')).toBe('source');
      expect(loot?.get('to')).toBeNull();
      // Local midnight 29 days ago in the health fixture's zone (Europe/Oslo, summer time).
      expect(loot?.get('from')).toBe('2026-10-12T22:00:00.000Z');

      const sources = await screen.findByRole('list', {
        name: 'Loot in the last 30 days per source',
      });
      const labels = within(sources)
        .getAllByRole('listitem')
        .map((item) => item.textContent);
      expect(labels[0]).toContain('Vorkath');
      // Loot from a player never has a name.
      expect(labels[1]).toContain('Player');
      // An NPC asks for its boss icon; a player gets initials only, no request.
      const images = [...sources.querySelectorAll('img')].map((img) => img.getAttribute('src'));
      expect(images).toContain('/api/v1/bosses/Vorkath/icon');
      expect(images.some((src) => src?.includes('Player'))).toBe(false);

      // Valuable drops are all time, 1M+ by default.
      const [drops] = requests(fetchMock, '/api/v1/accounts/all/loot/drops');
      expect(drops?.get('minValue')).toBe('1000000');
      expect(drops?.get('limit')).toBe('20');
      expect(drops?.get('from')).toBeNull();
      const list = await dropsList();
      expect(within(list).getByText('Draconic visage')).toBeTruthy();
      // The account is named for `all`.
      expect(within(list).getByText('Test Main')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('changes the range with the toggle and keeps it in the URL', async () => {
    const fetchMock = mockLootApi('1');
    const { router } = renderApp('/1/progress/loot?range=7d');
    expect(await screen.findByText('loot · last 7 days, GE value')).toBeTruthy();

    await userEvent.click(screen.getByRole('radio', { name: 'All time' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?range=all');
    });
    expect(await screen.findByText('loot · all time, GE value')).toBeTruthy();
    expect(requests(fetchMock, '/api/v1/accounts/1/loot').at(-1)?.get('from')).toBeNull();
    // The drops list doesn't follow the range.
    expect(requests(fetchMock, '/api/v1/accounts/1/loot/drops')).toHaveLength(1);
  });

  it('shows all time and 1M+ by default and for unknown values', async () => {
    const fetchMock = mockLootApi('1');
    renderApp('/1/progress/loot?range=90d&min=5m');
    expect(await screen.findByText('loot · all time, GE value')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'All time' }).getAttribute('data-state')).toBe('on');
    expect(requests(fetchMock, '/api/v1/accounts/1/loot')[0]?.get('from')).toBeNull();
    expect(screen.getByRole('radio', { name: '1M+' }).getAttribute('data-state')).toBe('on');
  });

  it('filters valuable drops by value and says so when there are none', async () => {
    const fetchMock = mockLootApi('1', {
      '/api/v1/accounts/1/loot/drops': (url) =>
        new URL(url, 'http://localhost').searchParams.get('minValue') === '10000000'
          ? json({ items: [], nextCursor: null })
          : dropsAnswer(url),
    });
    const { router } = renderApp('/1/progress/loot');
    const list = await dropsList();
    // One account: no account name in the row.
    expect(within(list).queryByText('Test Main')).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: '10M+' }));
    expect(await screen.findByText('No drops worth 10M+ gp yet.')).toBeTruthy();
    expect(router.state.location.search).toBe('?min=10m');
    expect(requests(fetchMock, '/api/v1/accounts/1/loot/drops').at(-1)?.get('minValue')).toBe(
      '10000000',
    );
  });

  it('shows six sources, then all of them with Show all, without a new request', async () => {
    const groups = Array.from({ length: 20 }, (_, index) => ({
      source: { type: 'NPC' as const, name: `Boss ${String(index + 1)}` },
      lootCount: 1,
      geValue: 1000 - index,
      haValue: 0,
      items: [],
    }));
    const geValue = groups.reduce((sum, group) => sum + group.geValue, 0);
    const fetchMock = mockLootApi('1', {
      '/api/v1/accounts/1/loot': lootAnswer({
        groupBy: 'source',
        totals: { lootCount: 20, geValue, haValue: 0 },
        groups,
      }),
    });
    renderApp('/1/progress/loot');
    const list = await screen.findByRole('list', { name: 'Loot all time per source' });
    const labels = () =>
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent);
    expect(labels()).toHaveLength(6);

    const sources = screen.getByRole('list', { name: /per source$/ }).closest('section');
    if (!sources) throw new Error('No By source card');
    await userEvent.click(within(sources).getByRole('button', { name: 'Show all (20)' }));
    expect(labels()).toHaveLength(20);
    expect(labels()[19]).toContain('Boss 20');

    await userEvent.click(within(sources).getByRole('button', { name: 'Show fewer' }));
    expect(labels()).toHaveLength(6);
    expect(requests(fetchMock, '/api/v1/accounts/1/loot')).toHaveLength(1);
  });

  it('loads more drops with the cursor until there are no more', async () => {
    const fetchMock = mockLootApi('all');
    renderApp('/all/progress/loot');
    await dropsList();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    const list = await dropsList();
    expect(await within(list).findByText('Clue scroll (elite)')).toBeTruthy();
    expect(within(list).getByText('Alt')).toBeTruthy();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(requests(fetchMock, '/api/v1/accounts/all/loot/drops').at(-1)?.get('cursor')).toBe(
      dropsFixture.nextCursor,
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('invites to play when there is no loot in the range', async () => {
    mockLootApi('2', {
      '/api/v1/accounts/2/loot': lootAnswer({
        groupBy: 'source',
        totals: { lootCount: 0, geValue: 0, haValue: 0 },
        groups: [],
      }),
      '/api/v1/accounts/2/loot/drops': { body: { items: [], nextCursor: null } },
    });
    renderApp('/2/progress/loot?range=30d');
    expect(await screen.findByText('No loot in the last 30 days.')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Loot summary' })).getAllByText('0'),
    ).toHaveLength(3);
    expect(screen.getByText('No drops worth 1M+ gp yet.')).toBeTruthy();
  });

  it('shows an error with Retry per card and keeps the rest of the page', async () => {
    let fail = true;
    mockLootApi('1', {
      '/api/v1/accounts/1/loot': (url) => (fail ? SERVER_ERROR() : lootAnswer()(url)),
    });
    renderApp('/1/progress/loot');
    // The number row and "By source" share the loot request.
    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(2);
    });
    expect(screen.queryByText('Boom')).toBeNull();
    expect(await dropsList()).toBeTruthy();

    fail = false;
    const [retry] = screen.getAllByRole('button', { name: 'Retry' });
    if (!retry) throw new Error('No Retry button');
    await userEvent.click(retry);
    expect(await screen.findByRole('list', { name: /per source$/ })).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('is the Loot & KC tab of Progress, with Boss KC under the loot', async () => {
    mockLootApi('all', {
      '/api/v1/accounts/all/raids': { body: raidsNoData },
    });
    const { router } = renderApp('/all/progress/loot');
    const tabs = await screen.findByRole('navigation', { name: 'Progress views' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('aria-current')]),
    ).toEqual([
      ['XP', null],
      ['Loot & KC', 'page'],
      ['Raids', null],
    ]);
    const nav = await findMainNav();
    expect(within(nav).getByRole('link', { name: 'Progress' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(await screen.findByRole('heading', { name: /^Boss kill count/ })).toBeTruthy();

    await userEvent.click(within(tabs).getByRole('link', { name: 'Raids' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all/progress/raids');
    });
  });

  describe('while new data loads', () => {
    it('keeps the labels of the range on screen', async () => {
      const loot = holdable(lootAnswer());
      mockLootApi('1', { '/api/v1/accounts/1/loot': loot.answer });
      renderApp('/1/progress/loot?range=7d');
      expect(await screen.findByText('loot · last 7 days, GE value')).toBeTruthy();

      loot.hold();
      await userEvent.click(screen.getByRole('radio', { name: 'All time' }));
      // The 7-day totals are still on screen, so they keep their label.
      expect(screen.getByText('loot · last 7 days, GE value')).toBeTruthy();
      expect(screen.queryByText('loot · all time, GE value')).toBeNull();

      loot.release();
      expect(await screen.findByText('loot · all time, GE value')).toBeTruthy();
    });

    it('keeps the empty text of the drops filter on screen', async () => {
      const drops = holdable((url) =>
        new URL(url, 'http://localhost').searchParams.get('minValue') === '10000000'
          ? json({ items: [], nextCursor: null })
          : (dropsAnswer as (url: string) => Response)(url),
      );
      mockLootApi('1', { '/api/v1/accounts/1/loot/drops': drops.answer });
      renderApp('/1/progress/loot?min=10m');
      expect(await screen.findByText('No drops worth 10M+ gp yet.')).toBeTruthy();

      drops.hold();
      await userEvent.click(screen.getByRole('radio', { name: '100K+' }));
      expect(screen.getByText('No drops worth 10M+ gp yet.')).toBeTruthy();
      expect(screen.queryByText('No drops worth 100K+ gp yet.')).toBeNull();

      drops.release();
      expect(await dropsList()).toBeTruthy();
    });

    it('keeps the shown sources until the new range arrives, then folds to six again', async () => {
      const loot = holdable(lootAnswer(manySources(20)));
      mockLootApi('1', { '/api/v1/accounts/1/loot': loot.answer });
      renderApp('/1/progress/loot');
      await screen.findByRole('list', { name: 'Loot all time per source' });
      const sources = () => {
        const card = screen.getByRole('list', { name: /per source$/ }).closest('section');
        if (!card) throw new Error('No By source card');
        return card;
      };
      const rowCount = () => within(sources()).getAllByRole('listitem').length;
      await userEvent.click(within(sources()).getByRole('button', { name: 'Show all (20)' }));
      expect(rowCount()).toBe(20);

      loot.hold();
      await userEvent.click(screen.getByRole('radio', { name: '30 days' }));
      expect(rowCount()).toBe(20);

      loot.release();
      expect(
        await screen.findByRole('list', { name: 'Loot in the last 30 days per source' }),
      ).toBeTruthy();
      expect(rowCount()).toBe(6);
    });

    it('never shows loot from all accounts under one account', async () => {
      const one = holdable(lootAnswer());
      mockLootApi('all', {
        '/api/v1/accounts/1/loot': one.answer,
        '/api/v1/accounts/1/loot/drops': { body: { items: [], nextCursor: null } },
      });
      const { router } = renderApp('/all/progress/loot');
      const list = await dropsList();
      expect(within(list).getByText('Test Main')).toBeTruthy();

      one.hold();
      await router.navigate('/1/progress/loot');
      await waitFor(() => {
        expect(stripText()).not.toContain('2.86M');
      });
      expect(screen.queryByRole('list', { name: /per source$/ })).toBeNull();

      one.release();
      await waitFor(() => {
        expect(stripText()).toContain('2.86M');
      });
    });
  });
});
