import { useState } from 'react';
import { ROWS_SHOWN, shownRows } from '@/lib/show-all';

/**
 * The six-row rule as state. Starts folded again when `resetKey` changes (new
 * session, week, period or account), also when the component is reused for the
 * new data instead of remounted.
 */
export function useShowAll<T>(rows: readonly T[], limit: number = ROWS_SHOWN, resetKey = '') {
  // The key the list was unfolded for; any other key means folded.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expanded = expandedFor === resetKey;
  const shown = shownRows(rows, expanded, limit);
  return {
    ...shown,
    expanded,
    total: rows.length,
    toggle: () => {
      setExpandedFor(expanded ? null : resetKey);
    },
  };
}
