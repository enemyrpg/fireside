// Seeded random numbers for the seed generator. The same seed always gives
// the same sequence, so a seed run is fully reproducible.

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Picks an item with probability proportional to its weight. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  /** Fisher–Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /**
   * An independent generator derived from this one's seed and `label`. Does
   * not advance this generator, so adding a fork never changes other streams.
   */
  fork(label: string): Rng;
}

/** 32-bit FNV-1a hash of a string. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast and good enough for simulated data. */
export function createRng(seed: number): Rng {
  const initial = seed >>> 0;
  let state = initial;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new RangeError('pick from an empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    weighted: (entries) => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      if (!(total > 0)) throw new RangeError('weighted pick needs a positive total weight');
      let roll = next() * total;
      for (const [item, weight] of entries) {
        roll -= weight;
        if (roll < 0) return item;
      }
      // Only reached through float rounding: use the last entry.
      const last = entries.at(-1);
      if (!last) throw new RangeError('weighted pick from an empty list');
      return last[0];
    },
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j] as (typeof copy)[number], copy[i] as (typeof copy)[number]];
      }
      return copy;
    },
    fork: (label) =>
      createRng(Math.imul(initial ^ hashString(label), 0x9e3779b1) ^ hashString(label)),
  };
  return rng;
}
