// The rows of the Settings lists: on PC an 84 px column for the key prefix or
// invite ID, the name with a line under it, and the action or badge on the right.
// On mobile the first column goes, and the prefix or ID moves into the line under
// the name.

/** The row: `--raised`, radius 10, padding 10 × 14 (12 on mobile). */
export const LIST_ROW =
  'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-[10px] bg-raised px-3 py-2.5 desk:grid-cols-[84px_minmax(0,1fr)_auto] desk:gap-x-3.5 desk:px-3.5';

/** The first column on PC: prefix or ID in mono 12 px. */
export const LIST_ROW_ID = 'hidden truncate font-mono text-xs text-text-3 desk:block';

/** The prefix or ID at the start of the line under the name, on mobile only. */
export const LIST_ROW_ID_INLINE = 'font-mono desk:hidden';

/** The icon button on the right: 36 px on PC, 44 px on mobile, no border. */
export const LIST_ROW_BUTTON = 'size-11 border-transparent text-text-3 desk:size-9';

/** A badge on a row: one step lighter than the row (`--hover`). */
export const LIST_ROW_BADGE = 'bg-hover';
