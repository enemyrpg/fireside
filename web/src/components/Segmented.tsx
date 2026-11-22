import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

// Segmented controls, two looks:
// - `tabs`: links between pages (the sub-tabs next to the page title). The
//   chosen one is filled in `--accent` with `--on-accent` and has `aria-current`.
// - `filter`: buttons for a period, filter or sort on the page. The chosen one
//   is `--accent-wash` with `--accent-text`.
//   Both are 44 px high on mobile. Replaces `SubTabs`' own markup and
//   `PeriodToggle`.

/** Equal columns, so a full-width control on mobile splits evenly. */
function columns(count: number): CSSProperties {
  return { gridTemplateColumns: `repeat(${String(count)}, minmax(0, 1fr))` };
}

export interface SegmentedTab {
  key: string;
  to: string;
  label: string;
  /** Shown instead of `label` on mobile; `label` stays the accessible name. */
  shortLabel?: string;
  current: boolean;
}

/**
 * Links with the chosen one marked. Full width on mobile. `look="tabs"`
 * (default): filled in `--accent`, the sub-tabs next to the page title.
 * `look="filter"`: the filter look (`--accent-wash`, 34 px on PC) for links
 * inside a page, e.g. the Collection log's tabs, which stay links so they can
 * be opened in a new tab.
 */
export function SegmentedTabs({
  tabs,
  label,
  look = 'tabs',
  className,
  itemClassName,
}: {
  tabs: readonly SegmentedTab[];
  /** Accessible name of the `<nav>`, e.g. "Activity views". */
  label: string;
  look?: 'tabs' | 'filter';
  className?: string;
  /** Extra classes for every link, e.g. smaller text on mobile. */
  itemClassName?: string;
}) {
  const filter = look === 'filter';
  return (
    <nav
      aria-label={label}
      style={columns(tabs.length)}
      className={cn(
        'grid w-full rounded-xl border border-border bg-card p-[3px] desk:flex desk:w-auto',
        filter ? 'desk:rounded-[9px]' : 'desk:rounded-[10px]',
        className,
      )}
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          aria-current={tab.current ? 'page' : undefined}
          {...(tab.shortLabel === undefined ? {} : { 'aria-label': tab.label })}
          className={cn(
            'flex h-11 min-w-0 items-center justify-center rounded-[9px] px-2 text-center text-table no-underline hover:no-underline',
            filter
              ? 'desk:h-[34px] desk:rounded-md desk:px-3'
              : 'desk:h-auto desk:rounded-[7px] desk:px-4 desk:py-[7px] desk:text-sm',
            tab.current
              ? filter
                ? 'bg-accent-wash font-semibold text-accent-text hover:text-accent-text'
                : 'bg-accent font-semibold text-on-accent hover:text-on-accent'
              : 'text-text-2 hover:text-text',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
            itemClassName,
          )}
        >
          {tab.shortLabel === undefined ? (
            tab.label
          ) : (
            <>
              <span aria-hidden="true" className="desk:hidden">
                {tab.shortLabel}
              </span>
              <span aria-hidden="true" className="max-desk:hidden">
                {tab.label}
              </span>
            </>
          )}
        </Link>
      ))}
    </nav>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /**
   * Shorter text on mobile, where options share the width equally, e.g.
   * "Default (Split)". The accessible name stays `label` in both layouts.
   */
  shortLabel?: string;
}

export interface SegmentedFilterProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name, e.g. "Period". */
  label: string;
  /**
   * Full width with equal columns on mobile: the page's own controls row and
   * fields in dialogs.
   */
  block?: boolean;
  className?: string;
  /** Extra classes for every option, e.g. a taller button (Collection log tabs, 34 px). */
  itemClassName?: string;
}

/** One choice of a few, the chosen one in `--accent-wash` (period, filter, sort). */
export function SegmentedFilter<T extends string>({
  options,
  value,
  onChange,
  label,
  block = false,
  className,
  itemClassName,
}: SegmentedFilterProps<T>) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(next) => {
        // Radix sends '' when the chosen item is clicked again; keep the choice.
        const option = options.find((item) => item.value === next);
        if (option) onChange(option.value);
      }}
      // `--card` with a border: `--raised` is almost the page colour in the light theme.
      style={block ? columns(options.length) : undefined}
      className={cn(
        'gap-0 rounded-xl border border-border bg-card p-[3px] desk:rounded-[9px]',
        block ? 'grid w-full desk:inline-flex desk:w-auto' : 'inline-flex',
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          {...(option.shortLabel === undefined ? {} : { 'aria-label': option.label })}
          // shadcn squares the corners of grouped items (`data-[spacing=0]:rounded-none`);
          // every option here is a fully rounded box.
          className={cn(
            'h-11 min-w-0 rounded-[9px] border-0 px-3 text-table font-normal text-text-2 desk:h-[30px] desk:rounded-md',
            'data-[spacing=0]:rounded-[9px] data-[spacing=0]:first:rounded-[9px] data-[spacing=0]:last:rounded-[9px]',
            'desk:data-[spacing=0]:rounded-md desk:data-[spacing=0]:first:rounded-md desk:data-[spacing=0]:last:rounded-md',
            'hover:bg-transparent hover:text-text',
            'data-[state=on]:bg-accent-wash data-[state=on]:font-semibold data-[state=on]:text-accent-text',
            'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-accent',
            itemClassName,
          )}
        >
          {option.shortLabel === undefined ? (
            option.label
          ) : (
            <>
              <span aria-hidden="true" className="desk:hidden">
                {option.shortLabel}
              </span>
              <span aria-hidden="true" className="max-desk:hidden">
                {option.label}
              </span>
            </>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
