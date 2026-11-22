import { describe, expect, it } from 'vitest';
import { stackedOrder } from './stacked-columns';

const items = [
  { key: 'playtime', column: 'left' as const },
  { key: 'bank', column: 'right' as const },
  { key: 'xp', column: 'left' as const },
  { key: 'loot', column: 'right' as const },
];
const keys = (list: readonly { key: string }[]) => list.map((item) => item.key);

describe('stackedOrder', () => {
  it('keeps the given order in one column', () => {
    const order = stackedOrder(items, false);
    if (!Array.isArray(order)) throw new Error('expected one column');
    expect(keys(order)).toEqual(['playtime', 'bank', 'xp', 'loot']);
  });

  it('splits into a left and a right column, each in the given order', () => {
    const order = stackedOrder(items, true);
    if (Array.isArray(order)) throw new Error('expected two columns');
    expect(keys(order.left)).toEqual(['playtime', 'xp']);
    expect(keys(order.right)).toEqual(['bank', 'loot']);
  });

  it('leaves a column shorter, or empty, when items are missing', () => {
    const order = stackedOrder(
      items.filter((item) => item.column === 'left'),
      true,
    );
    if (Array.isArray(order)) throw new Error('expected two columns');
    expect(order.right).toEqual([]);
  });
});
