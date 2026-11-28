import {
  COINS_ITEM_ID,
  PLATINUM_TOKEN_ITEM_ID,
  type BankPrices,
  type BankPriceSource,
} from '@fireside/shared';
import type { Queryable } from '../db/index.js';
import { sourceState } from '../external/state.js';
import { currentWindow } from '../prices/history.js';

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
 * Current prices when `active` (`PRICES_ENABLED` and `USER_AGENT_CONTACT`)
 * and a fetch has succeeded at some point; else snapshot prices. Each item's
 * price is the volume-weighted average of its trades in the 24 hours up to
 * the newest stored hour, with the outlier guard (prices/rule.ts); without
 * trades then, the last 7 UTC days, then its newest day with trades
 * (prices/history.ts). Old prices are still used after failed fetches:
 * `fetchedAt` says when prices were last fetched. Values can differ slightly
 * from RuneLite's own GE value, which is the midpoint of the latest
 * insta-buy and insta-sell. Items without trades in the 35 days kept keep
 * their snapshot price, and so do untradeables and noted items (the wiki only
 * has un-noted IDs, and the server never maps IDs). Coins and platinum
 * tokens always do, so `cashValue` agrees with the items.
 */
export function currentPrices(db: Queryable, active: boolean): PriceLookup {
  if (!active) return SNAPSHOT_PRICES;
  const fetchedAt = sourceState(db, 'WIKI_PRICES')?.lastSuccessAt ?? null;
  if (fetchedAt === null) return SNAPSHOT_PRICES;
  const byItem = currentWindow(db)?.prices;
  if (byItem === undefined || byItem.size === 0) return SNAPSHOT_PRICES;
  return {
    prices: { source: 'CURRENT', fetchedAt },
    priceOf(itemId, snapshotEach) {
      const each =
        itemId === COINS_ITEM_ID || itemId === PLATINUM_TOKEN_ITEM_ID
          ? undefined
          : byItem.get(itemId)?.each;
      return each === undefined
        ? { gePriceEach: snapshotEach, gePriceSource: 'SNAPSHOT' }
        : { gePriceEach: each, gePriceSource: 'CURRENT' };
    },
  };
}
