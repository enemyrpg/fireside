import type { LootSourceGroup } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { parseLootRange, parseMinValue, sourceRows } from './rows';

function group(name: string | null, geValue: number, lootCount = 1): LootSourceGroup {
  return {
    source: name === null ? { type: 'PLAYER', name: null } : { type: 'NPC', name },
    lootCount,
    geValue,
    haValue: 0,
    items: [],
  };
}

describe('sourceRows', () => {
  const groups = Array.from({ length: 11 }, (_, index) =>
    group(`Boss ${String(index + 1)}`, 1000 - index * 10, index + 1),
  );

  it('keeps every source in the API order (no "Other")', () => {
    const rows = sourceRows(groups);
    expect(rows.map((row) => row.label)).toEqual(groups.map((g) => g.source.name));
    expect(rows[10]).toEqual({
      key: 'NPC:Boss 11',
      label: 'Boss 11',
      isNpc: true,
      geValue: 900,
      lootCount: 11,
    });
  });

  it('labels player loot "Player" and keeps it apart from a source named "Player"', () => {
    const rows = sourceRows([
      group(null, 5),
      { ...group('Player', 3), source: { type: 'OTHER', name: 'Player' } },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['Player', 'Player']);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    // Neither is an NPC, so neither asks for a boss icon.
    expect(rows.map((row) => row.isNpc)).toEqual([false, false]);
  });

  it('is empty without groups', () => {
    expect(sourceRows([])).toEqual([]);
  });
});

describe('URL parameters', () => {
  it('defaults to all time and 1M+', () => {
    expect(parseLootRange(null)).toBe('all');
    expect(parseLootRange('90d')).toBe('all');
    expect(parseLootRange('7d')).toBe('7d');
    expect(parseLootRange('30d')).toBe('30d');
    expect(parseMinValue(null)).toBe('1m');
    expect(parseMinValue('5m')).toBe('1m');
    expect(parseMinValue('100k')).toBe('100k');
    expect(parseMinValue('10m')).toBe('10m');
  });
});
