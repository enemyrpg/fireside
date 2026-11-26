import type { ReactNode } from 'react';
import { TextSkeleton } from '@/components/states';
import { cn } from '@/lib/utils';

// The row of big numbers at the top of a page. Straight on the page background,
// no card, with a line under it. PC: the numbers side by side in Space Grotesk
// 48. Mobile: the first number large (44) and the rest in a row of three under it
// (22).

export interface StatStripItem {
  key: string;
  value: ReactNode;
  /** Text under the number on PC, e.g. "play time · last 30 days". */
  label: ReactNode;
  /** Shorter text on mobile, where three numbers share a row. Default `label`. */
  shortLabel?: ReactNode;
  /** One more line under the label, e.g. a `Delta`. */
  note?: ReactNode;
  /**
   * Unit after the number in smaller type, e.g. "gp": 20 px on PC, 18 px on
   * mobile, `--text-2`. On mobile only the large first number has it.
   */
  unit?: string;
}

const ROW =
  'grid grid-cols-3 gap-x-2.5 gap-y-3.5 border-b border-border px-0.5 pb-[18px] desk:flex desk:flex-wrap desk:items-start desk:gap-x-10 wide:gap-x-14 desk:gap-y-6 desk:px-0 desk:pb-7';

export function StatStrip({
  items,
  label,
  error,
  skeletonCount = 4,
  size = 'page',
  aside,
  loadingAside,
  trailing,
  beside,
  loadingBeside,
  mobileColumns = 3,
  className,
}: {
  /** `undefined` while loading: placeholders of the same size in the same place. */
  items: readonly StatStripItem[] | undefined;
  /** Accessible name of the row, e.g. "Screen time summary". */
  label: string;
  /** Shown instead of the numbers when they couldn't load (`ErrorState`). */
  error?: ReactNode;
  skeletonCount?: number;
  /**
   * `pane`: inside a card (the selected session on Sessions). On PC: 28 px
   * numbers, 12 px labels, 2 px between them and 18 px between numbers, so five
   * fit on one row at 1100 and 1440 px, and no line under it. Always this size,
   * so it doesn't jump between sessions with four and five numbers. Mobile is
   * the same as `page`.
   *
   * `hero`: Home's "This week": 56 px numbers with 56 px between them on PC, a
   * 22 px unit, and 24 px for the small numbers on mobile.
   */
  size?: 'page' | 'pane' | 'hero';
  /**
   * Controls or a note on the right of the numbers on PC (`margin-left: auto`,
   * at the bottom), under them on mobile, e.g. the Raids default Split | FFA.
   * Shown with the numbers only, not while loading or on an error.
   */
  aside?: ReactNode;
  /**
   * In `aside`'s place while the numbers load: a box of its final size (Home's
   * day bars), so nothing moves when they arrive.
   */
  loadingAside?: ReactNode;
  /**
   * Right after the numbers on PC (not pushed to the far right like `aside`),
   * full width under them on mobile: the collection log's progress bar.
   */
  trailing?: ReactNode;
  /**
   * Mobile only: to the right of the large first number, at its bottom (Home's
   * day bars, `MobileHome`). PC has `aside` for the same thing, so pass one of
   * the two (`useIsDesktop`), not both.
   */
  beside?: ReactNode;
  /** In `beside`'s place while the numbers load, like `loadingAside`. */
  loadingBeside?: ReactNode;
  /** Columns of the small numbers on mobile. Default 3. */
  mobileColumns?: 2 | 3;
  className?: string;
}) {
  const pane = size === 'pane';
  const hero = size === 'hero';
  if (error !== undefined && error !== null && error !== false) {
    return (
      <section aria-label={label} className={cn(ROW, 'block desk:block', className)}>
        {error}
      </section>
    );
  }
  const loading = items === undefined;
  // While loading: the same numbers and labels as text placeholders, so the strip
  // has its final height from the first frame (docs/design.md, "Loading").
  const shown: readonly StatStripItem[] =
    items ??
    Array.from({ length: skeletonCount }, (_, index) => ({
      key: `skeleton-${String(index)}`,
      value: (
        <TextSkeleton className={cn('inline-block', index === 0 ? 'w-48' : 'w-20 desk:w-40')} />
      ),
      label: <TextSkeleton className="inline-block w-24 desk:w-32" />,
    }));
  const showBeside = loading ? loadingBeside : beside;
  const showAside = loading ? loadingAside : aside;
  const hasBeside = showBeside !== undefined && showBeside !== null && showBeside !== false;
  return (
    <section
      aria-label={label}
      {...(loading ? { 'aria-busy': true } : {})}
      className={cn(
        ROW,
        mobileColumns === 2 && 'grid-cols-2',
        pane && 'desk:gap-x-[18px] desk:border-b-0 desk:pb-0 wide:gap-x-[18px]',
        hero && 'desk:gap-x-14',
        className,
      )}
    >
      {shown.map((item, index) => {
        const first = index === 0;
        const number = (
          <div
            key={item.key}
            className={cn(
              'flex min-w-0 flex-col',
              first ? 'gap-[3px]' : '',
              first && !hasBeside && 'col-span-full',
              pane ? 'desk:gap-0.5' : 'desk:gap-1',
            )}
          >
            <span
              className={cn(
                'font-display font-semibold whitespace-nowrap tabular-nums',
                first
                  ? 'text-[44px] leading-none tracking-[-0.03em]'
                  : hero
                    ? 'text-[24px] leading-tight'
                    : 'text-[22px] leading-tight',
                pane
                  ? 'desk:text-[28px] desk:leading-tight desk:tracking-[-0.01em]'
                  : hero
                    ? 'desk:text-[56px] desk:leading-none desk:tracking-[-0.03em]'
                    : 'desk:text-[48px] desk:leading-none desk:tracking-[-0.03em]',
              )}
            >
              {item.value}
              {item.unit !== undefined && (
                <span
                  className={cn(
                    'ml-2 text-[18px] desk:ml-2.5 font-semibold tracking-normal text-text-2',
                    hero ? 'desk:text-[22px]' : 'desk:text-[20px]',
                    !first && 'max-desk:hidden',
                  )}
                >
                  {item.unit}
                </span>
              )}
            </span>
            <span className={cn('text-xs text-text-3', !pane && 'desk:text-table')}>
              {item.shortLabel === undefined ? (
                item.label
              ) : (
                <>
                  <span className="desk:hidden">{item.shortLabel}</span>
                  <span className="max-desk:hidden">{item.label}</span>
                </>
              )}
            </span>
            {item.note !== undefined && <span className="text-xs text-text-3">{item.note}</span>}
          </div>
        );
        if (!first || !hasBeside) return number;
        return (
          // On PC the wrapper is not a box, so the number is a flex item like the rest.
          <div
            key={item.key}
            className="col-span-full flex items-end justify-between gap-3 desk:contents"
          >
            {number}
            <div className="flex-none desk:hidden">{showBeside}</div>
          </div>
        );
      })}
      {!loading && trailing !== undefined && trailing !== null && trailing !== false && (
        <div className="col-span-full min-w-0 desk:max-w-80 desk:flex-[1_1_200px] desk:self-end desk:pb-1.5">
          {trailing}
        </div>
      )}
      {showAside !== undefined && showAside !== null && showAside !== false && (
        <div
          data-slot="stat-strip-aside"
          className={cn(
            'col-span-full min-w-0 desk:ml-auto desk:self-end',
            // Home's day bars are 340 px at most, not always: the row counts them as
            // 240 px, so they stay beside the numbers when those are a little wider
            // (they wrapped at 1440 px for being 2 px short), and grow into the room left.
            hero && 'desk:max-w-[340px] desk:flex-[1_1_240px]',
          )}
        >
          {showAside}
        </div>
      )}
    </section>
  );
}
