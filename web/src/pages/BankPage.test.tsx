import {
  BANK_FILLER_ITEM_ID,
  type AccountBank,
  type BankItemResponse,
  type BankResponse,
  type ContainerItemResponse,
} from '@fireside/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import historyFixture from '../../../shared/fixtures/api/bank-history-response/valid/dst-carry-forward.json';
import bankAll from '../../../shared/fixtures/api/bank-response/valid/all.json';
import bankNoData from '../../../shared/fixtures/api/bank-response/valid/no-data.json';
import bankOne from '../../../shared/fixtures/api/bank-response/valid/one-account.json';
import summaryNoData from '../../../shared/fixtures/api/bank-summary-response/valid/no-data.json';
import summaryOne from '../../../shared/fixtures/api/bank-summary-response/valid/one-account.json';
import potionsAll from '../../../shared/fixtures/api/potion-storage-response/valid/all.json';
import potionsNoData from '../../../shared/fixtures/api/potion-storage-response/valid/no-data.json';
import potionsOne from '../../../shared/fixtures/api/potion-storage-response/valid/one-account.json';
import moversNothing from '../../../shared/fixtures/api/price-movers-response/valid/nothing-moved.json';
import moversNone from '../../../shared/fixtures/api/price-movers-response/valid/no-history-yet.json';
import moversDay from '../../../shared/fixtures/api/price-movers-response/valid/only-24h.json';
import moversThree from '../../../shared/fixtures/api/price-movers-response/valid/three-periods.json';
import {
  findMainNav,
  mockApi,
  renderApp,
  stubDesktop,
  stubResizableLayout,
  type MockAnswer,
} from '@/test/render-app';

// The accounts fixture has 1 ("Test Main", ironman) and 2 ("Alt"). Account 1's
// bank fixture, in container order: tab 1 (Armadyl godsword, Bandos
// chestplate, a Twisted bow placeholder), tab 2 (48 Prayer potion(4), 320
// Shark), main tab (12.5M coins, 4,200 platinum tokens, a chisel). GE 41.69M,
// HA 17.66M, cash 16.83M. Inventory 235,400 gp, equipment (whip and rune
// arrows) 1,549,500 gp, potion storage 984,876 gp (312 + 7 doses).

const ONE = bankOne as BankResponse;
const [BANK] = ONE.banks as [AccountBank];

/** A bank answer for one account, with valid sums, from `[tab, name, quantity, price, id?]`. */
type Spec = [tab: number, name: string, quantity: number, price?: number, itemId?: number];

function bankOf(specs: readonly Spec[], extra: Partial<AccountBank> = {}): BankResponse {
  // Container order: tabs 1–9, then the main tab.
  const ordered = [...specs].sort((a, b) => (a[0] === 0 ? 10 : a[0]) - (b[0] === 0 ? 10 : b[0]));
  const items: BankItemResponse[] = ordered.map(([tab, name, quantity, price = 0, itemId], i) => ({
    position: i,
    tab,
    itemId: itemId ?? 30_000 + i,
    name,
    quantity,
    placeholder: quantity === 0,
    gePriceEach: price,
    gePriceSource: 'SNAPSHOT',
    haPriceEach: price,
    geValue: quantity * price,
    haValue: quantity * price,
  }));
  const sum = (rows: readonly BankItemResponse[]) =>
    rows.reduce((total, row) => total + row.geValue, 0);
  const tabs = [...new Set([...items.map((item) => item.tab).filter((tab) => tab !== 0), 0])].map(
    (tab) => {
      const rows = items.filter((item) => item.tab === tab);
      return { tab, itemCount: rows.length, geValue: sum(rows), haValue: sum(rows) };
    },
  );
  const totals = { geValue: sum(items), haValue: sum(items), cashValue: 0 };
  const bank: AccountBank = {
    accountId: 1,
    takenAt: '2026-11-08T19:42:13.512Z',
    totals,
    tabs,
    items,
    inventory: { geValue: 0, haValue: 0, items: [] },
    equipment: { geValue: 0, haValue: 0, items: [] },
    ...extra,
  };
  return { banks: [bank], totals, prices: { source: 'SNAPSHOT', fetchedAt: null } };
}

interface Data {
  bank?: unknown;
  potions?: unknown;
  summary?: unknown;
  answers?: Record<string, MockAnswer>;
}

function mockBank(scope: string, { bank, potions, summary, answers = {} }: Data = {}) {
  return mockApi({
    '/api/v1/accounts/all/bank/summary': { body: summary ?? summaryOne },
    [`/api/v1/accounts/${scope}/bank`]: { body: bank ?? bankOne },
    [`/api/v1/accounts/${scope}/potion-storage`]: { body: potions ?? potionsOne },
    [`/api/v1/accounts/${scope}/bank/history`]: { body: historyFixture },
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

/** The card (`section`) with a heading that starts with `name`. */
async function card(name: string) {
  const heading = await screen.findByRole('heading', { level: 2, name: new RegExp(`^${name}`) });
  const section = heading.closest('section');
  if (!section) throw new Error(`No card for ${name}`);
  return { section, ...within(section) };
}

function first(elements: readonly HTMLElement[]): HTMLElement {
  const [element] = elements;
  if (!element) throw new Error('No element');
  return element;
}

/** Slot variants in a grid, in order. */
function slots(grid: HTMLElement): (string | null)[] {
  return [...grid.querySelectorAll('[data-slot-variant]')].map((slot) =>
    slot.getAttribute('data-slot-variant'),
  );
}

/** Names of the bank's grids (one per tab shown), in order. */
function gridNames(section: HTMLElement): (string | null)[] {
  return within(section)
    .getAllByRole('img')
    .map((grid) => grid.getAttribute('aria-label'));
}

describe('Bank', () => {
  beforeEach(() => {
    // Only Date is faked, so Testing Library's timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    // PC: every card on one page. Mobile has its own tests (sections) at the end.
    stubDesktop();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the four numbers: net worth is bank + potion storage + carried', async () => {
    mockBank('1');
    renderApp('/1/bank');
    // The row is there from the start (skeletons while loading): wait for the numbers.
    await screen.findByText('44.46M');
    const summary = within(screen.getByRole('region', { name: 'Bank summary' }));
    // 41,691,210 + 984,876 + 235,400 + 1,549,500, large, with its age.
    expect(summary.getByText('Net worth · GE')).toBeTruthy();
    expect(summary.getByText('44.46M').parentElement?.textContent).toBe('44.46Mgp');
    expect(
      summary.getByText('Updated Sun 8 Nov, 20:42 · when the bank was last closed'),
    ).toBeTruthy();
    // Bank + potion storage, carried and cash next to it.
    expect(summary.getByText('42.68M gp')).toBeTruthy();
    expect(summary.getByText('1.78M gp')).toBeTruthy();
    expect(summary.getByText('16.83M gp')).toBeTruthy();
    // The count of items moved to the Bank card: neither placeholders nor fillers.
    expect((await card('Bank')).getByText('7 items · 1 placeholder')).toBeTruthy();
    // The value type sits in the row, not in the top bar.
    expect(summary.getByRole('radio', { name: 'GE' }).getAttribute('aria-checked')).toBe('true');
  });

  it('draws the bank like the game: main tab first, then tabs 1–9, placeholders greyed', async () => {
    mockBank('1');
    renderApp('/1/bank');
    const bank = await card('Bank');
    expect(gridNames(bank.section)).toEqual([
      'Main tab: 3 items worth 16.7M gp',
      'Tab 1: 2 items worth 24.3M gp',
      'Tab 2: 2 items worth 691K gp',
    ]);
    const tabOne = bank.getByRole('img', { name: /^Tab 1/ });
    expect(slots(tabOne)).toEqual(['item', 'item', 'placeholder']);
    // "All", "Main" and one button per tab with slots.
    const buttons = within(bank.getByRole('group', { name: 'Bank tabs' })).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'All tabs',
      'Main tab',
      'Tab 1',
      'Tab 2',
    ]);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    // Slots are not tab stops.
    expect(tabOne.querySelector('[tabindex]')).toBeNull();
  });

  it('chooses a tab from the tab buttons and from "By tab", in the URL', async () => {
    mockBank('1');
    const { router } = renderApp('/1/bank');
    const user = userEvent.setup();
    const bank = await card('Bank');
    await user.click(bank.getByRole('button', { name: 'Tab 2' }));
    expect(router.state.location.search).toBe('?tab=2');
    expect(gridNames(bank.section)).toEqual(['Tab 2: 2 items worth 691K gp']);
    // "Most valuable" follows the tab (each row starts with the placeholder icon's letters).
    const most = await card('Most valuable');
    expect(most.getByText('Tab 2 · GE')).toBeTruthy();
    expect(most.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'PrPrayer potion(4) × 48442K gp',
      'ShShark × 320250K gp',
    ]);

    const byTab = await card('By tab');
    const rows = within(byTab.getByRole('list', { name: 'Value by tab' })).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Main tab16.7M gp',
      'Tab 124.3M gp',
      'Tab 2691K gp',
    ]);
    expect(rows[2]?.getAttribute('aria-pressed')).toBe('true');
    await user.click(first(rows));
    expect(router.state.location.search).toBe('?tab=main');
    expect(gridNames(bank.section)).toEqual(['Main tab: 3 items worth 16.7M gp']);
    expect(bank.getByRole('button', { name: 'Main tab' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // A second click on the chosen row goes back to All.
    await user.click(first(within(byTab.getByRole('list')).getAllByRole('button')));
    expect(router.state.location.search).toBe('');
    expect(gridNames(bank.section)).toHaveLength(3);
    // A new tab is a step in the history.
    await router.navigate(-1);
    await waitFor(() => {
      expect(router.state.location.search).toBe('?tab=main');
    });
  });

  it('falls back to All for a tab that has no slots', async () => {
    mockBank('1');
    renderApp('/1/bank?tab=7');
    const bank = await card('Bank');
    expect(gridNames(bank.section)).toHaveLength(3);
  });

  it('switches every number, list and chart label between GE and HA', async () => {
    mockBank('1');
    const { router } = renderApp('/1/bank');
    const user = userEvent.setup();
    await screen.findByText('44.46M');
    await user.click(screen.getByRole('radio', { name: 'HA' }));
    expect(router.state.location.search).toBe('?value=ha');
    // 17,659,689 + 315 + 130,472 + HA of the equipment.
    expect(screen.getAllByText('Net worth · HA')).toHaveLength(2);
    expect(screen.queryByText('44.46M')).toBeNull();
    const bank = await card('Bank');
    expect(gridNames(bank.section)[1]).toBe('Tab 1: 2 items worth 909K gp');
    expect((await card('Most valuable')).getByText('All tabs · HA')).toBeTruthy();
    expect((await card('Value over time')).getByText('Net worth · HA')).toBeTruthy();
    // Cash is the same in both.
    expect(
      within(screen.getByRole('region', { name: 'Bank summary' })).getByText('16.83M gp'),
    ).toBeTruthy();
  });

  it('searches every tab at once, without tab buttons', async () => {
    mockBank('1');
    const { router } = renderApp('/1/bank?tab=2');
    const user = userEvent.setup();
    const bank = await card('Bank');
    await user.type(bank.getByRole('searchbox', { name: 'Search the bank' }), 'o');
    // The tab stays in the URL; the search replaces the URL.
    expect(router.state.location.search).toBe('?tab=2&q=o');
    expect(bank.queryByRole('group', { name: 'Bank tabs' })).toBeNull();
    // Display order: Coins, Platinum token, Godsword, Bandos chestplate, Twisted bow
    // (placeholder), Prayer potion.
    const grid = bank.getByRole('img');
    expect(grid.getAttribute('aria-label')).toBe('5 items matching “o”, worth 41.44M gp');
    expect(slots(grid)).toEqual(['item', 'item', 'item', 'item', 'placeholder', 'item']);
    expect(bank.getByText('5 items')).toBeTruthy();

    await user.type(bank.getByRole('searchbox'), 'zzz');
    expect(bank.getByText('Nothing in the bank matches “ozzz”.')).toBeTruthy();
    expect(bank.queryByRole('img')).toBeNull();
  });

  it('keeps what is typed in the search field and follows the URL when it changes elsewhere', async () => {
    mockBank('1');
    const { router } = renderApp('/1/bank?q=rune');
    const bank = await card('Bank');
    const field = () => bank.getByRole<HTMLInputElement>('searchbox');
    expect(field().value).toBe('rune');
    // Typed text is the field's own: it never waits for the URL to come back.
    await userEvent.type(field(), ' arrow');
    expect(field().value).toBe('rune arrow');
    await waitFor(() => {
      expect(router.state.location.search).toBe('?q=rune+arrow');
    });
    expect(field().value).toBe('rune arrow');
    // A change that did not come from typing, e.g. a link or the back button.
    await router.navigate('/1/bank?q=shark');
    await waitFor(() => {
      expect(field().value).toBe('shark');
    });
    await router.navigate('/1/bank');
    await waitFor(() => {
      expect(field().value).toBe('');
    });
  });

  it('hides placeholders but keeps their space', async () => {
    mockBank('1');
    const { router } = renderApp('/1/bank');
    const user = userEvent.setup();
    const bank = await card('Bank');
    await user.click(bank.getByRole('switch', { name: 'Placeholders' }));
    expect(router.state.location.search).toBe('?placeholders=off');
    expect(slots(bank.getByRole('img', { name: /^Tab 1/ }))).toEqual(['item', 'item', 'empty']);
    // A hidden placeholder is no search match either.
    await user.type(bank.getByRole('searchbox'), 'bow');
    expect(bank.getByText('Nothing in the bank matches “bow”.')).toBeTruthy();
  });

  it('shows the chosen tab as a list sorted by value, without placeholders', async () => {
    mockBank('1');
    const { router } = renderApp('/1/bank?tab=1');
    const user = userEvent.setup();
    const bank = await card('Bank');
    await user.click(bank.getByRole('button', { name: 'Show as list' }));
    expect(router.state.location.search).toBe('?tab=1&view=list');
    const rows = within(bank.getByRole('table')).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'ItemQuantityValue',
      'BaBandos chestplate114.5M gp',
      'ArArmadyl godsword19.8M gp',
    ]);
    expect(bank.queryByRole('img')).toBeNull();
    await user.click(bank.getByRole('button', { name: 'Show as grid' }));
    expect(bank.getByRole('img', { name: /^Tab 1/ })).toBeTruthy();
  });

  it('says so when the list has nothing to show, instead of an empty table', async () => {
    const bank = bankOf([
      [1, 'Twisted bow', 0, 1000],
      [1, 'Bank filler', 1, 0, BANK_FILLER_ITEM_ID],
      [0, 'Coins', 100, 1],
    ]);
    mockBank('1', { bank, potions: potionsNoData });
    renderApp('/1/bank?view=list&tab=1');
    const user = userEvent.setup();
    const view = await card('Bank');
    // A tab with only a placeholder and a filler.
    expect(view.getByText('Only placeholders and reserved slots here.')).toBeTruthy();
    expect(view.queryByRole('table')).toBeNull();
    // A search that only a placeholder matches is no match in the list.
    await user.type(view.getByRole('searchbox'), 'bow');
    expect(view.getByText('Nothing in the bank matches “bow”.')).toBeTruthy();
    expect(view.queryByRole('table')).toBeNull();
    // In the grid the placeholder is a match.
    await user.click(view.getByRole('button', { name: 'Show as grid' }));
    expect(slots(view.getByRole('img'))).toEqual(['placeholder']);
  });

  it('lists 15 rows before "Show all"', async () => {
    const specs = Array.from({ length: 20 }, (_, i): Spec => [0, `Item ${String(i)}`, 1, 100 - i]);
    mockBank('1', { bank: bankOf(specs), potions: potionsNoData });
    renderApp('/1/bank?view=list');
    const user = userEvent.setup();
    const bank = await card('Bank');
    expect(within(bank.getByRole('table')).getAllByRole('row')).toHaveLength(16);
    await user.click(bank.getByRole('button', { name: 'Show all (20)' }));
    expect(within(bank.getByRole('table')).getAllByRole('row')).toHaveLength(21);
  });

  it('shows fillers as reserved empty slots and never counts or values them', async () => {
    const bank = bankOf([
      [1, 'Abyssal whip', 1, 1_500_000],
      [1, 'Bank filler', 1, 0, BANK_FILLER_ITEM_ID],
      [1, 'Bank filler', 1, 0, BANK_FILLER_ITEM_ID],
      [0, 'Coins', 100, 1],
    ]);
    mockBank('1', { bank, potions: potionsNoData });
    renderApp('/1/bank');
    const user = userEvent.setup();
    const view = await card('Bank');
    const tabOne = view.getByRole('img', { name: 'Tab 1: 1 item worth 1.5M gp' });
    expect(slots(tabOne)).toEqual(['item', 'filler', 'filler']);
    // No icon in a filler.
    expect(tabOne.querySelectorAll('[data-icon-status]')).toHaveLength(1);
    expect(screen.getByText('2 items · 0 placeholders')).toBeTruthy();
    // Never a search match, never in the list.
    await user.type(view.getByRole('searchbox'), 'filler');
    expect(view.getByText('Nothing in the bank matches “filler”.')).toBeTruthy();
    await user.clear(view.getByRole('searchbox'));
    await user.click(view.getByRole('button', { name: 'Show as list' }));
    expect(within(view.getByRole('table')).getAllByRole('row')).toHaveLength(3);
  });

  it('shows the first 160 slots of a bank with more than 240, until "Show all"', async () => {
    // Display order: main tab (700 slots), tab 1 (100), tab 2 (100).
    const specs = Array.from({ length: 900 }, (_, i): Spec => [
      i < 100 ? 1 : i < 200 ? 2 : 0,
      'Item',
      1,
      1,
    ]);
    mockBank('1', { bank: bankOf(specs), potions: potionsNoData });
    renderApp('/1/bank');
    const user = userEvent.setup();
    const bank = await card('Bank');
    const count = () => bank.section.querySelectorAll('[data-slot-variant]').length;
    expect(count()).toBe(160);
    // The separator keeps the tab's real count.
    expect(gridNames(bank.section)).toEqual(['Main tab: 700 items worth 700 gp']);

    await user.click(bank.getByRole('button', { name: 'Show all (900 slots)' }));
    expect(count()).toBe(900);
    expect(gridNames(bank.section)).toHaveLength(3);
    await user.click(bank.getByRole('button', { name: 'Show less' }));
    expect(count()).toBe(160);

    // A chosen tab always shows everything, with no button.
    await user.click(bank.getByRole('button', { name: 'Main tab' }));
    expect(count()).toBe(700);
    expect(bank.queryByRole('button', { name: /^Show (all|less)/ })).toBeNull();
  });

  it('shows a bank of 240 slots whole', async () => {
    const specs = Array.from({ length: 240 }, (): Spec => [0, 'Item', 1, 1]);
    mockBank('1', { bank: bankOf(specs), potions: potionsNoData });
    renderApp('/1/bank');
    const bank = await card('Bank');
    expect(bank.section.querySelectorAll('[data-slot-variant]')).toHaveLength(240);
    expect(bank.queryByRole('button', { name: /^Show all/ })).toBeNull();
    // Without tabs 1–9: no tab buttons and no "By tab".
    expect(bank.queryByRole('group', { name: 'Bank tabs' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^By tab/ })).toBeNull();
    expect((await card('Most valuable')).getByText('GE')).toBeTruthy();
  });

  it('shows potion storage with doses, and hides it for an account without one', async () => {
    mockBank('1');
    const { queryClient } = renderApp('/1/bank');
    const potions = await card('Potion storage');
    const grid = potions.getByRole('img');
    expect(grid.getAttribute('aria-label')).toBe(
      'Potion storage: 2 potions, 319 doses, worth 985K gp',
    );
    expect(grid.textContent).toContain('312');
    queryClient.clear();

    mockBank('1', { potions: potionsNoData });
    renderApp('/1/bank');
    await waitFor(() => {
      expect(screen.getAllByRole('heading', { name: /^Carried/ }).length).toBeGreaterThan(1);
    });
    expect(screen.getAllByRole('heading', { name: /^Potion storage/ })).toHaveLength(1);
  });

  it('shows what was carried: the inventory as 4 × 7 and the equipment like the game', async () => {
    mockBank('1');
    renderApp('/1/bank');
    const carried = await card('Carried');
    const inventory = carried.getByRole('img', { name: 'Inventory: 2 items worth 235K gp' });
    expect(slots(inventory)).toEqual(['item', 'item', ...Array<string>(26).fill('hole')]);
    const equipment = carried.getByRole('img', { name: 'Equipment: 2 items worth 1.55M gp' });
    // No quiver ammo in the data: the top right slot is a gap, not a frame.
    expect(slots(equipment)).toEqual([
      ...['empty', 'hole', 'empty'],
      ...['hole', 'hole', 'item'],
      ...['item', 'hole', 'hole'],
      ...['empty', 'hole', 'empty'],
      ...['hole', 'hole', 'hole'],
    ]);
  });

  it('shows the second ammo slot above Ammo when the data has it', async () => {
    const worn = (slot: string, name: string): ContainerItemResponse => ({
      position: 0,
      slot,
      itemId: 11212,
      name,
      quantity: 80,
      gePriceEach: 10,
      gePriceSource: 'SNAPSHOT',
      haPriceEach: 1,
      geValue: 800,
      haValue: 80,
    });
    const equipment = {
      geValue: 1600,
      haValue: 160,
      items: [worn('AMMO', 'Rune arrow'), { ...worn('QUIVER_AMMO', 'Dragon arrow'), position: 1 }],
    };
    mockBank('1', {
      bank: { ...ONE, banks: [{ ...BANK, equipment }] },
    });
    renderApp('/1/bank');
    const carried = await card('Carried');
    const grid = carried.getByRole('img', { name: /^Equipment/ });
    expect(slots(grid).slice(0, 6)).toEqual(['empty', 'hole', 'item', 'hole', 'hole', 'item']);
  });

  it('asks for a year of history by default, also for an invalid range', async () => {
    const path = '/api/v1/accounts/1/bank/history';
    const fetchMock = mockBank('1');
    const { router } = renderApp('/1/bank?range=7d');
    const user = userEvent.setup();
    const chart = await card('Value over time');
    await waitFor(() => {
      expect(requests(fetchMock, path)).toHaveLength(1);
    });
    // No range: the API's own rolling year.
    expect([...(requests(fetchMock, path)[0] ?? [])]).toEqual([]);
    expect(chart.getByRole('radio', { name: '1 y' }).getAttribute('aria-checked')).toBe('true');

    await user.click(chart.getByRole('radio', { name: '30 d' }));
    expect(router.state.location.search).toBe('?range=30d');
    await waitFor(() => {
      expect(requests(fetchMock, path)).toHaveLength(2);
    });
    // 30 local days in Europe/Oslo, today (11 Nov) included.
    expect(Object.fromEntries(requests(fetchMock, path)[1] ?? [])).toEqual({
      from: '2026-10-12T22:00:00.000Z',
      to: '2026-11-11T23:00:00.000Z',
    });
    // Back to one year drops the parameter.
    await user.click(chart.getByRole('radio', { name: '1 y' }));
    expect(router.state.location.search).toBe('');
  });

  it('never polls', async () => {
    mockBank('1');
    const { queryClient } = renderApp('/1/bank');
    await screen.findByText('44.46M');
    for (const query of queryClient.getQueryCache().findAll()) {
      for (const observer of query.observers) {
        const { refetchInterval } = observer.options;
        const interval =
          typeof refetchInterval === 'function' ? refetchInterval(query) : refetchInterval;
        // Only `health` has an interval, and only while the server is down.
        expect(interval ?? false, JSON.stringify(query.queryKey)).toBe(false);
      }
    }
  });

  it('lets every column scroll with the page: nothing sticks', async () => {
    mockBank('1');
    renderApp('/1/bank');
    for (const name of ['Bank', 'Carried', 'Potion storage', 'Value over time', 'Most valuable']) {
      const { section } = await card(name);
      // No sticky column around the card, and no `top` set for one.
      expect(section.closest('[class*="sticky"]')).toBeNull();
      expect(section.parentElement?.style.top).toBe('');
    }
  });

  it('keeps GE | HA in the row at the top while loading, so it never moves', async () => {
    let answer: (() => void) | undefined;
    mockBank('1', {
      answers: {
        '/api/v1/accounts/1/bank': () =>
          new Promise<Response>((resolve) => {
            answer = () => {
              resolve(Response.json(bankOne));
            };
          }),
      },
    });
    renderApp('/1/bank');
    const loading = await screen.findByRole('radio', { name: 'GE' });
    const row = screen.getByRole('region', { name: 'Bank summary' });
    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(row.contains(loading)).toBe(true);
    await waitFor(() => {
      expect(answer).toBeDefined();
    });
    answer?.();
    await screen.findByText('44.46M');
    // One toggle, and the very same element as while loading: it never moved.
    const [after] = screen.getAllByRole('radio', { name: 'GE' });
    expect(screen.getAllByRole('radio', { name: 'GE' })).toHaveLength(1);
    expect(after).toBe(loading);
    expect(
      screen.getByRole('region', { name: 'Bank summary' }).getAttribute('aria-busy'),
    ).toBeNull();
  });

  it('has GE | HA in the top bar for all accounts', async () => {
    mockBank('all', { bank: bankAll, potions: potionsAll });
    renderApp('/all/bank');
    const toggle = await screen.findByRole('radio', { name: 'GE' });
    await screen.findByRole('region', { name: 'Bank summary' });
    expect(screen.getByRole('region', { name: 'Bank summary' }).contains(toggle)).toBe(false);
    expect(screen.getAllByRole('radio', { name: 'GE' })).toHaveLength(1);
  });

  it('keeps "Show all" open when the layout crosses the PC breakpoint', async () => {
    const { setDesktop } = stubResizableLayout(true);
    const specs = Array.from({ length: 300 }, (_, i): Spec => [i < 100 ? 1 : 0, 'Item', 1, 1]);
    const storage = (potionsOne as { storages: Record<string, unknown>[] }).storages[0] as {
      potions: Record<string, unknown>[];
    } & Record<string, unknown>;
    const potion = storage.potions[1] ?? {};
    const potions = Array.from({ length: 30 }, (_, position) => ({
      ...potion,
      position,
      itemId: 20_000 + position,
      gePriceEach: 0,
      haPriceEach: 0,
      geValue: 0,
      haValue: 0,
    }));
    const zero = { geValue: 0, haValue: 0 };
    mockBank('1', {
      bank: bankOf(specs),
      potions: {
        storages: [{ ...storage, totals: zero, potions }],
        totals: zero,
        prices: { source: 'SNAPSHOT', fetchedAt: null },
      },
    });
    renderApp('/1/bank');
    const user = userEvent.setup();
    await user.click((await card('Bank')).getByRole('button', { name: 'Show all (300 slots)' }));
    await user.click((await card('Potion storage')).getByRole('button', { name: 'Show all 30' }));

    // A tablet turned to portrait: the mobile layout, one section at a time.
    act(() => {
      setDesktop(false);
    });
    const bank = await card('Bank');
    expect(bank.getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect(bank.section.querySelectorAll('[data-slot-variant]')).toHaveLength(300);
    await user.click(screen.getByRole('radio', { name: 'Potions' }));
    expect((await card('Potion storage')).getByRole('button', { name: 'Show fewer' })).toBeTruthy();

    // And back to PC.
    act(() => {
      setDesktop(true);
    });
    expect((await card('Bank')).getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect((await card('Potion storage')).getByRole('button', { name: 'Show fewer' })).toBeTruthy();
  });

  it('sums the numbers for all accounts and links to each account, without a grid', async () => {
    mockBank('all', { bank: bankAll, potions: potionsAll });
    renderApp('/all/bank?value=ha');
    const list = await screen.findByRole('list', { name: 'Net worth per account' });
    const links = within(list).getAllByRole('link');
    // Accounts with a bank or potion storage; account 3 is not in the accounts fixture.
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/1/bank?value=ha',
      '/2/bank?value=ha',
      '/3/bank?value=ha',
    ]);
    expect(links[0]?.textContent).toContain('Test Main');
    expect(links[0]?.textContent).toContain('Ironman');
    expect(links[1]?.textContent).toContain('Alt');
    expect(links[2]?.textContent).toContain('Account 3');
    expect(screen.getByText(/A bank belongs to one account\./)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Value over time/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Bank' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    // Three numbers: net worth and cash summed, and how many accounts have a bank.
    const summary = within(screen.getByRole('region', { name: 'Bank summary' }));
    expect(summary.getByText('net worth · all accounts, HA')).toBeTruthy();
    expect(summary.getByText('cash')).toBeTruthy();
    expect(
      summary.getByText('accounts with a bank').closest('div')?.firstElementChild?.textContent,
    ).toBe('3');
  });

  it('folds potion storage after four rows of six, until "Show all"', async () => {
    const [storage] = (potionsOne as { storages: Record<string, unknown>[] }).storages as [
      { potions: Record<string, unknown>[] } & Record<string, unknown>,
    ];
    const potion = storage.potions[1] ?? {};
    // 30 potions of 7 doses each, worth nothing: valid sums with zero totals.
    const potions = Array.from({ length: 30 }, (_, position) => ({
      ...potion,
      position,
      itemId: 20_000 + position,
      gePriceEach: 0,
      haPriceEach: 0,
      geValue: 0,
      haValue: 0,
    }));
    const zero = { geValue: 0, haValue: 0 };
    mockBank('1', {
      potions: {
        storages: [{ ...storage, totals: zero, potions }],
        totals: zero,
        prices: { source: 'SNAPSHOT', fetchedAt: null },
      },
    });
    renderApp('/1/bank');
    const card_ = await card('Potion storage');
    const count = () => card_.getByRole('img').querySelectorAll('[data-slot-variant]').length;
    expect(count()).toBe(24);
    expect(card_.getByText('The number is doses, as in the game.')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(card_.getByRole('button', { name: 'Show all 30' }));
    expect(count()).toBe(30);
    await user.click(card_.getByRole('button', { name: 'Show fewer' }));
    expect(count()).toBe(24);
  });

  it('hides potion storage when the latest snapshot has no potions', async () => {
    const [storage] = (potionsOne as { storages: Record<string, unknown>[] }).storages;
    const zero = { geValue: 0, haValue: 0 };
    mockBank('1', {
      potions: {
        storages: [{ ...storage, totals: zero, potions: [] }],
        totals: zero,
        prices: { source: 'SNAPSHOT', fetchedAt: null },
      },
    });
    renderApp('/1/bank');
    await card('Carried');
    expect(screen.queryByRole('heading', { name: /^Potion storage/ })).toBeNull();
  });

  it('invites an account without a snapshot, while another account has one', async () => {
    mockBank('2', { bank: bankNoData, potions: potionsNoData });
    renderApp('/2/bank');
    expect(
      await screen.findByText(
        'Close your bank in the game with the plugin running and it shows up here.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^Value over time/ })).toBeNull();
  });

  it('offers a retry when the bank fails to load', async () => {
    let fail = true;
    mockBank('1', {
      answers: {
        '/api/v1/accounts/1/bank': () =>
          new Response(
            JSON.stringify(
              fail ? { error: { code: 'INTERNAL_ERROR', message: 'Boom', details: [] } } : bankOne,
            ),
            { status: fail ? 500 : 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    });
    renderApp('/1/bank');
    const user = userEvent.setup();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    await user.click(retry);
    expect(await screen.findByText('44.46M')).toBeTruthy();
  });
});

describe('Bank on mobile', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sections = () =>
    within(screen.getByRole('radiogroup', { name: 'Bank sections' }))
      .getAllByRole('radio')
      .map((radio) => radio.textContent);

  it('shows one section at a time, chosen in the URL and kept in the history', async () => {
    mockBank('1');
    const { router } = renderApp('/1/bank?tab=2');
    await card('Bank');
    expect(sections()).toEqual(['Bank', 'Carried', 'Potions', 'Value']);
    expect(screen.queryByRole('heading', { name: /^Carried/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Value over time/ })).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Carried' }));
    await card('Carried');
    expect(router.state.location.search).toBe('?tab=2&section=carried');
    expect(router.state.historyAction).toBe('PUSH');
    expect(screen.queryByRole('heading', { level: 2, name: /^Bank/ })).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'Potions' }));
    await card('Potion storage');
    await user.click(screen.getByRole('radio', { name: 'Value' }));
    await card('Value over time');
    expect(screen.getByRole('heading', { name: /^Most valuable/ })).toBeTruthy();

    // "By tab" opens the tab in the bank, in one step.
    const byTab = await card('By tab');
    await user.click(first(within(byTab.getByRole('list')).getAllByRole('button')));
    await card('Bank');
    expect(router.state.location.search).toBe('?tab=main');

    await router.navigate(-1);
    await card('Value over time');
  });

  it('has no Potions section without potions, and falls back to the bank', async () => {
    mockBank('1', { potions: potionsNoData });
    renderApp('/1/bank?section=potions');
    await card('Bank');
    expect(sections()).toEqual(['Bank', 'Carried', 'Value']);
    expect(screen.getByRole('radio', { name: 'Bank' }).getAttribute('aria-checked')).toBe('true');
  });

  it('opens potion storage for an account with potions but no bank snapshot', async () => {
    mockBank('1', { bank: bankNoData });
    const { router } = renderApp('/1/bank');
    await card('Potion storage');
    // Bank and Carried need a bank snapshot.
    expect(sections()).toEqual(['Potions', 'Value']);
    expect(screen.getByRole('radio', { name: 'Potions' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    // Potions is the default here, so it stays out of the URL; a section it lacks falls back.
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Value' }));
    await card('Value over time');
    expect(router.state.location.search).toBe('?section=value');
    await user.click(screen.getByRole('radio', { name: 'Potions' }));
    await card('Potion storage');
    expect(router.state.location.search).toBe('');
    await router.navigate('/1/bank?section=carried');
    await card('Potion storage');
  });

  it('ignores the section on PC, where every card shows', async () => {
    stubDesktop();
    mockBank('1');
    renderApp('/1/bank?section=value');
    await card('Bank');
    expect(screen.queryByRole('radiogroup', { name: 'Bank sections' })).toBeNull();
    expect(await card('Carried')).toBeTruthy();
    expect(await card('Value over time')).toBeTruthy();
  });
});

// Price movers. The fixture has 24 h, 7 d and 30 d; 7 d has five items that
// gained (the fifth is a potion in potion storage) and four that lost, summing
// to +4,183,655 gp.
describe('Price movers', () => {
  const MOVERS = '/api/v1/accounts/1/bank/price-movers';
  /** The bank valued at current prices: only then does the page ask for price movers. */
  const bankCurrent = {
    ...ONE,
    prices: { source: 'CURRENT', fetchedAt: moversThree.prices.fetchedAt },
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T12:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** What each row shows: without the icon's initials (its first element) and screen-reader text. */
  const rows = (list: HTMLElement) =>
    within(list)
      .getAllByRole('listitem')
      .map((row) => {
        const copy = row.cloneNode(true) as HTMLElement;
        copy.firstElementChild?.remove();
        copy.querySelectorAll('.sr-only').forEach((hidden) => {
          hidden.remove();
        });
        return copy.textContent.replace(/\s+/g, ' ').trim();
      });
  /** The list under the heading `title` ("Gained most" or "Lost most"). */
  const listOf = (section: HTMLElement, title: string) => {
    const list = within(section).getByRole('heading', { level: 3, name: title }).nextElementSibling;
    if (!(list instanceof HTMLElement)) throw new Error(`No list under ${title}`);
    return list;
  };

  it('shares the card with Most valuable: the sum, gained and lost, ranked by gp', async () => {
    stubDesktop();
    mockBank('1', { bank: bankCurrent, answers: { [MOVERS]: { body: moversThree } } });
    const { router } = renderApp('/1/bank');
    const { section, ...movers } = await card('Price movers');
    expect(
      within(movers.getByRole('radiogroup', { name: 'Item rankings' }))
        .getAllByRole('radio')
        .map((radio) => [radio.textContent, radio.getAttribute('aria-checked')]),
    ).toEqual([
      ['Price movers', 'true'],
      ['Most valuable', 'false'],
    ]);
    // 7 days by default.
    const period = movers.getByRole('radiogroup', { name: 'Period' });
    expect(within(period).getByRole('radio', { name: '7 d' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    // The sum of every item, not only the rows shown, with its direction as an arrow.
    expect(section.textContent).toContain('▲ Up 4.18M gp');
    expect(section.textContent).toContain('from price changes in 7 days · what you hold now');
    // Four rows each, by gp and not by percent: −4.1% comes after −2.6%.
    expect(rows(listOf(section, 'Gained most'))).toEqual([
      'Saturated heart+4.2%▲ 2.46M',
      'Masori body+3.1%▲ 1.42M',
      'Dragon hunter lance+2.9%▲ 1.11M',
      'Amulet of rancour+1.8%▲ 766K',
    ]);
    expect(rows(listOf(section, 'Lost most'))).toEqual([
      'Confliction gauntlets−2.6%▼ 1.53M',
      'Dragon arrowtips × 356−4.1%▼ 40.2K',
      'Onyx bolt tips × 55−1.9%▼ 9,075',
      'Rune kiteshield × 6−0.8%▼ 1,542',
    ]);
    // Up and down are a colour and an arrow, never the colour alone.
    const gained = first(within(listOf(section, 'Gained most')).getAllByRole('listitem'));
    expect(gained.querySelector('.text-up')?.textContent).toContain('▲');
    const lost = first(within(listOf(section, 'Lost most')).getAllByRole('listitem'));
    expect(lost.querySelector('.text-down')?.textContent).toContain('▼');

    // The exact amount is on the row (title and screen-reader text), and only
    // the sum is a tab stop: a long list must not be one stop per item.
    expect(gained.querySelector('.text-up')?.getAttribute('title')).toBe('+2,460,000 gp');
    expect(gained.querySelector('.text-up .sr-only')?.textContent).toBe('Up 2,460,000 gp');
    expect(lost.querySelector('.text-down')?.getAttribute('title')).toBe('−1,530,000 gp');
    expect(section.querySelectorAll('li [tabindex]')).toHaveLength(0);
    expect(section.querySelectorAll('span[tabindex="0"]')).toHaveLength(1);

    // "Show all" adds the fifth that gained: a potion, with its doses.
    const user = userEvent.setup();
    await user.click(movers.getByRole('button', { name: 'Show all' }));
    expect(rows(listOf(section, 'Gained most'))[4]).toBe('Prayer potion · 340 doses+1.1%▲ 8,500');
    expect(router.state.location.search).toBe('');

    // Another period: in the URL, replaced.
    await user.click(within(period).getByRole('radio', { name: '24 h' }));
    expect(router.state.location.search).toBe('?movers=24h');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(section.textContent).toContain('▲ Up 8,980 gp');
    expect(section.textContent).toContain('in 24 hours');

    // The other half of the card.
    await user.click(movers.getByRole('radio', { name: 'Most valuable' }));
    expect(router.state.location.search).toBe('?movers=24h&top=valuable');
    const valuable = await card('Most valuable');
    expect(valuable.section).toBe(section);
    expect(first(valuable.getAllByRole('listitem')).textContent).toContain('Bandos chestplate');
    expect(valuable.queryByRole('radiogroup', { name: 'Period' })).toBeNull();
  });

  it('opens on the period and the half in the URL, and falls back when a period has no history', async () => {
    stubDesktop();
    mockBank('1', { bank: bankCurrent, answers: { [MOVERS]: { body: moversDay } } });
    renderApp('/1/bank?movers=30d');
    const { section, ...movers } = await card('Price movers');
    // Only 24 hours of history yet: that is what shows, with nothing to choose between.
    expect(section.textContent).toContain('in 24 hours');
    expect(movers.queryByRole('radiogroup', { name: 'Period' })).toBeNull();
  });

  it('says so when nothing moved, without the line about ranking', async () => {
    stubDesktop();
    mockBank('1', { bank: bankCurrent, answers: { [MOVERS]: { body: moversNothing } } });
    renderApp('/1/bank');
    const { section } = await card('Price movers');
    expect(section.textContent).toContain('0 gp');
    expect(section.textContent).not.toMatch(/[▲▼]/);
    expect(section.textContent).toContain('No price changes for what you hold.');
    expect(section.textContent).not.toContain('Ranked by gp change');
    expect(within(section).queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it.each([
    ['the price source is off', ONE, undefined, false],
    ['there is no price history yet', bankCurrent, { body: moversNone }, true],
    ['the request fails', bankCurrent, { status: 500, body: {} }, true],
  ])(
    'is plain Most valuable when %s, without a word about it',
    async (_name, bank, answer, asked) => {
      stubDesktop();
      const fetchMock = mockBank('1', { bank, answers: answer ? { [MOVERS]: answer } : {} });
      renderApp('/1/bank');
      const { section } = await card('Most valuable');
      await waitFor(() => {
        expect(requests(fetchMock, MOVERS).length > 0).toBe(asked);
      });
      expect(within(section).queryByRole('radiogroup')).toBeNull();
      expect(screen.queryByText(/price movers/i)).toBeNull();
      expect(screen.queryByText(/went wrong|try again|price history/i)).toBeNull();
    },
  );

  it('is not shown, or asked for, with HA values', async () => {
    stubDesktop();
    const fetchMock = mockBank('1', {
      bank: bankCurrent,
      answers: { [MOVERS]: { body: moversThree } },
    });
    renderApp('/1/bank?value=ha');
    const { section } = await card('Most valuable');
    expect(within(section).queryByRole('radiogroup')).toBeNull();
    expect(requests(fetchMock, MOVERS)).toEqual([]);
  });

  it('is its own card under Value on mobile, three rows each, next to Most valuable', async () => {
    mockBank('1', { bank: bankCurrent, answers: { [MOVERS]: { body: moversThree } } });
    renderApp('/1/bank?section=value');
    const { section, ...movers } = await card('Price movers');
    expect(section.textContent).toContain('▲ Up 4.18M gp');
    expect(
      within(movers.getByRole('radiogroup', { name: 'Period' }))
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['24 h', '7 d', '30 d']);
    expect(rows(listOf(section, 'Gained most'))).toHaveLength(3);
    expect(rows(listOf(section, 'Lost most'))).toHaveLength(3);
    expect(movers.queryByRole('radiogroup', { name: 'Item rankings' })).toBeNull();
    expect((await card('Most valuable')).section).not.toBe(section);
  });

  // Items of the fixture's 7 d spread over tabs: Dragon arrowtips in tabs 1
  // and 3, two stacks of Rune kiteshield in tab 3, a Onyx bolt tips
  // placeholder in tab 3, and tab 5 with nothing that moved.
  const bankTabs = {
    ...bankOf([
      [1, 'Saturated heart', 1, 61_090_000, 27641],
      [1, 'Dragon arrowtips', 200, 2642, 11237],
      [1, 'Amulet of rancour', 1, 43_322_000, 29801],
      [3, 'Masori body', 1, 47_250_000, 27226],
      [3, 'Dragon arrowtips', 156, 2642, 11237],
      [3, 'Rune kiteshield', 2, 31_800, 1201],
      [3, 'Rune kiteshield', 4, 31_800, 1201],
      [3, 'Onyx bolt tips', 0, 8500, 9194],
      [5, 'Chisel', 1, 100, 1755],
      [0, 'Dragon hunter lance', 1, 39_380_000, 22978],
    ]),
    prices: { source: 'CURRENT', fetchedAt: moversThree.prices.fetchedAt },
  };

  it('follows the chosen tab, with the tab in the subtitle', async () => {
    stubDesktop();
    mockBank('1', { bank: bankTabs, answers: { [MOVERS]: { body: moversThree } } });
    const user = userEvent.setup();
    const { router } = renderApp('/1/bank');
    const { section, ...movers } = await card('Price movers');
    // All: the API's sum, which covers more than the bank tabs.
    expect(movers.getByText('Everything held · GE')).toBeTruthy();
    expect(section.textContent).toContain('▲ Up 4.18M gp');

    const tabs = (await card('Bank')).getByRole('group', { name: 'Bank tabs' });
    await user.click(within(tabs).getByRole('button', { name: 'Tab 3' }));
    expect(router.state.location.search).toBe('?tab=3');
    expect(movers.getByText('Tab 3 · GE')).toBeTruthy();
    // Masori body +1,420,000; arrowtips 156 × −113 = −17,628; kiteshields 6 × −257.
    expect(section.textContent).toContain('▲ Up 1.4M gp');
    expect(rows(listOf(section, 'Gained most'))).toEqual(['Masori body+3.1%▲ 1.42M']);
    expect(rows(listOf(section, 'Lost most'))).toEqual([
      'Dragon arrowtips × 156−4.1%▼ 17.6K',
      'Rune kiteshield × 6−0.8%▼ 1,542',
    ]);
    // Most valuable keeps its own label.
    await user.click(movers.getByRole('radio', { name: 'Most valuable' }));
    expect(movers.getByText('Tab 3 · GE')).toBeTruthy();
    await user.click(within(tabs).getByRole('button', { name: 'All tabs' }));
    expect(movers.getByText('All tabs · GE')).toBeTruthy();
  });

  it('says so for a tab where nothing moved', async () => {
    stubDesktop();
    mockBank('1', { bank: bankTabs, answers: { [MOVERS]: { body: moversThree } } });
    renderApp('/1/bank?tab=5');
    const { section, ...movers } = await card('Price movers');
    expect(movers.getByText('Tab 5 · GE')).toBeTruthy();
    expect(section.textContent).toContain('No price changes for what you hold.');
    expect(section.textContent).not.toMatch(/[▲▼]/);
  });

  it('folds "Show all" again when the tab changes', async () => {
    stubDesktop();
    mockBank('1', { bank: bankTabs, answers: { [MOVERS]: { body: moversThree } } });
    const user = userEvent.setup();
    renderApp('/1/bank');
    const { section, ...movers } = await card('Price movers');
    await user.click(movers.getByRole('button', { name: 'Show all' }));
    expect(rows(listOf(section, 'Gained most'))).toHaveLength(5);
    const tabs = (await card('Bank')).getByRole('group', { name: 'Bank tabs' });
    await user.click(within(tabs).getByRole('button', { name: 'Tab 3' }));
    await user.click(within(tabs).getByRole('button', { name: 'All tabs' }));
    expect(rows(listOf(section, 'Gained most'))).toHaveLength(4);
    expect(movers.getByRole('button', { name: 'Show all' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('names the tab on mobile too', async () => {
    mockBank('1', { bank: bankTabs, answers: { [MOVERS]: { body: moversThree } } });
    renderApp('/1/bank?section=value&tab=3');
    const { section, ...movers } = await card('Price movers');
    expect(movers.getByText('Tab 3 · GE')).toBeTruthy();
    expect(rows(listOf(section, 'Gained most'))).toEqual(['Masori body+3.1%▲ 1.42M']);
  });
});

describe('Bank in the menu', () => {
  it('has no page and no menu item until an account has a bank snapshot', async () => {
    mockBank('all', { summary: summaryNoData, bank: bankNoData, potions: potionsNoData });
    renderApp('/all/bank');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
  });

  it('opens the page after the first snapshot, also with "no data" still in the cache', async () => {
    let summary: unknown = summaryNoData;
    mockBank('1', {
      answers: {
        '/api/v1/accounts/all/bank/summary': () =>
          new Response(JSON.stringify(summary), {
            headers: { 'content-type': 'application/json' },
          }),
      },
    });
    const { router } = renderApp('/settings');
    const nav = await findMainNav();
    await within(nav).findByRole('link', { name: 'Progress' });
    expect(within(nav).queryByRole('link', { name: 'Bank' })).toBeNull();

    // The bank is closed in the game; the cached answer is still fresh.
    summary = summaryOne;
    await router.navigate('/1/bank');
    expect(await screen.findByText('44.46M')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Not found' })).toBeNull();
    expect(await within(nav).findByRole('link', { name: 'Bank' })).toBeTruthy();
  });

  it('leaves Bank out of the top bar and the tab bar without bank data', async () => {
    mockApi({ '/api/v1/accounts/all/bank/summary': { body: summaryNoData } });
    renderApp('/settings');
    const nav = await findMainNav();
    await within(nav).findByRole('link', { name: 'Progress' });
    expect(screen.queryByRole('link', { name: 'Bank' })).toBeNull();
  });

  it('lists Bank in the top bar and the tab bar once there is bank data', async () => {
    mockApi({ '/api/v1/accounts/all/bank/summary': { body: summaryOne } });
    renderApp('/settings');
    const nav = await findMainNav();
    const link = await within(nav).findByRole('link', { name: 'Bank' });
    expect(link.getAttribute('href')).toBe('/all/bank');
    expect(screen.getAllByRole('link', { name: 'Bank' })).toHaveLength(2);
  });

  it('marks Bank in the menu on the page', async () => {
    mockBank('1');
    renderApp('/1/bank');
    const nav = await findMainNav();
    const link = await within(nav).findByRole('link', { name: 'Bank' });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.getAttribute('href')).toBe('/1/bank');
  });
});
