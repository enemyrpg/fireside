import { describe, expect, it } from 'vitest';
import { NO_TRADES, PRICE_SIDE_RATIO, windowPrice, type TradeSums } from './rule.js';

/** Sums of `volume` trades at `avg` on each side. */
const sums = (high: [number, number] | null, low: [number, number] | null): TradeSums => ({
  highValue: high ? high[0] * high[1] : 0,
  highVolume: high ? high[1] : 0,
  lowValue: low ? low[0] * low[1] : 0,
  lowVolume: low ? low[1] : 0,
});

describe('windowPrice', () => {
  it('is null without trades', () => {
    expect(windowPrice(NO_TRADES)).toBeNull();
  });

  it('uses the one side that traded: a side without trades is simply absent', () => {
    expect(windowPrice(sums(null, [1_000, 5]))).toBe(1_000);
    expect(windowPrice(sums([1_200, 3], null))).toBe(1_200);
  });

  it('weights both sides by volume, rounded down', () => {
    // (110 × 1 + 100 × 3) ÷ 4 = 102.5
    expect(windowPrice(sums([110, 1], [100, 3]))).toBe(102);
    // A side that traded more counts more.
    expect(windowPrice(sums([1_500, 9], [1_000, 1]))).toBe(1_450);
  });

  it('uses only the side with more trades when one average is more than 2× the other', () => {
    expect(PRICE_SIDE_RATIO).toBe(2);
    // One odd insta-buy against many insta-sells.
    expect(windowPrice(sums([821_750, 1], [2_000, 40]))).toBe(2_000);
    // The other way round: a stale low side outweighed by insta-buys.
    expect(windowPrice(sums([5_000, 30], [100, 2]))).toBe(5_000);
  });

  it('keeps both sides at exactly 2×, and takes the lower side on a tie above it', () => {
    expect(windowPrice(sums([200, 1], [100, 1]))).toBe(150);
    expect(windowPrice(sums([201, 1], [100, 1]))).toBe(100);
    expect(windowPrice(sums([100, 4], [500, 4]))).toBe(100);
  });

  it('is never below 1 gp, and exact for large prices', () => {
    expect(windowPrice({ highValue: 0, highVolume: 3, lowValue: 0, lowVolume: 0 })).toBe(1);
    const bow = 1_500_000_000;
    expect(windowPrice(sums([bow + 2, 200], [bow, 200]))).toBe(bow + 1);
  });
});
