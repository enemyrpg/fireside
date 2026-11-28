// The price of an item over a window of Grand Exchange trades (see
// docs/architecture.md#external-sources and
// docs/decisions/0021-prices-from-hourly-volume-weighted-averages.md). Bank
// values and every Price movers period use this one rule, so the movers' sum
// explains the change in net worth.

/** Trades in a window: the value (whole gp) and number of insta-buys and insta-sells. */
export interface TradeSums {
  highValue: number;
  highVolume: number;
  lowValue: number;
  lowVolume: number;
}

/**
 * When both sides traded and one side's average is more than this many times
 * the other's, the two are not the same market (a stale order, one odd
 * trade): only the side with more trades is used.
 */
export const PRICE_SIDE_RATIO = 2;

export const NO_TRADES: Readonly<TradeSums> = {
  highValue: 0,
  highVolume: 0,
  lowValue: 0,
  lowVolume: 0,
};

/** Whole gp, rounded down like RuneLite's own prices. At least 1: every trade costs something. */
const average = (value: number, volume: number) => Math.max(1, Math.floor(value / volume));

/**
 * The volume-weighted average price of every trade in the window, both sides
 * together. A side without trades is not used, so a stale side goes away by
 * itself. The outlier guard (`PRICE_SIDE_RATIO`) uses only the side with
 * more trades, or the lower average on a tie. `null` without any trade.
 */
export function windowPrice(sums: TradeSums): number | null {
  const { highValue, highVolume, lowValue, lowVolume } = sums;
  if (highVolume <= 0 && lowVolume <= 0) return null;
  if (highVolume <= 0) return average(lowValue, lowVolume);
  if (lowVolume <= 0) return average(highValue, highVolume);
  const high = highValue / highVolume;
  const low = lowValue / lowVolume;
  if (Math.max(high, low) > PRICE_SIDE_RATIO * Math.min(high, low)) {
    if (highVolume > lowVolume) return average(highValue, highVolume);
    if (lowVolume > highVolume) return average(lowValue, lowVolume);
    return high < low ? average(highValue, highVolume) : average(lowValue, lowVolume);
  }
  return average(highValue + lowValue, highVolume + lowVolume);
}
