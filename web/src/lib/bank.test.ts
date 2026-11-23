import {
  BANK_FILLER_ITEM_ID,
  type AccountBank,
  type BankHistoryDay,
  type BankItemResponse,
  type ContainerItemResponse,
  type PriceMoverItem,
  type PriceMoverPeriod,
  type PriceMoverPeriodResult,
  comparePriceMovers,
  priceMoverPeriodResultSchema,
  sumPriceChanges,
} from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  ALL_VIEW_COLLAPSED_SLOTS,
  bankSections,
  countItems,
  countPlaceholders,
  equipmentCells,
  hasTabs,
  historyPoints,
  inventoryCells,
  listRows,
  mostValuable,
  moverKey,
  moverParam,
  moverPeriodOf,
  moverRatio,
  moversForTab,
  splitMovers,
  netWorth,
  parseHistoryRange,
  parseTab,
  parseValueMode,
  searchBank,
  slotKind,
  bankSectionsFor,
  parseBankSection,
  sectionParam,
  stickyRoom,
  stickyTopWhenFits,
  sumNetWorth,
  tabIconItem,
  tabParam,
  visibleSections,
} from './bank';

// A bank in container order (tabs 1–9, then the main tab), built like the API.
type Spec = [tab: number, name: string, quantity: number, ge?: number, ha?: number, id?: number];

function bankOf(specs: readonly Spec[]): Pick<AccountBank, 'tabs' | 'items'> {
  const items: BankItemResponse[] = specs.map(([tab, name, quantity, ge = 0, ha = 0, id], i) => ({
    position: i,
    tab,
    itemId: id ?? 1000 + i,
    name,
    quantity,
    placeholder: quantity === 0,
    gePriceEach: ge,
    gePriceSource: 'SNAPSHOT',
    haPriceEach: ha,
    geValue: quantity * ge,
    haValue: quantity * ha,
  }));
  const numbers = [...new Set([...items.map((item) => item.tab), 0])];
  const tabs = numbers
    .sort((a, b) => (a === 0 ? 10 : a) - (b === 0 ? 10 : b))
    .map((tab) => {
      const rows = items.filter((item) => item.tab === tab);
      return {
        tab,
        itemCount: rows.length,
        geValue: rows.reduce((sum, row) => sum + row.geValue, 0),
        haValue: rows.reduce((sum, row) => sum + row.haValue, 0),
      };
    });
  return { tabs, items };
}

const filler = (tab: number): Spec => [tab, 'Bank filler', 1, 0, 0, BANK_FILLER_ITEM_ID];

const BANK = bankOf([
  [1, 'Rune platebody', 2, 100, 60],
  [1, 'Twisted bow', 0, 1000, 500],
  filler(1),
  [3, 'Rune arrow', 10, 5, 8],
  [0, 'Coins', 500, 1, 1],
  [0, 'Rune pouch', 1, 0, 7],
]);

/** A bank with `slots` slots: 100 in tab 1, 100 in tab 2, the rest in the main tab. */
function bigBank(slots: number) {
  return bankOf(
    Array.from({ length: slots }, (_, i): Spec => [i < 100 ? 1 : i < 200 ? 2 : 0, 'Item', 1, 1, 1]),
  );
}

describe('slots', () => {
  it('tells items, placeholders and fillers apart', () => {
    expect(BANK.items.map(slotKind)).toEqual([
      'item',
      'placeholder',
      'filler',
      'item',
      'item',
      'item',
    ]);
  });

  it('never counts fillers or placeholders as items', () => {
    expect(countItems(BANK.items)).toBe(4);
    expect(countPlaceholders(BANK.items)).toBe(1);
  });
});

describe('bankSections', () => {
  const sections = bankSections(BANK);

  it('puts the main tab first, then tabs 1–9, as the game does', () => {
    expect(sections.map((section) => section.tab)).toEqual([0, 1, 3]);
  });

  it('counts items and values per tab without fillers and placeholders', () => {
    expect(sections.map((s) => [s.itemCount, s.geValue, s.haValue])).toEqual([
      [2, 500, 507],
      [1, 200, 120],
      [1, 50, 80],
    ]);
    // Every slot is still drawn.
    expect(sections[1]?.items).toHaveLength(3);
  });

  it('never values a filler, whatever price the data has', () => {
    const priced = bankOf([[0, 'Bank filler', 1, 999, 999, BANK_FILLER_ITEM_ID]]);
    expect(bankSections(priced)[0]).toMatchObject({ itemCount: 0, geValue: 0, haValue: 0 });
  });

  it('leaves out an empty main tab', () => {
    const onlyTab = bankOf([[2, 'Shark', 5, 10, 1]]);
    expect(bankSections(onlyTab).map((section) => section.tab)).toEqual([2]);
    expect(bankSections(bankOf([]))).toEqual([]);
  });

  it('has tabs only when a tab 1–9 has slots', () => {
    expect(hasTabs(sections)).toBe(true);
    expect(hasTabs(bankSections(bankOf([[0, 'Coins', 1, 1, 1]])))).toBe(false);
  });

  it('uses the first slot that is not a filler as the tab icon', () => {
    const tab = bankSections(bankOf([filler(1), [1, 'Shark', 5]]))[0];
    expect(tab && tabIconItem(tab)?.name).toBe('Shark');
  });
});

describe('tab in the URL', () => {
  const sections = bankSections(BANK);

  it('reads main and 1–9, and falls back to All', () => {
    expect(parseTab(null, sections)).toBe('all');
    expect(parseTab('main', sections)).toBe(0);
    expect(parseTab('3', sections)).toBe(3);
    // A tab without slots, and nonsense.
    expect(parseTab('2', sections)).toBe('all');
    expect(parseTab('0', sections)).toBe('all');
    expect(parseTab('12', sections)).toBe('all');
  });

  it('writes the choice back', () => {
    expect(tabParam('all')).toBeNull();
    expect(tabParam(0)).toBe('main');
    expect(tabParam(5)).toBe('5');
  });
});

describe('visibleSections ("Show all")', () => {
  it('shows a bank of 240 slots or fewer whole', () => {
    const view = visibleSections(bankSections(bigBank(240)), 'all', false);
    expect(view).toMatchObject({ totalSlots: 240, collapsible: false, cut: false });
    expect(view.sections.flatMap((section) => section.visible)).toHaveLength(240);
  });

  it('cuts a longer bank to the first 160 slots in display order, also mid-tab', () => {
    // Display order: main tab (700 slots), tab 1, tab 2.
    const view = visibleSections(bankSections(bigBank(900)), 'all', false);
    expect(view).toMatchObject({ totalSlots: 900, collapsible: true, cut: true });
    expect(view.sections.map((s) => [s.tab, s.visible.length])).toEqual([[0, 160]]);
    // The separator keeps the tab's real count and value.
    expect(view.sections[0]).toMatchObject({ itemCount: 700, geValue: 700 });

    // 241 slots: main tab 41, tab 1 100, then 19 of tab 2.
    const mid = visibleSections(bankSections(bigBank(241)), 'all', false);
    expect(mid.sections.map((s) => [s.tab, s.visible.length])).toEqual([
      [0, 41],
      [1, 100],
      [2, ALL_VIEW_COLLAPSED_SLOTS - 141],
    ]);
    expect(mid.sections[2]?.itemCount).toBe(100);
  });

  it('shows everything once expanded', () => {
    const view = visibleSections(bankSections(bigBank(900)), 'all', true);
    expect(view).toMatchObject({ collapsible: true, cut: false });
    expect(view.sections.flatMap((section) => section.visible)).toHaveLength(900);
  });

  it('always shows a chosen tab whole', () => {
    const view = visibleSections(bankSections(bigBank(900)), 0, false);
    expect(view).toMatchObject({ totalSlots: 700, collapsible: false, cut: false });
    expect(view.sections.map((s) => [s.tab, s.visible.length])).toEqual([[0, 700]]);
  });
});

describe('searchBank', () => {
  const sections = bankSections(BANK);
  const names = (query: string, placeholders = true) =>
    searchBank(sections, query, placeholders).map((item) => item.name);

  it('finds matches in every tab, in display order, ignoring case', () => {
    expect(names('RUNE')).toEqual(['Rune pouch', 'Rune platebody', 'Rune arrow']);
  });

  it('never matches a filler', () => {
    expect(names('filler')).toEqual([]);
    expect(names('bank')).toEqual([]);
  });

  it('matches placeholders only while they are shown', () => {
    expect(names('bow')).toEqual(['Twisted bow']);
    expect(names('bow', false)).toEqual([]);
  });

  it('gives nothing for an empty query', () => {
    expect(names('  ')).toEqual([]);
  });
});

describe('list and most valuable', () => {
  it('sorts items by the chosen value, without placeholders and fillers', () => {
    expect(listRows(BANK.items, 'ge').map((item) => item.name)).toEqual([
      'Coins',
      'Rune platebody',
      'Rune arrow',
      'Rune pouch',
    ]);
    expect(listRows(BANK.items, 'ha').map((item) => item.name)).toEqual([
      'Coins',
      'Rune platebody',
      'Rune arrow',
      'Rune pouch',
    ]);
    expect(listRows(BANK.items, 'ha').map((item) => item.haValue)).toEqual([500, 120, 80, 7]);
  });

  it('orders equal values as the game shows them: the main tab first, not container order', () => {
    // Container order: tab 3, then the main tab.
    const tie = bankOf([
      [3, 'In tab 3', 1, 5],
      [0, 'First', 1, 5],
      [0, 'Second', 1, 5],
    ]);
    expect(tie.items.map((item) => item.name)).toEqual(['In tab 3', 'First', 'Second']);
    expect(listRows(tie.items, 'ge').map((item) => item.name)).toEqual([
      'First',
      'Second',
      'In tab 3',
    ]);
    expect(mostValuable(tie.items, 'ge', 2).map((item) => item.name)).toEqual(['First', 'Second']);
  });

  it('takes the most valuable stacks', () => {
    expect(mostValuable(BANK.items, 'ge', 2).map((item) => item.name)).toEqual([
      'Coins',
      'Rune platebody',
    ]);
    expect(mostValuable(bigBank(20).items, 'ge')).toHaveLength(6);
  });
});

describe('netWorth', () => {
  const bank = {
    // 1,000 GE and 400 HA in items, and a filler that must not count.
    items: bankOf([
      [0, 'Rune platebody', 10, 100, 40],
      [0, 'Bank filler', 1, 999, 999, BANK_FILLER_ITEM_ID],
    ]).items,
    inventory: { geValue: 30, haValue: 3, items: [] },
    equipment: { geValue: 200, haValue: 20, items: [] },
  };
  const potions = { totals: { geValue: 70, haValue: 7 } };

  it('is bank + potion storage + carried, in GE and in HA', () => {
    expect(netWorth(bank, potions, 'ge')).toEqual({
      total: 1300,
      bank: 1000,
      potionStorage: 70,
      inventory: 30,
      equipment: 200,
      carried: 230,
    });
    expect(netWorth(bank, potions, 'ha')).toMatchObject({ total: 430, carried: 23 });
  });

  it('never values a filler, so the bank equals the sum of its tabs', () => {
    const tabs = bankSections(bankOf([[0, 'Bank filler', 1, 999, 999, BANK_FILLER_ITEM_ID]]));
    expect(netWorth(bank, undefined, 'ge').bank).toBe(1000);
    expect(tabs.reduce((sum, tab) => sum + tab.geValue, 0)).toBe(0);
  });

  it('copes with a missing bank or potion storage', () => {
    expect(netWorth(bank, undefined, 'ge').total).toBe(1230);
    expect(netWorth(undefined, potions, 'ge')).toMatchObject({ total: 70, bank: 0, carried: 0 });
  });

  it('sums accounts', () => {
    const one = netWorth(bank, potions, 'ge');
    expect(sumNetWorth([one, one])).toMatchObject({ total: 2600, bank: 2000, carried: 460 });
    expect(sumNetWorth([]).total).toBe(0);
  });
});

describe('historyPoints', () => {
  const day: BankHistoryDay = {
    date: '2026-11-09',
    start: '2026-11-08T23:00:00.000Z',
    geValue: 1300,
    bankGeValue: 1000,
    potionStorageGeValue: 70,
    inventoryGeValue: 30,
    equipmentGeValue: 200,
    cashValue: 50,
    bankHaValue: 400,
    potionStorageHaValue: 7,
    inventoryHaValue: 3,
    equipmentHaValue: 20,
  };

  it('is the net worth in GE', () => {
    expect(historyPoints([day], 'ge')).toEqual([
      { date: '2026-11-09', value: 1300, bank: 1000, potionStorage: 70, carried: 230, cash: 50 },
    ]);
  });

  it('is the net worth in HA too (contract 1.20.0), with the same cash', () => {
    expect(historyPoints([day], 'ha')).toEqual([
      { date: '2026-11-09', value: 430, bank: 400, potionStorage: 7, carried: 23, cash: 50 },
    ]);
  });
});

describe('carried', () => {
  const worn = (slot: string | null, position = 0): ContainerItemResponse => ({
    position,
    slot,
    itemId: 1,
    name: slot ?? 'Item',
    quantity: 1,
    gePriceEach: 0,
    gePriceSource: 'SNAPSHOT',
    haPriceEach: 0,
    geValue: 0,
    haValue: 0,
  });

  it('lays the inventory out as 4 × 7 by position', () => {
    const cells = inventoryCells([worn(null, 0), worn(null, 27)]);
    expect(cells).toHaveLength(28);
    expect(cells.map((cell) => cell !== null).filter(Boolean)).toHaveLength(2);
    expect(cells[27]).not.toBeNull();
    expect(inventoryCells([])).toHaveLength(28);
  });

  it('puts an item without a place in an extra row, and never grows with the position', () => {
    const beyond = inventoryCells([worn(null, 50_000_000)]);
    expect(beyond).toHaveLength(32);
    expect(beyond[28]).not.toBeNull();
    // Two items on the same position: both are shown.
    const same = inventoryCells([worn(null, 3), worn(null, 3)]);
    expect(same.filter((cell) => cell !== null)).toHaveLength(2);
    expect(same).toHaveLength(32);
  });

  const slots = (cells: ReturnType<typeof equipmentCells>) =>
    cells.map((cell) => (cell.kind === 'gap' ? null : cell.slot));

  it('lays equipment out like the game, with the quiver slot as a gap without ammo', () => {
    const cells = equipmentCells([worn('HEAD'), worn('AMMO')]);
    expect(slots(cells)).toEqual([
      ...[null, 'HEAD', null],
      ...['CAPE', 'AMULET', 'AMMO'],
      ...['WEAPON', 'BODY', 'SHIELD'],
      ...[null, 'LEGS', null],
      ...['GLOVES', 'BOOTS', 'RING'],
    ]);
    // Empty slots of the panel are still slots.
    expect(cells[3]).toEqual({ kind: 'slot', slot: 'CAPE', item: null });
  });

  it('shows quiver ammo top right, straight above Ammo', () => {
    const cells = equipmentCells([worn('QUIVER_AMMO'), worn('AMMO')]);
    expect(slots(cells)[2]).toBe('QUIVER_AMMO');
    expect(slots(cells)[5]).toBe('AMMO');
  });

  it('puts an unknown slot in an extra row', () => {
    const cells = equipmentCells([worn('NEW_SLOT')]);
    expect(cells).toHaveLength(16);
    expect(cells.at(-1)).toMatchObject({ kind: 'slot', slot: 'NEW_SLOT' });
  });

  it('never leaves out a worn item: a second item in a slot, or one without a slot', () => {
    const items = [worn('HEAD'), worn('HEAD'), worn(null), worn(null)];
    const cells = equipmentCells(items);
    const shown = cells.flatMap((cell) => (cell.kind === 'slot' && cell.item ? [cell.item] : []));
    expect(shown).toHaveLength(4);
    expect(new Set(shown).size).toBe(4);
    expect(slots(cells).slice(15)).toEqual(['HEAD', 'UNKNOWN', 'UNKNOWN']);
  });
});

describe('URL values', () => {
  it('defaults to GE and one year', () => {
    expect(parseValueMode(null)).toBe('ge');
    expect(parseValueMode('ha')).toBe('ha');
    expect(parseValueMode('nonsense')).toBe('ge');
    expect(parseHistoryRange(null)).toBe('1y');
    expect(parseHistoryRange('7d')).toBe('1y');
    expect(parseHistoryRange('30d')).toBe('30d');
    expect(parseHistoryRange('90d')).toBe('90d');
  });
});

describe('parseBankSection', () => {
  const ALL = bankSectionsFor(true, true);

  it('offers the sections the account has data for, the bank first', () => {
    expect(ALL).toEqual(['bank', 'carried', 'potions', 'value']);
    expect(bankSectionsFor(true, false)).toEqual(['bank', 'carried', 'value']);
    // Potion storage but no bank snapshot: no Bank or Carried, and Potions first.
    expect(bankSectionsFor(false, true)).toEqual(['potions', 'value']);
    expect(bankSectionsFor(false, false)).toEqual(['value']);
  });

  it('reads the sections, with the first as the default', () => {
    expect(parseBankSection(null, ALL)).toBe('bank');
    expect(parseBankSection('carried', ALL)).toBe('carried');
    expect(parseBankSection('potions', ALL)).toBe('potions');
    expect(parseBankSection('value', ALL)).toBe('value');
    expect(parseBankSection('Value', ALL)).toBe('bank');
  });

  it('falls back to the first for a section the account lacks', () => {
    expect(parseBankSection('potions', bankSectionsFor(true, false))).toBe('bank');
    expect(parseBankSection('bank', bankSectionsFor(false, true))).toBe('potions');
    expect(parseBankSection(null, bankSectionsFor(false, true))).toBe('potions');
  });

  it('leaves the default out of the URL', () => {
    expect(sectionParam('bank', ALL)).toBeNull();
    expect(sectionParam('value', ALL)).toBe('value');
    expect(sectionParam('potions', bankSectionsFor(false, true))).toBeNull();
    expect(sectionParam('value', bankSectionsFor(false, true))).toBe('value');
  });
});

describe('stickyRoom', () => {
  it('is the window under the top bar, with the gap above and below', () => {
    // 900 − 68 − 20 − 20.
    expect(stickyRoom(68, 900)).toBe(792);
    expect(stickyRoom(68, 900, 30)).toBe(762);
  });

  it('never goes under the minimum', () => {
    expect(stickyRoom(68, 400, 0, 320)).toBe(320);
  });
});

describe('stickyTopWhenFits', () => {
  it('sticks under the top bar while the column fits in the window', () => {
    // 68 + 20 + 600 + 20 = 708 ≤ 900.
    expect(stickyTopWhenFits(68, 900, 600)).toBe(88);
    expect(stickyTopWhenFits(68, 708, 600)).toBe(88);
    expect(stickyTopWhenFits(68, 900, 600, 30)).toBe(118);
  });

  it('does not stick a taller column, so its bottom can be reached', () => {
    expect(stickyTopWhenFits(68, 707, 600)).toBeUndefined();
    expect(stickyTopWhenFits(68, 900, 1400)).toBeUndefined();
    expect(stickyTopWhenFits(68, 738, 600, 31)).toBeUndefined();
  });
});

describe('price movers', () => {
  const item = (itemId: number, change: number): PriceMoverItem => ({
    kind: 'ITEM',
    itemId,
    name: `Item ${String(itemId)}`,
    quantity: 1,
    priceEach: 1000 + change,
    previousPriceEach: 1000,
    change,
  });
  const result = (period: PriceMoverPeriod): PriceMoverPeriodResult => ({
    period,
    baselineAt: '2026-11-14T00:00:05.000Z',
    change: 0,
    items: [],
  });

  it('splits what gained from what lost, each with the largest change first', () => {
    // As the API sends them: by change, largest gain first.
    const items = [item(1, 500), item(2, 20), item(3, -5), item(4, -300)];
    const { gained, lost } = splitMovers(items);
    expect(gained.map((row) => row.itemId)).toEqual([1, 2]);
    expect(lost.map((row) => row.itemId)).toEqual([4, 3]);
    expect(splitMovers([])).toEqual({ gained: [], lost: [] });
  });

  it('gives the price change as a ratio of the earlier price', () => {
    expect(moverRatio({ priceEach: 1042, previousPriceEach: 1000 })).toBeCloseTo(0.042);
    expect(moverRatio({ priceEach: 500, previousPriceEach: 1000 })).toBe(-0.5);
  });

  it('shows the period in the URL if it has history, else 7 days, else the first there is', () => {
    const all = [result('24h'), result('7d'), result('30d')];
    expect(moverPeriodOf('30d', all)?.period).toBe('30d');
    expect(moverPeriodOf(null, all)?.period).toBe('7d');
    expect(moverPeriodOf('1y', all)?.period).toBe('7d');
    expect(moverPeriodOf('30d', [result('24h')])?.period).toBe('24h');
    expect(moverPeriodOf(null, [])).toBeUndefined();
  });

  it('leaves the default period out of the URL', () => {
    const all = [result('24h'), result('7d'), result('30d')];
    expect(moverParam('7d', all)).toBeNull();
    expect(moverParam('24h', all)).toBe('24h');
    expect(moverParam('24h', [result('24h')])).toBeNull();
  });

  it('keeps an item and a potion of the same item ID apart', () => {
    expect(moverKey({ kind: 'ITEM', itemId: 2434 })).not.toBe(
      moverKey({ kind: 'POTION', itemId: 2434 }),
    );
  });
});

describe('moversForTab', () => {
  const mover = (
    itemId: number,
    quantity: number,
    priceEach: number,
    previousPriceEach: number,
  ): PriceMoverItem => ({
    kind: 'ITEM',
    itemId,
    name: `Item ${String(itemId)}`,
    quantity,
    priceEach,
    previousPriceEach,
    change: quantity * (priceEach - previousPriceEach),
  });
  // As the API sends it: quantities over bank, inventory and equipment.
  const items: PriceMoverItem[] = [
    mover(1, 10, 1200, 1000), // +2000
    mover(2, 3, 600, 500), // +300
    {
      kind: 'POTION',
      itemId: 3,
      name: 'Prayer potion',
      doses: 40,
      itemDoses: 4,
      priceEach: 9200,
      previousPriceEach: 9100,
      change: 1000,
    },
    mover(4, 5, 90, 100), // −50
    mover(5, 2, 400, 500), // −200
  ];
  items.sort(comparePriceMovers);
  const PERIOD: PriceMoverPeriodResult = {
    period: '7d',
    baselineAt: '2026-11-14T00:00:05.000Z',
    change: sumPriceChanges(items),
    items,
  };
  const sections = bankSections(
    bankOf([
      [1, 'One', 4, 0, 0, 1],
      [1, 'Four', 5, 0, 0, 4],
      [1, 'Two', 0, 0, 0, 2], // placeholder
      filler(1),
      [2, 'One', 6, 0, 0, 1],
      [2, 'Five', 1, 0, 0, 5],
      [2, 'Five', 1, 0, 0, 5],
      [2, 'Two', 3, 0, 0, 2],
      [3, 'Not moved', 7, 0, 0, 99],
      [0, 'Prayer potion(4)', 1, 0, 0, 3],
    ]),
  );
  const ids = (result: PriceMoverPeriodResult) => result.items.map((item) => item.itemId);

  it('leaves All as the API sent it', () => {
    expect(moversForTab(PERIOD, sections, 'all')).toBe(PERIOD);
  });

  it('keeps only the items of the tab, with the quantity in that tab', () => {
    const result = moversForTab(PERIOD, sections, 1);
    expect(ids(result)).toEqual([1, 4]);
    expect(result.items.map((item) => (item.kind === 'ITEM' ? item.quantity : 0))).toEqual([4, 5]);
    // 4 × +200 and 5 × −10.
    expect(result.items.map((item) => item.change)).toEqual([800, -50]);
    expect(result.change).toBe(750);
  });

  it('counts an item split across tabs only where it is', () => {
    expect(moversForTab(PERIOD, sections, 2).items.find((item) => item.itemId === 1)?.change).toBe(
      1200,
    );
  });

  it('adds up stacks of the same item in a tab', () => {
    const five = moversForTab(PERIOD, sections, 2).items.find((item) => item.itemId === 5);
    expect(five).toMatchObject({ quantity: 2, change: -200 });
  });

  it('ignores placeholders, fillers and potion storage', () => {
    // Item 2 is a placeholder in tab 1; item 3 is in the main tab as an item,
    // but its mover is the potion in potion storage.
    expect(ids(moversForTab(PERIOD, sections, 1))).not.toContain(2);
    expect(moversForTab(PERIOD, sections, 0).items).toEqual([]);
  });

  it('sums and sorts like the API, and is a valid period result', () => {
    const result = moversForTab(PERIOD, sections, 2);
    expect(ids(result)).toEqual([1, 2, 5]);
    expect(result.change).toBe(1200 + 300 - 200);
    expect(result.change).toBe(sumPriceChanges(result.items));
    expect([...result.items].sort(comparePriceMovers)).toEqual(result.items);
    expect(priceMoverPeriodResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ period: '7d', baselineAt: PERIOD.baselineAt });
  });

  it('is empty, with a sum of 0, for a tab where nothing moved', () => {
    expect(moversForTab(PERIOD, sections, 3)).toMatchObject({ change: 0, items: [] });
  });

  it('recomputes the change and drops one that comes to 0', () => {
    // The change is never taken from the response: it is counted again for the tab.
    const stale = { ...PERIOD, items: [{ ...mover(1, 1, 1000, 1000), change: 1 }] };
    expect(moversForTab(stale, sections, 2)).toMatchObject({ change: 0, items: [] });
  });
});
