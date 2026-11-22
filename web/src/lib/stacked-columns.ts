// The order of `StackedColumns`.

/** The items in the order they are read: left column, then right; or as given in one column. */
export function stackedOrder<T extends { column: 'left' | 'right' }>(
  items: readonly T[],
  wide: boolean,
): { left: T[]; right: T[] } | T[] {
  if (!wide) return [...items];
  return {
    left: items.filter((item) => item.column === 'left'),
    right: items.filter((item) => item.column === 'right'),
  };
}
