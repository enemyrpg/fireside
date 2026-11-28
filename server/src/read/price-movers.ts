import {
  addCapped,
  comparePriceMovers,
  priceMoverChange,
  sumPriceChanges,
  type PriceMoverItem,
  type PriceMoverPeriodResult,
  type PriceMoversResponse,
} from '@fireside/shared';
import type { Queryable } from '../db/index.js';
import { currentWindow, priceBaselines } from '../prices/history.js';
import { bank, potionStorage } from './bank.js';
import type { PriceLookup } from './prices.js';

// `GET …/bank/price-movers`: how price changes moved the value of what the
// accounts hold now. Holdings and current prices are exactly those of `bank`
// and `potion-storage`; the earlier prices are the same rule over earlier
// windows of stored hours and days (prices/history.ts). Reads only: nothing
// is fetched and nothing is pruned here.

/** What is held of one item, at the current price. */
type Holding =
  | { kind: 'ITEM'; itemId: number; name: string; priceEach: number; quantity: number }
  | {
      kind: 'POTION';
      itemId: number;
      name: string;
      priceEach: number;
      doses: number;
      itemDoses: number;
    };

/**
 * Everything in scope that has a current price, one entry per item: bank,
 * inventory and equipment together, potion storage apart (it is valued per
 * dose). Coins and platinum tokens always use the snapshot price
 * (`currentPrices`), and so do items the price source does not have: they
 * are not `CURRENT` and are left out, as their price cannot move.
 */
function holdings(db: Queryable, accountIds: readonly number[], prices: PriceLookup): Holding[] {
  const byKey = new Map<string, Holding>();
  for (const account of bank(db, accountIds, prices).banks) {
    for (const item of [...account.items, ...account.inventory.items, ...account.equipment.items]) {
      if (item.gePriceSource !== 'CURRENT' || item.quantity === 0) continue;
      const key = `ITEM:${String(item.itemId)}`;
      const held = byKey.get(key);
      if (held?.kind === 'ITEM') held.quantity = addCapped(held.quantity, item.quantity);
      else {
        byKey.set(key, {
          kind: 'ITEM',
          itemId: item.itemId,
          name: item.name,
          priceEach: item.gePriceEach,
          quantity: item.quantity,
        });
      }
    }
  }
  for (const storage of potionStorage(db, accountIds, prices).storages) {
    for (const potion of storage.potions) {
      if (potion.gePriceSource !== 'CURRENT') continue;
      // The same potion in two accounts' storages is one entry (the doses of
      // a full item belong to the item, so they are the same in both).
      const key = `POTION:${String(potion.itemId)}`;
      const held = byKey.get(key);
      if (held?.kind === 'POTION') held.doses = addCapped(held.doses, potion.doses);
      else {
        byKey.set(key, {
          kind: 'POTION',
          itemId: potion.itemId,
          name: potion.name,
          priceEach: potion.gePriceEach,
          doses: potion.doses,
          itemDoses: potion.itemDoses,
        });
      }
    }
  }
  return [...byKey.values()];
}

/**
 * The periods that have a baseline, each with every held item whose value
 * moved. An item is compared only when its current price is from the
 * current 24 h window and it traded in the baseline window too; one whose
 * value is the same is left out as well: neither adds to the sum.
 */
export function priceMovers(
  db: Queryable,
  accountIds: readonly number[],
  prices: PriceLookup,
): PriceMoversResponse {
  const { fetchedAt } = prices.prices;
  if (fetchedAt === null) return { prices: prices.prices, periods: [] };
  const window = currentWindow(db);
  if (window === null) return { prices: prices.prices, periods: [] };
  // Only items traded in the current window. An item priced from the 7 day
  // or last-day fallback would be compared with a baseline counted back from
  // the window's end: a change over the wrong time. Such an item is left out.
  const held = holdings(db, accountIds, prices).filter(
    (item) => window.hours.get(item.itemId) === item.priceEach,
  );
  const periods: PriceMoverPeriodResult[] = [];
  for (const baseline of priceBaselines(db, window)) {
    // Only with a clock that was wrong when the last hour was stored.
    if (baseline.baselineAt >= fetchedAt) continue;
    const items: PriceMoverItem[] = [];
    for (const item of held) {
      const previousPriceEach = baseline.priceOf.get(item.itemId);
      if (previousPriceEach === undefined) continue;
      const priced = { ...item, previousPriceEach };
      const change = priceMoverChange(priced);
      if (change === 0) continue;
      items.push({ ...priced, change });
    }
    items.sort(comparePriceMovers);
    periods.push({
      period: baseline.period,
      baselineAt: baseline.baselineAt,
      change: sumPriceChanges(items),
      items,
    });
  }
  return { prices: prices.prices, periods };
}
