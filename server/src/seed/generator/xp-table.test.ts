import { describe, expect, it } from 'vitest';
import { levelForXp, xpForLevel } from './xp-table.js';

describe('xp table', () => {
  it('matches known values from the game', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(83);
    expect(xpForLevel(10)).toBe(1_154);
    expect(xpForLevel(50)).toBe(101_333);
    expect(xpForLevel(92)).toBe(6_517_253);
    expect(xpForLevel(99)).toBe(13_034_431);
  });

  it('gives the level for an XP amount', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(82)).toBe(1);
    expect(levelForXp(83)).toBe(2);
    expect(levelForXp(13_034_430)).toBe(98);
    expect(levelForXp(13_034_431)).toBe(99);
    expect(levelForXp(200_000_000)).toBe(99);
    for (let level = 1; level <= 99; level++) expect(levelForXp(xpForLevel(level))).toBe(level);
  });

  it('rejects levels outside 1–99', () => {
    expect(() => xpForLevel(0)).toThrow(RangeError);
    expect(() => xpForLevel(100)).toThrow(RangeError);
    expect(() => xpForLevel(1.5)).toThrow(RangeError);
  });
});
