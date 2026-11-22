import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AccountDot } from '@/components/shell/AccountDot';
import { formatDuration, formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import type { ShortRun } from '@/lib/session-groups';
import { cn } from '@/lib/utils';

// Consecutive short sessions folded into one row: "3 short sessions · no XP or
// kills", the time span and the summed duration, with a dashed border. Unfolds
// to the rows.

export function ShortSessionsRow({
  run,
  colorOf,
  nameOf,
  selected,
  children,
}: {
  run: ShortRun;
  /** Colour of an account's dot (one per account in the run, for `all`). */
  colorOf: (accountId: number) => string;
  /** Name of an account, for the row's accessible text. */
  nameOf: (accountId: number) => string;
  /** Holds the selected session: starts unfolded, so the selected row shows. */
  selected: boolean;
  /** The rows of the run (`SessionRow`s), shown when unfolded. */
  children: ReactNode;
}) {
  const format = useFormat();
  const [open, setOpen] = useState(selected);
  // Opens by itself when the selected session moves into the run (Older/Newer).
  const [wasSelected, setWasSelected] = useState(selected);
  if (selected !== wasSelected) {
    setWasSelected(selected);
    if (selected) setOpen(true);
  }
  const count = run.groups.length;
  const rowsId = `short-${run.key}`;
  const span = `${format.clock(run.startedAt)}–${format.clock(run.endedAt)}`;
  // One accessible text for the row; the dots say which accounts only by colour.
  const accounts = run.accountIds.map(nameOf).join(', ');
  const label = `${formatInt(count)} short sessions · ${accounts} · ${span}`;

  return (
    <li className="mb-2 list-none">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={rowsId}
        aria-label={label}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl border border-dashed border-border-strong bg-transparent px-4 py-3 text-left text-text hover:border-accent focus-visible:outline-2 focus-visible:outline-accent @min-[500px]/list:grid-cols-[auto_100px_minmax(0,1fr)_auto_24px] @min-[500px]/list:gap-x-3.5"
      >
        <span className="flex gap-1" aria-hidden="true">
          {run.accountIds.map((accountId) => (
            <AccountDot key={accountId} color={colorOf(accountId)} />
          ))}
        </span>
        <span className="hidden font-mono text-sm whitespace-nowrap text-text-2 tabular-nums @min-[500px]/list:block">
          {span}
        </span>
        <span className="min-w-0 truncate text-text-2">
          {formatInt(count)} short sessions
          <span className="text-text-3"> · no XP or kills</span>
          <span className="text-text-3 @min-[500px]/list:hidden"> · {span}</span>
        </span>
        <span className="font-semibold whitespace-nowrap tabular-nums">
          {formatDuration(run.durationSeconds)}
        </span>
        <span className="hidden place-items-center text-text-2 @min-[500px]/list:grid">
          {open ? (
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          ) : (
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          )}
        </span>
      </button>
      {open && (
        <ul
          id={rowsId}
          aria-label={`${formatInt(count)} short sessions`}
          className={cn('m-0 mt-2 list-none p-0 pl-4 @min-[500px]/list:pl-6')}
        >
          {children}
        </ul>
      )}
    </li>
  );
}
