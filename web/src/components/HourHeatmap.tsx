import type { HeatmapCell } from '@fireside/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDuration } from '@/format';
import {
  HEAT_STEPS,
  HEATMAP_LAYOUTS,
  heatmapSummary,
  type HeatmapLayout,
  heatStep,
  hourLabel,
  twoHourBlocks,
  WEEKDAYS,
} from '@/lib/heat';
import { cn } from '@/lib/utils';

// Play time per weekday × hour of day, Monday first, in the server's time zone. Cells show
// their time on hover. The grid is one image for screen readers; its summary names the
// same day and hour (or two-hour block) as the numbers above it (`heatmapSummary`). 168
// tab stops would be worse than none.
//
// Fixed cells that are never stretched or clipped. PC: 24 hours of 16 px with 3 px
// between them. Mobile: 12 two-hour blocks of 18 px with 3 px between them (282 px, fits
// 360 px phones).

export interface HourHeatmapProps {
  /** Cells with play time; missing cells are empty. */
  cells: readonly HeatmapCell[];
  /** `hours` on PC, `twoHours` on mobile. */
  layout?: HeatmapLayout;
}

export function HourHeatmap({ cells, layout = 'hours' }: HourHeatmapProps) {
  const spec = HEATMAP_LAYOUTS[layout];
  const shown = layout === 'twoHours' ? twoHourBlocks(cells) : cells;
  const seconds = new Map<number, number>();
  for (const cell of shown) seconds.set(cell.weekday * 100 + cell.hour, cell.seconds);
  const max = Math.max(0, ...shown.map((cell) => cell.seconds));
  const hours = Array.from({ length: spec.columns }, (_, index) => index * spec.step);
  const template = `${String(spec.label)}px repeat(${String(spec.columns)}, ${String(spec.cell)}px)`;
  const cellSize = { width: spec.cell, height: spec.cell };

  return (
    // Only a last safety net: the card is never narrower than the grid.
    <div className="overflow-x-auto">
      <div
        role="img"
        aria-label={`Play time by weekday and hour${layout === 'twoHours' ? ', in two-hour blocks' : ''}. ${heatmapSummary(cells, spec.step)}`}
        style={{ gridTemplateColumns: template, gap: spec.gap }}
        className="grid w-max text-axis text-text-3 tabular-nums"
      >
        <div />
        {hours.map((hour) => (
          // Labels every 6 hours, allowed to overflow their narrow column.
          <div key={hour} className="overflow-visible whitespace-nowrap">
            {hour % 6 === 0 ? String(hour).padStart(2, '0') : ''}
          </div>
        ))}
        {WEEKDAYS.map((day, index) => {
          const weekday = index + 1;
          return [
            <div key={day} className="self-center leading-3">
              {day}
            </div>,
            ...hours.map((hour) => {
              const value = seconds.get(weekday * 100 + hour) ?? 0;
              return (
                <Tooltip key={`${day}-${String(hour)}`}>
                  <TooltipTrigger asChild>
                    <div
                      className="rounded-[4px]"
                      style={{
                        ...cellSize,
                        background: `var(--heat-${String(heatStep(value, max))})`,
                      }}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="font-semibold tabular-nums">
                      {day} {hourLabel(hour)}–{hourLabel((hour + spec.step) % 24)}
                    </div>
                    <div className="tabular-nums">
                      {value > 0 ? formatDuration(value) : 'No play time'}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}

/** "Less ■■■■■■ More": the heat scale. */
export function HeatScale({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('flex items-center gap-[5px] text-axis text-text-3', className)}
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
  );
}
