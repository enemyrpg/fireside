import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRng } from './rng.js';
import { MonotonicUuidV7 } from './uuid.js';

const uuidV7 = z.uuid({ version: 'v7' });

describe('MonotonicUuidV7', () => {
  it('makes valid, strictly increasing IDs within one millisecond', () => {
    const ids = new MonotonicUuidV7(createRng(1));
    const ms = Date.parse('2026-11-08T19:42:13.512Z');
    const made = Array.from({ length: 1000 }, () => ids.next(ms));
    for (const id of made) expect(uuidV7.safeParse(id).success).toBe(true);
    for (let i = 1; i < made.length; i++) expect((made[i] ?? '') > (made[i - 1] ?? '')).toBe(true);
  });

  it('puts the timestamp in the first 48 bits', () => {
    const ms = Date.parse('2026-11-08T19:42:13.512Z');
    const id = new MonotonicUuidV7(createRng(1)).next(ms);
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(ms);
  });

  it('is strictly increasing across milliseconds and deterministic', () => {
    const make = () => {
      const ids = new MonotonicUuidV7(createRng(42));
      return [0, 0, 1, 1, 1, 5, 1000].map((offset) => ids.next(1_700_000_000_000 + offset));
    };
    const first = make();
    expect(make()).toEqual(first);
    expect([...first].sort()).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('refuses time going backwards', () => {
    const ids = new MonotonicUuidV7(createRng(1));
    ids.next(2_000);
    expect(() => ids.next(1_999)).toThrow(RangeError);
  });
});
