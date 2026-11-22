import { describe, expect, it } from 'vitest';
import { ROWS_SHOWN, shownRows } from './show-all';

const rows = Array.from({ length: 9 }, (_, index) => index);

describe('shownRows', () => {
  it('shows six rows by default', () => {
    expect(ROWS_SHOWN).toBe(6);
    expect(shownRows(rows, false)).toEqual({ rows: [0, 1, 2, 3, 4, 5], foldable: true });
  });

  it('shows every row when expanded', () => {
    expect(shownRows(rows, true)).toEqual({ rows, foldable: true });
  });

  it('needs no button for six rows or fewer', () => {
    expect(shownRows(rows.slice(0, 6), false)).toEqual({ rows: rows.slice(0, 6), foldable: false });
    expect(shownRows([], false)).toEqual({ rows: [], foldable: false });
  });

  it('takes another limit', () => {
    expect(shownRows(rows, false, 8).rows).toHaveLength(8);
  });
});
