import type { LootSourceGroup } from '@fireside/shared';
import { sourceLabel } from '@/lib/loot';

// Loot tab helpers (2.1 "Loot & KC").

// --- Range of the totals and "By source" ------------------------------------------

export const LOOT_RANGES = ['7d', '30d', 'all'] as const;
export type LootRange = (typeof LOOT_RANGES)[number];

export const DEFAULT_LOOT_RANGE: LootRange = 'all';

/** Local days in a range (today included). `null` = all time. */
export const RANGE_DAYS: Record<LootRange, number | null> = { '7d': 7, '30d': 30, all: null };

export function parseLootRange(value: string | null): LootRange {
  return LOOT_RANGES.find((range) => range === value) ?? DEFAULT_LOOT_RANGE;
}

// --- Valuable drops filter ------------------------------------------------------------

export const MIN_VALUES = ['100k', '1m', '10m'] as const;
export type MinValueKey = (typeof MIN_VALUES)[number];

export const DEFAULT_MIN_VALUE: MinValueKey = '1m';

export const MIN_VALUE_GP: Record<MinValueKey, number> = {
  '100k': 100_000,
  '1m': 1_000_000,
  '10m': 10_000_000,
};

export function parseMinValue(value: string | null): MinValueKey {
  return MIN_VALUES.find((key) => key === value) ?? DEFAULT_MIN_VALUE;
}

// --- By source ----------------------------------------------------------------------

export interface SourceRow {
  key: string;
  label: string;
  /** Only NPCs can have a boss icon; the others get initials without a request. */
  isNpc: boolean;
  geValue: number;
  lootCount: number;
}

/**
 * Every group as it comes from the API (highest value first). `HBarList`
 * shows six, then "Show all (n)" (no "Other" row).
 */
export function sourceRows(groups: readonly LootSourceGroup[]): SourceRow[] {
  return groups.map((group) => ({
    key: `${group.source.type}:${group.source.name ?? ''}`,
    label: sourceLabel(group.source),
    isNpc: group.source.type === 'NPC',
    geValue: group.geValue,
    lootCount: group.lootCount,
  }));
}
