import type { ReactNode } from 'react';
import { ShowAllButton } from '@/components/ShowAll';
import { Skeleton } from '@/components/ui/skeleton';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { useShowAll } from '@/hooks/useShowAll';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ROWS_SHOWN } from '@/lib/show-all';
import { cn } from '@/lib/utils';

/** Height of a row, shared with `HBarListPlaceholder`. */
const HBAR_ROW_HEIGHT = 'h-[30px]';

export interface HBarRow {
  key: string;
  /** Name in the first column (and the tooltip's heading). */
  label: string;
  value: number;
  /** Bar colour, a CSS colour such as `var(--afk)`. Default `--active`. */
  color?: string;
  /** Extra lines in the tooltip, under the name and the value. */
  detail?: ReactNode;
  /** Placeholder icon before the name (`SkillIcon`, `BossIcon`). */
  icon?: ReactNode;
}

export interface HBarListProps {
  rows: readonly HBarRow[];
  /** Formats the value in the row, e.g. `formatGp`. */
  format: (value: number) => string;
  /** Exact value for the tooltip, e.g. `formatGpExact`. Default `format`. */
  formatExact?: (value: number) => string;
  /** Accessible name of the list. */
  label: string;
  /**
   * Makes every row a button that calls this with the row's `key`, e.g. to
   * choose a bank tab. The chosen row (`selectedKey`) is marked.
   */
  onSelect?: (key: string) => void;
  selectedKey?: string | undefined;
  /**
   * Rows shown before "Show all (n)": six by default. `false` shows every row,
   * for a short list that is a control (bank tabs).
   */
  limit?: number | false;
  /**
   * Folds the list again when it changes (a session or week id). The row keys
   * are always part of it, so new rows fold too.
   */
  resetKey?: string;
  className?: string;
}

/**
 * Name, bar and value per row. The longest bar is the highest value. The first six rows, then
 * "Show all (n)", which unfolds in place (the six-row rule). The longest bar stays the
 * highest value of all rows, folded or not. Each row is focusable and shows its tooltip on
 * hover or focus. With `onSelect` the rows are buttons (`aria-pressed`, the chosen one in
 * `--accent-wash`).
 */
export function HBarList({
  rows,
  format,
  formatExact = format,
  label,
  onSelect,
  selectedKey,
  limit = ROWS_SHOWN,
  resetKey = '',
  className,
}: HBarListProps) {
  const fold = useShowAll(
    rows,
    limit === false ? Infinity : limit,
    `${resetKey}\n${rows.map((row) => row.key).join('\n')}`,
  );
  const max = Math.max(1, ...rows.map((row) => row.value));
  const rowClass = `col-span-3 grid ${HBAR_ROW_HEIGHT} grid-cols-subgrid items-center rounded-sm focus-visible:outline-2 focus-visible:outline-accent`;
  const cells = (row: HBarRow) => (
    <>
      {row.icon === undefined ? (
        <span className="truncate">{row.label}</span>
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          {row.icon}
          <span className="truncate">{row.label}</span>
        </span>
      )}
      <span aria-hidden="true" className="relative h-2.5">
        <span
          className="absolute inset-y-0 left-0 rounded-r"
          style={{
            width: `${String(Math.max(1, (row.value / max) * 100))}%`,
            background: row.color ?? 'var(--active)',
          }}
        />
      </span>
      <span className="text-right whitespace-nowrap tabular-nums">{format(row.value)}</span>
    </>
  );
  return (
    // One grid for the list (rows are subgrids), so the value column has one
    // width that fits the longest value and the bars line up.
    <>
      <ul
        aria-label={label}
        className={cn(
          'm-0 grid list-none grid-cols-[112px_minmax(0,1fr)_auto] gap-x-2.5 p-0 desk:grid-cols-[150px_minmax(0,1fr)_minmax(90px,auto)]',
          className,
        )}
      >
        {fold.rows.map((row) => (
          <li key={row.key} className="col-span-3 grid grid-cols-subgrid">
            <Tooltip>
              <TooltipTrigger asChild>
                {onSelect ? (
                  <button
                    type="button"
                    aria-pressed={row.key === selectedKey}
                    onClick={() => {
                      onSelect(row.key);
                    }}
                    className={cn(
                      rowClass,
                      // The wash reaches 8 px past the text on both sides, like a menu item.
                      '-mx-2 cursor-pointer border-0 px-2 text-left hover:bg-hover',
                      row.key === selectedKey
                        ? 'bg-accent-wash hover:bg-accent-wash'
                        : 'bg-transparent',
                    )}
                  >
                    {cells(row)}
                  </button>
                ) : (
                  <div tabIndex={0} className={cn(rowClass, 'cursor-default')}>
                    {cells(row)}
                  </div>
                )}
              </TooltipTrigger>
              <TooltipContent>
                <div className="font-semibold">{row.label}</div>
                <div className="tabular-nums">{formatExact(row.value)}</div>
                {row.detail}
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
      <ShowAllButton {...fold} />
    </>
  );
}

/**
 * `rows` rows of the list's own height while it loads, so the card has its
 * final size from the first frame; the bars show after 200 ms.
 */
export function HBarListPlaceholder({ rows }: { rows: number }) {
  const shown = useDelayedFlag(true);
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          data-testid="hbar-placeholder-row"
          className={cn(HBAR_ROW_HEIGHT, 'flex items-center')}
        >
          <Skeleton className={cn('h-5 w-full rounded-md', !shown && 'invisible')} />
        </div>
      ))}
    </div>
  );
}
