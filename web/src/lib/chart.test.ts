import { describe, expect, it } from 'vitest';
import { hourTicks, valueDomain } from './chart';

describe('valueDomain', () => {
  it('lets Recharts choose when the values differ, and pads a flat line', () => {
    expect(valueDomain([1, 2])).toEqual(['auto', 'auto']);
    expect(valueDomain([])).toEqual(['auto', 'auto']);
    expect(valueDomain([2_000_000, 2_000_000])).toEqual([1_980_000, 2_020_000]);
    expect(valueDomain([0])).toEqual([0, 10]);
    expect(valueDomain([27_548_820, 27_548_820])).toEqual([27_273_332, 27_824_308]);
    expect(valueDomain([500])).toEqual([490, 510]);
  });
});

describe('hourTicks', () => {
  it('uses whole hours, at least one hour per step', () => {
    expect(hourTicks(0)).toEqual([0, 3600, 7200, 10800, 14400]);
    expect(hourTicks(4 * 3600)).toEqual([0, 3600, 7200, 10800, 14400]);
    expect(hourTicks(4 * 3600 + 1)).toEqual([0, 7200, 14400, 21600, 28800]);
  });

  it('uses 2-hour units above 10 hours', () => {
    expect(hourTicks(11 * 3600)).toEqual([0, 4, 8, 12, 16].map((hours) => hours * 3600));
    expect(hourTicks(40 * 3600)).toEqual([0, 10, 20, 30, 40].map((hours) => hours * 3600));
  });
});
