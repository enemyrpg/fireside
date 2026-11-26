import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDuration } from '@/format';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { useFormat } from '@/hooks/useFormat';
import type { WeekDayBar } from '@/lib/overview';
import { cn } from '@/lib/utils';

// Play time per day of the week, Monday to Sunday, beside "This week" on Home.
// One image for screen readers; each day has a tooltip. A day without play is a
// 3 px stub: in `--border-strong` when it has passed, fainter (`--heat-0`) when
// it is still to come.

const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** Tallest bar: 60 px with the letters under it on PC, 48 px on mobile. */
const MAX_BAR_PX = { letters: 60, compact: 48 } as const;
const STUB_PX = 3;
/** The bars' box, the same while they load (`WeekDayBarsPlaceholder`). */
const WEEK_DAY_BARS_BOX = { letters: 'h-[84px] w-full', compact: 'h-12 w-24' } as const;

function weekDayBarsLabel(bars: readonly WeekDayBar[]): string {
  const played = bars
    .map((bar, index) => ({ name: WEEKDAY_NAMES[index] ?? '', seconds: totalOf(bar) }))
    .filter((day) => day.seconds > 0)
    .map((day) => `${day.name} ${formatDuration(day.seconds)}`);
  return played.length === 0
    ? 'Play time per day this week: none yet'
    : `Play time per day this week: ${played.join(', ')}`;
}

const totalOf = (bar: WeekDayBar) => bar.activeSeconds + bar.afkSeconds;

export function WeekDayBars({
  bars,
  compact = false,
  className,
}: {
  bars: readonly WeekDayBar[];
  /** Mobile: 96 × 48 px without the letters. */
  compact?: boolean;
  className?: string;
}) {
  const format = useFormat();
  const max = Math.max(1, ...bars.map(totalOf));
  const maxPx = compact ? MAX_BAR_PX.compact : MAX_BAR_PX.letters;
  return (
    <div
      role="img"
      aria-label={weekDayBarsLabel(bars)}
      className={cn(
        'grid grid-cols-7 items-end',
        compact ? cn(WEEK_DAY_BARS_BOX.compact, 'gap-1') : cn(WEEK_DAY_BARS_BOX.letters, 'gap-2'),
        className,
      )}
    >
      {bars.map((bar) => {
        const total = totalOf(bar);
        const height = total === 0 ? STUB_PX : Math.max(STUB_PX, (total / max) * maxPx);
        return (
          <Tooltip key={bar.date}>
            <TooltipTrigger asChild>
              <div
                data-testid="week-day-bar"
                className="flex h-full min-w-0 flex-col items-center justify-end gap-1.5"
              >
                <div
                  className={cn(
                    'w-full',
                    total > 0
                      ? cn('bg-active', compact ? 'rounded-[3px]' : 'rounded-[4px]')
                      : cn('rounded-[2px]', bar.future ? 'bg-(--heat-0)' : 'bg-border-strong'),
                  )}
                  style={{ height }}
                />
                {!compact && (
                  <span
                    className={cn(
                      'text-axis leading-none',
                      bar.today ? 'font-semibold text-text' : 'text-text-3',
                    )}
                  >
                    {bar.letter}
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <div className="font-semibold">{format.localDate(bar.date)}</div>
              {total === 0 ? (
                <div>{bar.future ? 'Still to come' : 'No play time'}</div>
              ) : (
                <>
                  <div className="tabular-nums">Active {formatDuration(bar.activeSeconds)}</div>
                  <div className="tabular-nums">AFK {formatDuration(bar.afkSeconds)}</div>
                </>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * The bars' box while their play time loads: the same size from the first
 * frame, with a skeleton after 200 ms.
 */
export function WeekDayBarsPlaceholder({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const shown = useDelayedFlag(true);
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      data-testid="week-day-bars-placeholder"
      className={cn(compact ? WEEK_DAY_BARS_BOX.compact : WEEK_DAY_BARS_BOX.letters, className)}
    >
      <Skeleton className={cn('size-full rounded-md', !shown && 'invisible')} />
    </div>
  );
}
