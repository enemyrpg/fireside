import type { SessionDetailResponse } from '@fireside/shared';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import detailFixture from '../../../shared/fixtures/api/session-detail-response/valid/session.json';
import { LIVE_POLL_MS } from '@/api/query-client';
import { mockApi, renderApp, stubDesktop } from '@/test/render-app';
import { makeDetail, makeSession } from '@/test/sessions';
import { SESSION_NOT_FOUND } from './session/not-found';

// The fixture: account 1 ("Test Main"), Sun 8 Nov 19:00–21:00 Oslo, World 420,
// with an older neighbour and no newer one.

const DETAIL = detailFixture as SessionDetailResponse;
const ID = DETAIL.session.id;
const PATH = `/api/v1/sessions/${ID}`;

const OPEN: SessionDetailResponse = {
  ...DETAIL,
  session: { ...DETAIL.session, endedAt: null, endReason: null, summary: null },
};

const error = (status: number, code: string, path = '') => ({
  status,
  body: { error: { code, message: 'x', details: path ? [{ path, message: 'Invalid' }] : [] } },
});

interface PollingOptions {
  refetchInterval: (query: unknown) => number | false;
  refetchIntervalInBackground: boolean;
}

/** The polling options of the page's session query (the shell only reads the cache). */
function pollingOf(queryClient: QueryClient) {
  const query = queryClient.getQueryCache().find({ queryKey: ['session', ID] });
  const observer = query?.observers.find(
    (item) => typeof item.options.refetchInterval === 'function',
  );
  expect(observer).toBeDefined();
  return { query, options: observer?.options as unknown as PollingOptions };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Session detail page', () => {
  it('shows the numbers, timeline, XP, KC, loot and the older session', async () => {
    mockApi({ [PATH]: { body: DETAIL } });
    renderApp(`/sessions/${ID}`);

    expect(await screen.findByText(/ended by logout/)).toBeTruthy();
    expect(screen.getByText(/Test Main/).textContent).toBe('Test Main · ended by logout');
    const numbers = within(screen.getByRole('region', { name: 'Session summary' }));
    expect(numbers.getByText('2 h')).toBeTruthy();
    // The date line under the big number on mobile.
    expect(numbers.getByText('Sun 8 Nov · 19:00–21:00 · World 420')).toBeTruthy();
    expect(numbers.getByText('120K')).toBeTruthy();
    expect(numbers.getByText('XP · 2 skills')).toBeTruthy();
    expect(numbers.getByText('22')).toBeTruthy();
    expect(screen.getByRole('img', { name: /^Session timeline, 2 h/ })).toBeTruthy();

    const older = screen.getByRole('link', { name: '← Older' });
    expect(older.getAttribute('href')).toBe(`/sessions/${String(DETAIL.neighbors.olderId)}`);
    expect(screen.queryByRole('link', { name: 'Newer →' })).toBeNull();

    expect(
      within(screen.getByRole('list', { name: 'XP by skill' })).getByText('Slayer'),
    ).toBeTruthy();
    const kc = within(screen.getByRole('list', { name: 'Kill count' }));
    expect(kc.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'VoVorkath394 → 412+18',
      'ZuZulrah1 → 5+4',
    ]);
    const loot = within(screen.getByRole('list', { name: 'Loot' }));
    expect(loot.getAllByRole('listitem')[0]?.textContent).toContain('Draconic visage +1 more');
  });

  it("goes back to the session's own account, or to all accounts if that was chosen", async () => {
    mockApi({ [PATH]: { body: DETAIL } });
    localStorage.setItem('lastAccount', '2');
    renderApp(`/sessions/${ID}`);
    const back = await screen.findByRole('link', { name: '← Sessions' });
    expect(back.getAttribute('href')).toBe('/1/activity/sessions');
    // Its own top row (`MobileSession`): the title only for screen readers, no
    // sub-tabs and no account switcher.
    const title = screen.getByRole('heading', { level: 1, name: 'Session' });
    expect(title.className).toContain('sr-only');
    expect(screen.queryByRole('navigation', { name: 'Activity views' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Choose account/ })).toBeNull();
  });

  it('goes back to all accounts when that was the last choice', async () => {
    mockApi({ [PATH]: { body: DETAIL } });
    localStorage.setItem('lastAccount', 'all');
    renderApp(`/sessions/${ID}`);
    const back = await screen.findByRole('link', { name: '← Sessions' });
    expect(back.getAttribute('href')).toBe('/all/activity/sessions');
  });

  it('polls every 30 s while the session is open, not in the background', async () => {
    mockApi({ [PATH]: { body: OPEN } });
    const { queryClient } = renderApp(`/sessions/${ID}`);
    expect(await screen.findByText('Live')).toBeTruthy();
    const { query, options } = pollingOf(queryClient);
    expect(options.refetchInterval(query)).toBe(LIVE_POLL_MS);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  it('does not poll a closed session', async () => {
    mockApi({ [PATH]: { body: DETAIL } });
    const { queryClient } = renderApp(`/sessions/${ID}`);
    await screen.findByText(/ended by logout/);
    const { query, options } = pollingOf(queryClient);
    expect(options.refetchInterval(query)).toBe(false);
  });

  it('shows a full-page 404 for an unknown or malformed session ID', async () => {
    mockApi({
      [PATH]: error(404, 'NOT_FOUND'),
      '/api/v1/sessions/nope': error(400, 'VALIDATION_ERROR', 'params.sessionId'),
    });
    renderApp(`/sessions/${ID}`);
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
    expect(screen.getByText(SESSION_NOT_FOUND)).toBeTruthy();

    renderApp('/sessions/nope');
    await waitFor(() => {
      expect(screen.getAllByText(SESSION_NOT_FOUND)).toHaveLength(2);
    });
  });

  it('shows a retry for other errors', async () => {
    mockApi({ [PATH]: error(500, 'INTERNAL_ERROR') });
    renderApp(`/sessions/${ID}`);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('Session detail on PC', () => {
  beforeEach(() => {
    stubDesktop();
  });

  it("redirects to the list with the session selected, in the session's own account", async () => {
    mockApi({
      [PATH]: { body: DETAIL },
      '/api/v1/accounts/1/sessions': { body: { items: [DETAIL.session], nextCursor: null } },
    });
    localStorage.setItem('lastAccount', '2');
    const { router } = renderApp(`/sessions/${ID}`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/1/activity/sessions');
    });
    expect(router.state.location.search).toBe(`?session=${ID}`);
    expect(router.state.historyAction).toBe('REPLACE');
    expect(await screen.findByRole('region', { name: 'Sun 8 Nov · 19:00–21:00' })).toBeTruthy();
  });

  it('redirects to all accounts when that was the last choice', async () => {
    mockApi({
      [PATH]: { body: DETAIL },
      '/api/v1/accounts/all/sessions': { body: { items: [DETAIL.session], nextCursor: null } },
    });
    localStorage.setItem('lastAccount', 'all');
    const { router } = renderApp(`/sessions/${ID}`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all/activity/sessions');
    });
    expect(router.state.location.search).toBe(`?session=${ID}`);
  });

  it('keeps the full-page 404 for an unknown session', async () => {
    mockApi({ [PATH]: error(404, 'NOT_FOUND') });
    renderApp(`/sessions/${ID}`);
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
  });
});

describe('Session detail: hop chain', () => {
  // Account 1: three parts joined by hops 20 s apart, after an unrelated session.
  const BEFORE = makeSession(20, '2026-11-08T10:00:00.000Z', '2026-11-08T11:00:00.000Z');
  const P1 = makeSession(21, '2026-11-08T18:03:40.000Z', '2026-11-08T18:14:30.000Z', {
    endReason: 'hop',
    world: 351,
  });
  const P2 = makeSession(22, '2026-11-08T18:14:36.000Z', '2026-11-08T18:17:04.000Z', {
    endReason: 'hop',
    world: 304,
  });
  const P3 = makeSession(23, '2026-11-08T18:17:10.000Z', '2026-11-08T18:17:29.000Z', {
    world: 311,
  });
  const chainApi = () => ({
    [`/api/v1/sessions/${BEFORE.id}`]: { body: makeDetail(BEFORE, { newerId: P1.id }) },
    [`/api/v1/sessions/${P1.id}`]: {
      body: makeDetail(P1, { olderId: BEFORE.id, newerId: P2.id }),
    },
    [`/api/v1/sessions/${P2.id}`]: { body: makeDetail(P2, { olderId: P1.id, newerId: P3.id }) },
    [`/api/v1/sessions/${P3.id}`]: { body: makeDetail(P3, { olderId: P2.id }) },
  });

  it('walks the neighbours for a direct link and marks the current part', async () => {
    mockApi(chainApi());
    renderApp(`/sessions/${P2.id}`);
    const bar = await screen.findByRole('navigation', { name: 'World hops' });
    expect(bar.textContent).toContain('Part 2 of 3');
    const links = within(bar).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/sessions/${P1.id}`,
      `/sessions/${P2.id}`,
      `/sessions/${P3.id}`,
    ]);
    expect(links.map((link) => link.textContent)).toEqual([
      '19:03–19:14·World 351·10 min',
      '19:14–19:17·World 304·2 min',
      '19:17–19:17·World 311·0 min',
    ]);
    expect(links[1]?.getAttribute('aria-current')).toBe('page');
  });

  it('has no bar for a session without hops', async () => {
    mockApi(chainApi());
    renderApp(`/sessions/${BEFORE.id}`);
    await screen.findByRole('region', { name: 'Session summary' });
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'World hops' })).toBeNull();
    });
  });
});

describe('Session detail: new collection log items', () => {
  const S = makeSession(40, '2026-11-08T18:00:00.000Z', '2026-11-08T20:00:00.000Z', {
    newCollectionLogCount: 2,
  });
  const item = (itemId: number, name: string, at: string, approximate = false) => ({
    itemId,
    name,
    tab: 'Raids',
    page: 'The Fractured Archive',
    pageObtained: 2,
    pageTotal: 9,
    at,
    approximate,
  });
  const CLOG = makeDetail(
    S,
    {},
    {
      collectionLog: {
        obtained: 341,
        total: 1734,
        items: [
          item(34719, 'Rondache', '2026-11-08T19:39:58.802Z'),
          item(30001, 'Zorya’s tome', '2026-11-08T20:02:30.000Z', true),
        ],
      },
    },
  );

  it('shows the section first on mobile, with links to the pages and the approximate time', async () => {
    mockApi({ [`/api/v1/sessions/${S.id}`]: { body: CLOG } });
    renderApp(`/sessions/${S.id}`);
    const section = await screen.findByRole('region', { name: 'Collection log' });
    // The first card, before XP by skill.
    const cards = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
    expect(cards.indexOf('Collection log')).toBeLessThan(cards.indexOf('XP by skill'));
    const card = within(section);
    expect(card.getByText('2 new')).toBeTruthy();
    expect(card.getByRole('link', { name: '341 of 1,734 →' }).getAttribute('href')).toBe(
      '/1/collections/log',
    );
    expect(card.getByRole('link', { name: 'Rondache' }).getAttribute('href')).toBe(
      '/1/collections/log?tab=raids&page=the-fractured-archive',
    );
    expect(card.getByText('20:39')).toBeTruthy();
    expect(card.getByText(/~21:02/).textContent).toBe(
      '~21:02, found by the sync after the session',
    );
    // No fifth number on mobile.
    const numbers = within(screen.getByRole('region', { name: 'Session summary' }));
    expect(numbers.queryByText(/new collection log/)).toBeNull();
    expect(screen.getByRole('img', { name: /2 new collection log items$/ })).toBeTruthy();
  });

  it('has no section for a session without new items', async () => {
    mockApi({
      [`/api/v1/sessions/${S.id}`]: { body: makeDetail({ ...S, newCollectionLogCount: 0 }) },
    });
    renderApp(`/sessions/${S.id}`);
    await screen.findByRole('region', { name: 'Session summary' });
    expect(screen.queryByRole('region', { name: 'Collection log' })).toBeNull();
  });

  it('shows more than six items as tiles', async () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      item(40_000 + index, `Item ${String(index)}`, `2026-11-08T18:${String(10 + index)}:00.000Z`),
    );
    mockApi({
      [`/api/v1/sessions/${S.id}`]: {
        body: makeDetail(
          { ...S, newCollectionLogCount: 7 },
          {},
          {
            collectionLog: { obtained: 347, total: 1734, items: many },
          },
        ),
      },
    });
    renderApp(`/sessions/${S.id}`);
    const section = within(await screen.findByRole('region', { name: 'Collection log' }));
    expect(
      section.getAllByRole('link', { name: /^Item \d, The Fractured Archive, 19:1\d$/ }),
    ).toHaveLength(7);
  });

  it('shows 14 new items as a grid with names, pages, times and tooltips', async () => {
    stubDesktop();
    // Fourteen items from several pages, the last two found by the sync after the session.
    const pages = ['Vorkath', 'Zulrah', 'Duke Sucellus', 'Araxxor'];
    const fourteen = Array.from({ length: 14 }, (_, index) => ({
      ...item(
        41_000 + index,
        `Item ${String(index + 1)}`,
        `2026-11-08T18:${String(10 + index)}:00.000Z`,
        index >= 12,
      ),
      tab: 'Bosses',
      page: pages[index % pages.length] ?? 'Vorkath',
    }));
    mockApi({
      [`/api/v1/sessions/${S.id}`]: {
        body: makeDetail(
          { ...S, newCollectionLogCount: 14 },
          {},
          { collectionLog: { obtained: 355, total: 1734, items: fourteen } },
        ),
      },
    });
    renderApp(`/sessions/${S.id}`);
    const region = await screen.findByRole('region', { name: 'Collection log' });
    const section = within(region);
    expect(region.textContent).toContain('14 new');
    expect(section.getByRole('link', { name: '355 of 1,734 →' })).toBeTruthy();
    // One grid of 14 tiles, not rows.
    const grid = section.getByRole('list', { name: 'New collection log items' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(14);
    expect(grid.className).toContain('desk:grid-cols-8');
    // Each tile is a link to its page, named with item, page and time; the
    // time from the sync after the session has "~".
    const first = section.getByRole('link', { name: 'Item 1, Vorkath, 19:10' });
    expect(first.getAttribute('href')).toBe('/1/collections/log?tab=bosses&page=vorkath');
    expect(section.getByRole('link', { name: 'Item 14, Zulrah, ~19:23' })).toBeTruthy();
    expect(
      section.getByText('Hover an item for its name, page and time. Click to open its page.'),
    ).toBeTruthy();
    // The tooltip has the same three lines.
    await userEvent.hover(first);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Item 1');
    expect(tooltip.textContent).toContain('Vorkath');
    expect(tooltip.textContent).toContain('19:10');
  });
});

describe('Session detail: sections by the six-row rule', () => {
  const S = makeSession(30, '2026-11-08T18:00:00.000Z', '2026-11-08T20:00:00.000Z');
  const SKILLS = [
    'SLAYER',
    'RANGED',
    'HITPOINTS',
    'MAGIC',
    'DEFENCE',
    'PRAYER',
    'ATTACK',
    'COOKING',
  ];
  const BOSSES = [
    'Vorkath',
    'Zulrah',
    'Araxxor',
    'Duke Sucellus',
    'Vardorvis',
    'Callisto',
    'Vetion',
  ];
  const drop = (n: number, value: number, minute: number) => ({
    id: n,
    occurredAt: new Date(Date.parse(S.startedAt) + minute * 60_000).toISOString(),
    source: { type: 'NPC' as const, name: 'Vorkath' },
    killCount: null,
    geValue: value,
    haValue: 0,
    items: [
      {
        itemId: 1000 + n,
        name: `Item ${String(n)}`,
        quantity: 1,
        gePriceEach: value,
        haPriceEach: 0,
      },
    ],
  });
  const NEWER = makeSession(31, '2026-11-08T21:00:00.000Z', '2026-11-08T21:30:00.000Z');
  const BIG = makeDetail(
    S,
    { newerId: NEWER.id },
    {
      xp: SKILLS.map((skill, index) => ({
        skill,
        xpGained: 100_000 - index * 10_000,
        startLevel: 80,
        endLevel: index === 0 ? 81 : 80,
      })),
      kc: BOSSES.map((boss, index) => ({
        boss,
        startKillCount: 10,
        endKillCount: 20 - index,
        gained: 10 - index,
      })),
      // Oldest first, as the API gives them; values not in time order.
      loot: [
        drop(1, 500, 5),
        drop(2, 9_000, 10),
        drop(3, 100, 15),
        drop(4, 7_000, 20),
        drop(5, 300, 25),
        drop(6, 8_000, 30),
        drop(7, 50, 35),
      ],
    },
  );

  const api = () => ({
    [`/api/v1/sessions/${S.id}`]: { body: BIG },
    [`/api/v1/sessions/${NEWER.id}`]: {
      body: makeDetail(NEWER, { olderId: S.id }, { xp: BIG.xp }),
    },
  });

  it('shows six skills, then all of them as a compact grid', async () => {
    const user = userEvent.setup();
    mockApi(api());
    renderApp(`/sessions/${S.id}`);
    const xp = await screen.findByRole('region', { name: 'XP by skill' });
    expect(within(xp).getByText('Top 6 of 8')).toBeTruthy();
    expect(within(within(xp).getByRole('list')).getAllByRole('listitem')).toHaveLength(6);

    await user.click(within(xp).getByRole('button', { name: 'Show all (8)' }));
    const grid = within(xp).getByRole('list', { name: 'XP by skill' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(8);
    expect(within(xp).getByText('8 skills')).toBeTruthy();
    // The level-up shows in the grid.
    expect(within(grid).getByLabelText('Level 80 → 81')).toBeTruthy();
    expect(within(xp).getByRole('button', { name: 'Show fewer' })).toBeTruthy();
  });

  it('shows six bosses and six drops, then all', async () => {
    const user = userEvent.setup();
    mockApi(api());
    renderApp(`/sessions/${S.id}`);
    const kc = await screen.findByRole('region', { name: 'Kill count' });
    expect(within(kc).getAllByRole('listitem')).toHaveLength(6);
    await user.click(within(kc).getByRole('button', { name: 'Show all (7)' }));
    expect(within(kc).getAllByRole('listitem')).toHaveLength(7);

    const loot = screen.getByRole('region', { name: 'Loot' });
    expect(within(loot).getAllByRole('listitem')).toHaveLength(6);
    await user.click(within(loot).getByRole('button', { name: 'Show all (7)' }));
    expect(within(loot).getAllByRole('listitem')).toHaveLength(7);
  });

  it('orders loot by value or by time', async () => {
    const user = userEvent.setup();
    mockApi(api());
    renderApp(`/sessions/${S.id}`);
    const loot = await screen.findByRole('region', { name: 'Loot' });
    const names = () =>
      within(within(loot).getByRole('list', { name: 'Loot' }))
        .getAllByRole('listitem')
        .map((row) => /Item \d/.exec(row.textContent)?.[0]);
    expect(names()).toEqual(['Item 2', 'Item 6', 'Item 4', 'Item 1', 'Item 5', 'Item 3']);
    await user.click(within(loot).getByRole('radio', { name: 'Time' }));
    expect(names()).toEqual(['Item 1', 'Item 2', 'Item 3', 'Item 4', 'Item 5', 'Item 6']);
  });

  it('starts every section again on Newer', async () => {
    const user = userEvent.setup();
    mockApi(api());
    renderApp(`/sessions/${S.id}`);
    const xp = await screen.findByRole('region', { name: 'XP by skill' });
    await user.click(within(xp).getByRole('button', { name: 'Show all (8)' }));
    await user.click(screen.getByRole('link', { name: 'Newer →' }));
    expect(await screen.findByText(/Sun 8 Nov · 22:00–22:30/)).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'XP by skill' })).getByText('Top 6 of 8'),
    ).toBeTruthy();
  });
});
