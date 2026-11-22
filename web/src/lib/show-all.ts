// The six-row rule: a list the dashboard already has in full shows its first
// six rows, then "Show all (n)", which unfolds in place. Lists fetched page by
// page keep "Load more".

/** Rows shown before "Show all". */
export const ROWS_SHOWN = 6;

export interface ShownRows<T> {
  rows: readonly T[];
  /** Whether there are more rows than the limit, so the button is needed. */
  foldable: boolean;
}

/** The rows to show: all when expanded or few enough, else the first `limit`. */
export function shownRows<T>(
  rows: readonly T[],
  expanded: boolean,
  limit: number = ROWS_SHOWN,
): ShownRows<T> {
  const foldable = rows.length > limit;
  return { rows: foldable && !expanded ? rows.slice(0, limit) : rows, foldable };
}
