import {
  addCapped,
  bankTabDisplayOrder,
  comparePriceMovers,
  isBankFiller,
  MAIN_BANK_TAB,
  MAX_INVENTORY_ITEMS,
  priceMoverChange,
  sumPriceChanges,
  type AccountBank,
  type AccountPotionStorage,
  type BankHistoryDay,
  type BankItemResponse,
  type ContainerItemResponse,
  type PriceMoverItem,
  type PriceMoverPeriod,
  type PriceMoverPeriodResult,
} from '@fireside/shared';

// Rules of the Bank page. The API keeps the bank in container order; everything
// about how it is shown lives here.

/** Path of the Bank page below `/:acc` (also in the page registry). */
export const BANK_PAGE_PATH = 'bank';

/** Link to the Bank page of an account or `all`. */
export function bankHref(scope: string | number): string {
  return `/${String(scope)}/${BANK_PAGE_PATH}`;
}

/** The GE | HA toggle. It applies to every number, list and chart on the page. */
export type ValueMode = 'ge' | 'ha';

export const VALUE_MODE_LABEL: Record<ValueMode, string> = { ge: 'GE', ha: 'HA' };

/** `?value=`: anything but `ha` is GE. */
export function parseValueMode(value: string | null): ValueMode {
  return value === 'ha' ? 'ha' : 'ge';
}

/** Ranges of "Value over time" (`?range=`). */
export type HistoryRange = '30d' | '90d' | '1y';

/** Days in each range. `1y` is the API's own default (no `from`/`to`). */
export const HISTORY_RANGE_DAYS: Record<Exclude<HistoryRange, '1y'>, number> = {
  '30d': 30,
  '90d': 90,
};

/** `?range=`: missing or invalid is one year. */
export function parseHistoryRange(value: string | null): HistoryRange {
  return value === '30d' || value === '90d' ? value : '1y';
}

/**
 * The "All" view of a bank with more than `ALL_VIEW_LIMIT_ABOVE` slots shows
 * only the first `ALL_VIEW_COLLAPSED_SLOTS` (20 rows) until "Show all".
 */
export const ALL_VIEW_LIMIT_ABOVE = 240;
export const ALL_VIEW_COLLAPSED_SLOTS = 160;

/** Slots per row in the bank, as in the game. */
export const BANK_COLUMNS = 8;

/** Potions per row in Potion storage. */
export const POTION_COLUMNS = 6;

/** Potions shown before "Show all N": four rows. Page state only, like the bank's "Show all". */
export const POTIONS_SHOWN = 24;

/** The sections of the page on mobile (`?section=`). On PC everything shows. */
export type BankSectionChoice = 'bank' | 'carried' | 'potions' | 'value';

/**
 * The sections an account has, in order: Bank and Carried need a bank
 * snapshot, Potions a potion storage with potions; Value is always there.
 * The first is the default.
 */
export function bankSectionsFor(
  hasBank: boolean,
  hasPotions: boolean,
): readonly BankSectionChoice[] {
  return [
    ...(hasBank ? (['bank', 'carried'] as const) : []),
    ...(hasPotions ? (['potions'] as const) : []),
    'value',
  ];
}

/**
 * `?section=`: one of `available` (`bankSectionsFor`). Missing, unknown or a
 * section the account lacks (e.g. `potions` without potions) is the first.
 */
export function parseBankSection(
  value: string | null,
  available: readonly BankSectionChoice[],
): BankSectionChoice {
  return available.find((section) => section === value) ?? available[0] ?? 'value';
}

/** What `?section=` holds: nothing for the default (the first available). */
export function sectionParam(
  choice: BankSectionChoice,
  available: readonly BankSectionChoice[],
): string | null {
  return choice === available[0] ? null : choice;
}

/** Rows of the list view before "Show all (n)". */
export const BANK_LIST_ROWS = 15;

/** Stacks in "Most valuable". */
export const MOST_VALUABLE_COUNT = 6;

interface Valued {
  geValue: number;
  haValue: number;
}

export function valueOf(row: Valued, mode: ValueMode): number {
  return mode === 'ge' ? row.geValue : row.haValue;
}

export function priceOf(row: { gePriceEach: number; haPriceEach: number }, mode: ValueMode) {
  return mode === 'ge' ? row.gePriceEach : row.haPriceEach;
}

function sumValues(rows: readonly Valued[], mode: ValueMode): number {
  return rows.reduce((sum, row) => addCapped(sum, valueOf(row, mode)), 0);
}

// --- Slots ------------------------------------------------------------------

export type BankSlotKind = 'item' | 'placeholder' | 'filler';

/** A filler is a reserved empty slot: never an item, never valued. */
export function slotKind(item: Pick<BankItemResponse, 'itemId' | 'placeholder'>): BankSlotKind {
  if (isBankFiller(item.itemId)) return 'filler';
  return item.placeholder ? 'placeholder' : 'item';
}

/** Items: slots that are neither a placeholder nor a filler. */
export function countItems(items: readonly BankItemResponse[]): number {
  return items.filter((item) => slotKind(item) === 'item').length;
}

export function countPlaceholders(items: readonly BankItemResponse[]): number {
  return items.filter((item) => slotKind(item) === 'placeholder').length;
}

/** Value of the slots. Fillers never count, whatever price the data has. */
export function slotsValue(items: readonly BankItemResponse[], mode: ValueMode): number {
  return sumValues(
    items.filter((item) => slotKind(item) !== 'filler'),
    mode,
  );
}

// --- Tabs -------------------------------------------------------------------

/** `'all'`, or a tab: 0 is the main tab. */
export type TabChoice = 'all' | number;

export interface BankSection {
  tab: number;
  /** Every slot of the tab, in game order. */
  items: BankItemResponse[];
  /** Items in the tab: no placeholders, no fillers. */
  itemCount: number;
  geValue: number;
  haValue: number;
}

/**
 * The tabs that have slots, in the order the game shows them: the main tab
 * first, then tabs 1–9.
 */
export function bankSections(bank: Pick<AccountBank, 'tabs' | 'items'>): BankSection[] {
  return bankTabDisplayOrder(bank.tabs)
    .map(({ tab }) => {
      const items = bank.items.filter((item) => item.tab === tab);
      return {
        tab,
        items,
        itemCount: countItems(items),
        geValue: slotsValue(items, 'ge'),
        haValue: slotsValue(items, 'ha'),
      };
    })
    .filter((section) => section.items.length > 0);
}

/** Tab buttons and "By tab" only show when the bank has tabs 1–9. */
export function hasTabs(sections: readonly BankSection[]): boolean {
  return sections.some((section) => section.tab !== MAIN_BANK_TAB);
}

/** `?tab=main|1…9`; anything else, or a tab without slots, is `all`. */
export function parseTab(value: string | null, sections: readonly BankSection[]): TabChoice {
  if (value === null) return 'all';
  const tab = value === 'main' ? MAIN_BANK_TAB : /^[1-9]$/.test(value) ? Number(value) : null;
  return tab !== null && sections.some((section) => section.tab === tab) ? tab : 'all';
}

/** The `?tab=` value of a choice; `null` for All (no parameter). */
export function tabParam(choice: TabChoice): string | null {
  if (choice === 'all') return null;
  return choice === MAIN_BANK_TAB ? 'main' : String(choice);
}

/** The sections a choice shows: all of them, or the one tab. */
export function sectionsOf(sections: readonly BankSection[], choice: TabChoice): BankSection[] {
  return choice === 'all' ? [...sections] : sections.filter((section) => section.tab === choice);
}

/** The first slot that is not a filler: the icon on a tab button. */
export function tabIconItem(section: BankSection): BankItemResponse | undefined {
  return section.items.find((item) => slotKind(item) !== 'filler');
}

// --- "Show all" in the All view ---------------------------------------------

export interface VisibleSection extends BankSection {
  /** The slots to draw. Fewer than `items` where the view is cut. */
  visible: BankItemResponse[];
}

export interface AllView {
  sections: VisibleSection[];
  totalSlots: number;
  /** The bank is long enough to have "Show all" / "Show less". */
  collapsible: boolean;
  /** Slots are left out right now. */
  cut: boolean;
}

/**
 * What the grid shows. Only the All view of a bank with more than
 * `ALL_VIEW_LIMIT_ABOVE` slots is cut, to the first `ALL_VIEW_COLLAPSED_SLOTS`
 * in display order, also in the middle of a tab. Sections keep their real
 * count and value. A chosen tab always shows everything.
 */
export function visibleSections(
  sections: readonly BankSection[],
  choice: TabChoice,
  expanded: boolean,
): AllView {
  const chosen = sectionsOf(sections, choice);
  const totalSlots = chosen.reduce((sum, section) => sum + section.items.length, 0);
  const collapsible = choice === 'all' && totalSlots > ALL_VIEW_LIMIT_ABOVE;
  const cut = collapsible && !expanded;
  let left = cut ? ALL_VIEW_COLLAPSED_SLOTS : Infinity;
  const visible: VisibleSection[] = [];
  for (const section of chosen) {
    if (left <= 0) break;
    const shown = section.items.slice(0, left);
    left -= shown.length;
    visible.push({ ...section, visible: shown });
  }
  return { sections: visible, totalSlots, collapsible, cut };
}

// --- Search, list and most valuable -------------------------------------------

/**
 * Slots whose name contains `query`, from every tab in display order. Fillers
 * never match, placeholders only while they are shown.
 */
export function searchBank(
  sections: readonly BankSection[],
  query: string,
  showPlaceholders: boolean,
): BankItemResponse[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return sections
    .flatMap((section) => section.items)
    .filter((item) => {
      const kind = slotKind(item);
      if (kind === 'filler' || (kind === 'placeholder' && !showPlaceholders)) return false;
      return item.name.toLowerCase().includes(needle);
    });
}

/** Where a slot comes in the order the game shows the bank: the main tab first, then tabs 1–9. */
function compareDisplayOrder(a: BankItemResponse, b: BankItemResponse): number {
  const rank = (tab: number) => (tab === MAIN_BANK_TAB ? -1 : tab);
  return rank(a.tab) - rank(b.tab) || a.position - b.position;
}

/**
 * Items (no placeholders, no fillers) by value, highest first; ties in the
 * order the game shows them (not container order).
 */
export function listRows(items: readonly BankItemResponse[], mode: ValueMode): BankItemResponse[] {
  return items
    .filter((item) => slotKind(item) === 'item')
    .sort((a, b) => valueOf(b, mode) - valueOf(a, mode) || compareDisplayOrder(a, b));
}

export function mostValuable(
  items: readonly BankItemResponse[],
  mode: ValueMode,
  count = MOST_VALUABLE_COUNT,
): BankItemResponse[] {
  return listRows(items, mode).slice(0, count);
}

// --- Price movers --------------------------------------------------

/** Buttons of the period choice. */
export const MOVER_PERIOD_LABEL: Record<PriceMoverPeriod, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
};

/** "from price changes in …". */
export const MOVER_PERIOD_TEXT: Record<PriceMoverPeriod, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

/** The period shown when the URL names none (or one without price history). */
export const DEFAULT_MOVER_PERIOD: PriceMoverPeriod = '7d';

/** Rows under "Gained most" and under "Lost most" before "Show all". */
export const MOVERS_SHOWN = { desktop: 4, mobile: 3 } as const;

/**
 * `?movers=`: the period asked for if the server has price history for it,
 * else 7 days, else the first there is. `undefined` without any: the card
 * then has no Price movers at all.
 */
export function moverPeriodOf(
  value: string | null,
  periods: readonly PriceMoverPeriodResult[],
): PriceMoverPeriodResult | undefined {
  return (
    periods.find((result) => result.period === value) ??
    periods.find((result) => result.period === DEFAULT_MOVER_PERIOD) ??
    periods[0]
  );
}

/** What `?movers=` holds: nothing for the period shown by default. */
export function moverParam(
  period: PriceMoverPeriod,
  periods: readonly PriceMoverPeriodResult[],
): string | null {
  return moverPeriodOf(null, periods)?.period === period ? null : period;
}

/**
 * The items whose value rose, largest gain first, and the ones whose value
 * fell, largest loss first. The response is sorted by change, so the losses
 * are its tail, reversed.
 */
export function splitMovers(items: readonly PriceMoverItem[]): {
  gained: PriceMoverItem[];
  lost: PriceMoverItem[];
} {
  return {
    gained: items.filter((item) => item.change > 0),
    lost: items.filter((item) => item.change < 0).reverse(),
  };
}

/** The price change of one item as a ratio: `0.042` for +4.2 %. */
export function moverRatio(item: Pick<PriceMoverItem, 'priceEach' | 'previousPriceEach'>): number {
  return (item.priceEach - item.previousPriceEach) / item.previousPriceEach;
}

/** Key of a row: an item can be listed once as an item and once as a potion. */
export function moverKey(item: Pick<PriceMoverItem, 'kind' | 'itemId'>): string {
  return `${item.kind}:${String(item.itemId)}`;
}

/**
 * Price movers of the tab shown. The API sums everything held (bank,
 * inventory, equipment and potion storage) and knows no tabs, so for a tab
 * the items are counted again from its slots (placeholders and fillers hold
 * nothing) at the period's prices, by the same rules as the server: zero
 * changes left out, sorted and summed with the contract's own helpers. Potion
 * storage is never in a tab. `all` is the response as it is.
 */
export function moversForTab(
  period: PriceMoverPeriodResult,
  sections: readonly BankSection[],
  tab: TabChoice,
): PriceMoverPeriodResult {
  if (tab === 'all') return period;
  const quantities = new Map<number, number>();
  for (const section of sectionsOf(sections, tab)) {
    for (const item of section.items) {
      if (slotKind(item) !== 'item') continue;
      quantities.set(item.itemId, addCapped(quantities.get(item.itemId) ?? 0, item.quantity));
    }
  }
  const items: PriceMoverItem[] = [];
  for (const mover of period.items) {
    if (mover.kind !== 'ITEM') continue;
    const quantity = quantities.get(mover.itemId);
    if (quantity === undefined || quantity === 0) continue;
    const held = { ...mover, quantity };
    const change = priceMoverChange(held);
    if (change !== 0) items.push({ ...held, change });
  }
  items.sort(comparePriceMovers);
  return { ...period, change: sumPriceChanges(items), items };
}

// --- Net worth ----------------------------------------------------------------

export interface NetWorth {
  /** Bank + potion storage + carried. */
  total: number;
  bank: number;
  potionStorage: number;
  inventory: number;
  equipment: number;
  /** Inventory + equipment. */
  carried: number;
}

const sumOf = (...values: number[]) => values.reduce(addCapped, 0);

/**
 * Net worth of one account from its latest bank and potion storage. Either
 * may be missing. The bank is the value of its slots without fillers
 * (`slotsValue`), so it always equals the sum of the tabs on the page.
 */
export function netWorth(
  bank: Pick<AccountBank, 'items' | 'inventory' | 'equipment'> | undefined,
  potions: Pick<AccountPotionStorage, 'totals'> | undefined,
  mode: ValueMode,
): NetWorth {
  const bankValue = bank ? slotsValue(bank.items, mode) : 0;
  const potionStorage = potions ? valueOf(potions.totals, mode) : 0;
  const inventory = bank ? valueOf(bank.inventory, mode) : 0;
  const equipment = bank ? valueOf(bank.equipment, mode) : 0;
  const carried = sumOf(inventory, equipment);
  return {
    total: sumOf(bankValue, potionStorage, carried),
    bank: bankValue,
    potionStorage,
    inventory,
    equipment,
    carried,
  };
}

/** Sum of several accounts' net worth. */
export function sumNetWorth(parts: readonly NetWorth[]): NetWorth {
  const zero: NetWorth = {
    total: 0,
    bank: 0,
    potionStorage: 0,
    inventory: 0,
    equipment: 0,
    carried: 0,
  };
  return parts.reduce<NetWorth>((sum, part) => {
    for (const key of Object.keys(zero) as (keyof NetWorth)[]) {
      sum[key] = addCapped(sum[key], part[key]);
    }
    return sum;
  }, zero);
}

export interface HistoryPoint {
  /** Local date (`2026-11-09`). */
  date: string;
  /** Net worth: bank + potion storage + carried. */
  value: number;
  bank: number;
  potionStorage: number;
  carried: number;
  cash: number;
}

/** One point per day of `bank/history` in the chosen value. Cash is the same in both. */
export function historyPoints(days: readonly BankHistoryDay[], mode: ValueMode): HistoryPoint[] {
  return days.map((day) => {
    const ge = mode === 'ge';
    const bank = ge ? day.bankGeValue : day.bankHaValue;
    const potionStorage = ge ? day.potionStorageGeValue : day.potionStorageHaValue;
    const carried = ge
      ? sumOf(day.inventoryGeValue, day.equipmentGeValue)
      : sumOf(day.inventoryHaValue, day.equipmentHaValue);
    return {
      date: day.date,
      value: sumOf(bank, potionStorage, carried),
      bank,
      potionStorage,
      carried,
      cash: day.cashValue,
    };
  });
}

// --- Carried: inventory and equipment -------------------------------------------

/** Inventory slots per row and rows, as in the game. */
export const INVENTORY_COLUMNS = 4;
export const INVENTORY_ROWS = 7;

/**
 * The inventory as 28 slots by `position`, `null` where a slot is empty. An
 * item the 28 slots have no place for (a position beyond them, or one that is
 * taken) goes in extra rows below, so nothing is left out and the grid never
 * grows with the position itself.
 */
export function inventoryCells(
  items: readonly ContainerItemResponse[],
): (ContainerItemResponse | null)[] {
  const cells = Array<ContainerItemResponse | null>(MAX_INVENTORY_ITEMS).fill(null);
  const extra: ContainerItemResponse[] = [];
  for (const item of items) {
    if (item.position < MAX_INVENTORY_ITEMS && cells[item.position] === null) {
      cells[item.position] = item;
    } else extra.push(item);
  }
  const padding = (INVENTORY_COLUMNS - (extra.length % INVENTORY_COLUMNS)) % INVENTORY_COLUMNS;
  return [...cells, ...extra, ...Array<null>(padding).fill(null)];
}

/** The extra ammo slot of Dizana's quiver. */
export const QUIVER_AMMO_SLOT = 'QUIVER_AMMO';

export const EQUIPMENT_COLUMNS = 3;

/**
 * The game's equipment panel, row by row; `null` is a gap. The quiver's ammo
 * sits top right, straight above Ammo.
 */
export const EQUIPMENT_LAYOUT: readonly (string | null)[] = [
  ...[null, 'HEAD', QUIVER_AMMO_SLOT],
  ...['CAPE', 'AMULET', 'AMMO'],
  ...['WEAPON', 'BODY', 'SHIELD'],
  ...[null, 'LEGS', null],
  ...['GLOVES', 'BOOTS', 'RING'],
];

export type EquipmentCell =
  | { kind: 'gap' }
  /** A slot of the panel; `item` is `null` when nothing is worn there. */
  | { kind: 'slot'; slot: string; item: ContainerItemResponse | null };

/**
 * Worn items laid out like the game. The quiver slot is a gap unless it holds
 * ammo (without a quiver there is no such slot). An item the panel has no
 * place for (a slot the layout doesn't know, no slot, or a second item in a
 * slot) goes in extra rows below, so nothing worn is ever left out.
 */
export function equipmentCells(items: readonly ContainerItemResponse[]): EquipmentCell[] {
  const placed = new Set<ContainerItemResponse>();
  const cells: EquipmentCell[] = EQUIPMENT_LAYOUT.map((slot) => {
    if (slot === null) return { kind: 'gap' };
    const item = items.find((entry) => entry.slot === slot) ?? null;
    if (item) placed.add(item);
    if (slot === QUIVER_AMMO_SLOT && item === null) return { kind: 'gap' };
    return { kind: 'slot', slot, item };
  });
  for (const item of items) {
    if (!placed.has(item)) cells.push({ kind: 'slot', slot: item.slot ?? 'UNKNOWN', item });
  }
  return cells;
}

// --- Layout -------------------------------------------------------------------

/** Space between the top bar (or the window's bottom edge) and a sticky column or capped card. */
export const STICKY_GAP = 20;

/**
 * Height of the window under the top bar, with `STICKY_GAP` above and below:
 * the most a card that scrolls inside itself may take (the collection log's
 * page list). At least `min`.
 */
export function stickyRoom(
  headerHeight: number,
  viewportHeight: number,
  safeTop = 0,
  min = 0,
): number {
  return Math.max(min, Math.round(viewportHeight - safeTop - headerHeight - 2 * STICKY_GAP));
}

/**
 * `top` of a sticky column that sticks only while it fits in the window under
 * the top bar (the selected session on Sessions). A taller column gets
 * `undefined` (no `top`, so it is not sticky) and scrolls with the page, so its
 * bottom can always be reached.
 */
export function stickyTopWhenFits(
  headerHeight: number,
  viewportHeight: number,
  columnHeight: number,
  safeTop = 0,
): number | undefined {
  const top = safeTop + headerHeight + STICKY_GAP;
  return top + columnHeight + STICKY_GAP <= viewportHeight ? top : undefined;
}
