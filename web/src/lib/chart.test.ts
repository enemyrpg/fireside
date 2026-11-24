import { describe, expect, it } from 'vitest';
import { evenTicks, hourTicks, maxTickLabels, valueDomain } from './chart';

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

describe('evenTicks', () => {
  const days = (n: number) => Array.from({ length: n }, (_, index) => index);
  const gaps = (ticks: number[]) => ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));

  it('takes every step-th value, step = ceil(n / maxLabels)', () => {
    expect(evenTicks(days(30), 7)).toEqual([4, 9, 14, 19, 24, 29]);
    expect(evenTicks(days(30), 10)).toEqual([2, 5, 8, 11, 14, 17, 20, 23, 26, 29]);
    expect(evenTicks(days(365), 12)).toHaveLength(12);
    expect(new Set(gaps(evenTicks(days(365), 12)))).toEqual(new Set([31]));
  });

  it('counts back from the last value, so it is always labelled and every gap is equal', () => {
    for (const n of [7, 13, 30, 31, 90, 91, 365, 366]) {
      for (const max of [2, 3, 5, 6, 9, 14]) {
        const ticks = evenTicks(days(n), max);
        expect(ticks.at(-1)).toBe(n - 1);
        expect(ticks.length).toBeLessThanOrEqual(max);
        expect(new Set(gaps(ticks)).size).toBeLessThanOrEqual(1);
      }
    }
  });

  it('labels every value when there are no more than maxLabels', () => {
    expect(evenTicks(['Mon', 'Tue', 'Wed'], 7)).toEqual(['Mon', 'Tue', 'Wed']);
    expect(evenTicks(days(7), 7)).toEqual(days(7));
  });

  it('labels a single value, and nothing when there are none', () => {
    expect(evenTicks(['2026-11-24'], 6)).toEqual(['2026-11-24']);
    expect(evenTicks([], 6)).toEqual([]);
  });

  it('labels only the last value when there is room for one or none', () => {
    expect(evenTicks(days(30), 1)).toEqual([29]);
    expect(evenTicks(days(30), 0)).toEqual([29]);
  });
});

describe('maxTickLabels', () => {
  it('uses a fixed count before the chart is measured', () => {
    expect(maxTickLabels(null, 52)).toBe(6);
  });

  it('fits as many label slots as the plot is wide, at least one', () => {
    expect(maxTickLabels(520, 52)).toBe(10);
    expect(maxTickLabels(519, 52)).toBe(9);
    expect(maxTickLabels(300, 28)).toBe(10);
    expect(maxTickLabels(20, 52)).toBe(1);
    expect(maxTickLabels(0, 52)).toBe(1);
  });
});
