import { scrollRegionProps, useScrollsSideways } from '@/hooks/useScrollsSideways';
import type { CalendarDay } from '@fireside/shared';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDuration, formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { calendarGrid, daysPlayedLabel } from '@/lib/calendar';
import { HEAT_STEPS, heatStep } from '@/lib/heat';

// Activity calendar for the last year: week columns, Monday first, 14 px
// squares with 4 px between them on the heat scale. Like the hour heatmap, the
// grid is one image for screen readers and the cells are not tab stops; each
// cell has a tooltip on hover.

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'] as const;

export interface ActivityCalendarProps {
  /** Today's local date: the last day shown. */
  today: string;
  /** Days with play time (from `calendar`). */
  days: readonly CalendarDay[];
}

export function ActivityCalendar({ today, days }: ActivityCalendarProps) {
  const format = useFormat();
  // 371 cells: built again only when the data or the date changes, not on every poll.
  const { weeks, monthLabels } = useMemo(() => calendarGrid(today, days), [today, days]);
  const max = useMemo(() => Math.max(0, ...days.map((day) => day.playedSeconds)), [days]);
  const scroller = useRef<HTMLDivElement>(null);
  // Scrolling sideways (a phone): the box is a tab stop, so a keyboard can scroll it.
  const { ref: scrollRef, scrollable } = useScrollsSideways();

  // On narrow screens the calendar scrolls sideways: start at the newest week.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, []);

  return (
    <div>
      <div
        ref={(element) => {
          scroller.current = element;
          scrollRef(element);
        }}
        className="overflow-x-auto pb-1"
        {...scrollRegionProps(scrollable, 'Activity calendar')}
      >
        <div
          role="img"
          aria-label={`Activity calendar. ${daysPlayedLabel(days.length)}.`}
          className="mx-auto grid w-max grid-cols-[30px_auto] gap-x-1.5 text-axis leading-[14px] text-text-3"
        >
          <div className="sticky left-0 z-10 bg-card" />
          <div className="grid h-5 auto-cols-[14px] grid-flow-col gap-1 whitespace-nowrap">
            {monthLabels.map((label, index) => (
              // Labels overflow their 14 px column to the right.
              <span key={index} className="overflow-visible">
                {label}
              </span>
            ))}
          </div>
          {/* Stays in view while the weeks scroll sideways on narrow screens. */}
          <div className="sticky left-0 z-10 grid grid-rows-[repeat(7,14px)] gap-1 bg-card">
            {WEEKDAY_LABELS.map((label, index) => (
              <span key={index}>{label}</span>
            ))}
          </div>
          <div className="grid grid-flow-col grid-rows-[repeat(7,14px)] auto-cols-[14px] gap-1">
            {weeks.flat().map((cell) => {
              if (!cell.inRange) return <div key={cell.date} />;
              const value = cell.day?.playedSeconds ?? 0;
              return (
                <Tooltip key={cell.date}>
                  <TooltipTrigger asChild>
                    <div
                      className="rounded-[3px]"
                      style={{ background: `var(--heat-${String(heatStep(value, max))})` }}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="font-semibold">{format.localDate(cell.date)}</div>
                    <div className="tabular-nums">
                      {cell.day === null
                        ? 'No play time'
                        : `${formatDuration(value)} · ${formatInt(cell.day.sessionCount)} ${cell.day.sessionCount === 1 ? 'session' : 'sessions'}`}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>
      <div
        aria-hidden="true"
        className="mt-4 flex items-center justify-center gap-[5px] text-axis text-text-3"
      >
        Less
        {Array.from({ length: HEAT_STEPS }, (_, index) => (
          <i
            key={index}
            className="inline-block size-3 rounded-[3px]"
            style={{ background: `var(--heat-${String(index + 1)})` }}
          />
        ))}
        More
      </div>
    </div>
  );
}
