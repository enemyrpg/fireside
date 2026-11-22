import {
  COINS_ITEM_ID,
  PLATINUM_TOKEN_ITEM_ID,
  type BankPrices,
  type BankPriceSource,
} from '@fireside/shared';
import type { Queryable } from '../db/index.js';
import { itemPrices } from '../db/schema.js';
import { sourceState } from '../external/state.js';

// Current GE prices for valuing the latest bank, inventory, equipment and
// potion storage. History, loot and raid drops never use them: they keep the price from
// when they happened.

export interface PriceUsed {
  gePriceEach: number;
  gePriceSource: BankPriceSource;
}

export interface PriceLookup {
  /** What the response reports in `prices`. */
  prices: BankPrices;
  /** The current price of the item if there is one, else `snapshotEach`. */
  priceOf(itemId: number, snapshotEach: number): PriceUsed;
}

/** Every price is the one the plugin sent with the snapshot. */
export const SNAPSHOT_PRICES: PriceLookup = {
  prices: { source: 'SNAPSHOT', fetchedAt: null },
  priceOf: (_itemId, snapshotEach) => ({ gePriceEach: snapshotEach, gePriceSource: 'SNAPSHOT' }),
};

/**
 * The price used for an item, computed exactly like RuneLite's `wikiPrice`
 * (`computeWikiPrice` in api.runelite.net, which `ItemManager.getItemPrice`
 * returns with "Use actively traded price" on, the default): the midpoint of
 * the wiki's latest low and high, `low + ⌊(high − low) ÷ 2⌋`, when both are
 * above 0, else the larger of the two. `null` when neither is.
 * See docs/architecture.md#external-sources.
 */
export function currentPrice(high: number | null, low: number | null): number | null {
  const h = high ?? 0;
  const l = low ?? 0;
  if (h > 0 && l > 0) return l + Math.floor((h - l) / 2);
  const price = Math.max(h, l);
  return price > 0 ? price : null;
}

/**
 * Current prices when `active` (`PRICES_ENABLED` and `USER_AGENT_CONTACT`)
 * and a fetch has succeeded at some point; else snapshot prices. Old prices
 * are still used after failed fetches: `fetchedAt` says how old they are.
 * Items without a row keep their snapshot price: untradeables and noted
 * items (the wiki only has un-noted IDs, and the server never maps IDs).
 * Coins and platinum tokens always do, so `cashValue` agrees with the items.
 */
export function currentPrices(db: Queryable, active: boolean): PriceLookup {
  if (!active) return SNAPSHOT_PRICES;
  const fetchedAt = sourceState(db, 'WIKI_PRICES')?.lastSuccessAt ?? null;
  if (fetchedAt === null) return SNAPSHOT_PRICES;
  const byItem = new Map<number, number>();
  for (const row of db.select().from(itemPrices).all()) {
    const each = currentPrice(row.high, row.low);
    if (each !== null) byItem.set(row.itemId, each);
  }
  if (byItem.size === 0) return SNAPSHOT_PRICES;
  return {
    prices: { source: 'CURRENT', fetchedAt },
    priceOf(itemId, snapshotEach) {
      const each =
        itemId === COINS_ITEM_ID || itemId === PLATINUM_TOKEN_ITEM_ID
          ? undefined
          : byItem.get(itemId);
      return each === undefined
        ? { gePriceEach: snapshotEach, gePriceSource: 'SNAPSHOT' }
        : { gePriceEach: each, gePriceSource: 'CURRENT' };
    },
  };
}
