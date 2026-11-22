import { describe, expect, it } from 'vitest';
import { currentPrice } from './prices.js';

// The same results as RuneLite's computeWikiPrice(low, high).
describe('currentPrice', () => {
  it.each([
    // Twisted bow and Bandos tassets from the wiki's /latest, 16 November 2026.
    [1_385_000_000, 1_380_000_000, 1_382_500_000],
    [11_401_999, 11_147_974, 11_274_986],
    [236, 227, 231],
    [5, 4, 4],
    // The sides can be the other way round.
    [100, 201, 150],
    [7, 7, 7],
    // Only one side.
    [185, null, 185],
    [null, 28_000_000, 28_000_000],
    [0, 60, 60],
    [60, 0, 60],
    // Prices pass 32 bits.
    [4_000_000_001, 4_000_000_000, 4_000_000_000],
    // Nothing usable.
    [null, null, null],
    [0, 0, null],
    [0, null, null],
  ])('high %j, low %j → %j', (high, low, expected) => {
    expect(currentPrice(high, low)).toBe(expected);
  });
});
