// Bank and potion storage rules shared by server and dashboard.

/** Bank tabs 1–9 in `bank.snapshot.tabSizes`. Tab 0 is the main tab. */
export const BANK_TAB_COUNT = 9;

/** The main tab: items after tabs 1–9 in container order. */
export const MAIN_BANK_TAB = 0;

/** Most items in one `bank.snapshot` (the game has ~1 410 slots today). */
export const MAX_BANK_ITEMS = 2000;

/** Most entries in `bank.snapshot.inventory` (one per occupied slot). */
export const MAX_INVENTORY_ITEMS = 28;

/** Most entries in `bank.snapshot.equipment` (one per slot). */
export const MAX_EQUIPMENT_ITEMS = 14;

/** Most doses an item in potion storage holds (`itemDoses`). */
export const MAX_ITEM_DOSES = 4;

export const COINS_ITEM_ID = 995;
export const PLATINUM_TOKEN_ITEM_ID = 13204;
/** Coins per platinum token. */
export const PLATINUM_TOKEN_VALUE = 1000;

/**
 * Bank filler: a reserved empty slot. Sent as an ordinary item in its position
 * (so the bank is 1:1 with the game), but never counted as an item or valued.
 */
export const BANK_FILLER_ITEM_ID = 20594;

export function isBankFiller(itemId: number): boolean {
  return itemId === BANK_FILLER_ITEM_ID;
}

/** Values are capped here, like loot sums, so absurd data never overflows. */
export const MAX_VALUE = Number.MAX_SAFE_INTEGER;

/** `a + b`, capped at `MAX_VALUE`. */
export function addCapped(a: number, b: number): number {
  return Math.min(a + b, MAX_VALUE);
}

/** `quantity * price`, capped at `MAX_VALUE`. */
export function itemValue(quantity: number, price: number): number {
  return Math.min(quantity * price, MAX_VALUE);
}

/**
 * Tab of each position in container order: `tabSizes[0]` items in tab 1, …,
 * `tabSizes[8]` in tab 9, the rest in the main tab (0).
 */
export function tabsOf(tabSizes: readonly number[], itemCount: number): number[] {
  const tabs: number[] = [];
  tabSizes.forEach((size, index) => {
    for (let i = 0; i < size && tabs.length < itemCount; i++) tabs.push(index + 1);
  });
  while (tabs.length < itemCount) tabs.push(MAIN_BANK_TAB);
  return tabs;
}

/**
 * Container order: tabs 1–9, then the main tab. This is the order of `tabs`
 * and `items` in the API, not the order the game shows them in (see
 * `bankTabDisplayOrder`).
 */
export function compareBankTabs(a: number, b: number): number {
  const rank = (tab: number) => (tab === MAIN_BANK_TAB ? BANK_TAB_COUNT + 1 : tab);
  return rank(a) - rank(b);
}

/**
 * Order tabs are shown in, as in the game's "View all": the main tab first,
 * then tabs 1–9. Returns a new array; the input (container order) is unchanged.
 */
export function bankTabDisplayOrder<T extends { tab: number }>(tabs: readonly T[]): T[] {
  const rank = (tab: number) => (tab === MAIN_BANK_TAB ? -1 : tab);
  return [...tabs].sort((a, b) => rank(a.tab) - rank(b.tab));
}

/** Cash in coins: coins + platinum tokens × 1 000. Other items count 0. */
export function cashValue(items: Iterable<{ itemId: number; quantity: number }>): number {
  let total = 0;
  for (const { itemId, quantity } of items) {
    if (itemId === COINS_ITEM_ID) total = addCapped(total, quantity);
    else if (itemId === PLATINUM_TOKEN_ITEM_ID) {
      total = addCapped(total, itemValue(quantity, PLATINUM_TOKEN_VALUE));
    }
  }
  return total;
}

/**
 * Value of `doses` of a potion whose full item (`itemDoses` doses, usually 4)
 * costs `price`: ⌊price × doses ÷ itemDoses⌋, capped at `MAX_VALUE`. Divides
 * last, so per-dose prices are never rounded before multiplying.
 */
export function potionValue(price: number, doses: number, itemDoses: number): number {
  return Math.min(Math.floor((price * doses) / itemDoses), MAX_VALUE);
}

// --- Price movers -----------------------------------------------------------
// Here and not next to their schema, so the dashboard can recount price
// movers for one bank tab without bundling Zod.

/** Value at `priceEach` minus value at `previousPriceEach`, by the bank's own value rules. */
export function priceMoverChange(
  item:
    | { kind: 'ITEM'; quantity: number; priceEach: number; previousPriceEach: number }
    | {
        kind: 'POTION';
        doses: number;
        itemDoses: number;
        priceEach: number;
        previousPriceEach: number;
      },
): number {
  return item.kind === 'ITEM'
    ? itemValue(item.quantity, item.priceEach) - itemValue(item.quantity, item.previousPriceEach)
    : potionValue(item.priceEach, item.doses, item.itemDoses) -
        potionValue(item.previousPriceEach, item.doses, item.itemDoses);
}

/**
 * Sum of the changes, kept inside ±(2^53 − 1). Positive and negative parts
 * are summed apart (each capped), so the result does not depend on the order.
 */
export function sumPriceChanges(items: readonly { change: number }[]): number {
  let up = 0;
  let down = 0;
  for (const { change } of items) {
    if (change > 0) up = addCapped(up, change);
    else down = addCapped(down, -change);
  }
  return up - down;
}

/** Largest gain first, then item ID, then `ITEM` before `POTION`. */
export function comparePriceMovers(
  a: { change: number; itemId: number; kind: string },
  b: { change: number; itemId: number; kind: string },
): number {
  return b.change - a.change || a.itemId - b.itemId || (a.kind < b.kind ? -1 : +(a.kind > b.kind));
}
