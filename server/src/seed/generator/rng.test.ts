import { describe, expect, it } from 'vitest';
import { createRng } from './rng.js';

describe('createRng', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = createRng(5);
    const b = createRng(5);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });

  it('forks independent streams without advancing the parent', () => {
    const a = createRng(5);
    const b = createRng(5);
    const fork = a.fork('x');
    expect(a.next()).toBe(b.next());
    expect(fork.next()).toBe(createRng(5).fork('x').next());
    expect(createRng(5).fork('x').next()).not.toBe(createRng(5).fork('y').next());
  });

  it('keeps ints, picks and weights in range', () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const value = rng.int(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      expect(
        rng.weighted([
          ['a', 0],
          ['b', 1],
        ] as const),
      ).toBe('b');
    }
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});
