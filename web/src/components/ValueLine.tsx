import type { ReactNode } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartTooltipBox } from '@/components/ChartTooltipBox';
import { formatAxisDate, formatCompact } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useElementWidth } from '@/hooks/useElementWidth';
import {
  CHART_CURSOR,
  DATE_LABEL_WIDTH,
  evenTicks,
  maxTickLabels,
  seriesLineProps,
  valueDomain,
} from '@/lib/chart';

export interface ValueLineProps<T> {
  /** One point per local day, oldest first. */
  points: readonly T[];
  /** Local date of a point (`2026-11-09`). */
  dateOf: (point: T) => string;
  valueOf: (point: T) => number;
  /** Rows of the tooltip, under the date (`TooltipRow`). */
  tooltip: (point: T) => ReactNode;
  /** Accessible name, e.g. "Net worth over time, last 30 days". */
  label: string;
  height?: number;
}

const AXIS_TICK = { fill: 'var(--text-3)', fontSize: 11 };
const Y_AXIS_WIDTH = 52;
// 20 px on the right leaves room for half of the last date label.
const MARGIN = { top: 8, right: 20, bottom: 0, left: 0 };

interface Row<T> {
  date: string;
  value: number;
  point: T;
}

/**
 * A value over time: one series in `--active`, a compact y axis, a crosshair
 * and a tooltip with rows. Colours come only from theme variables. `XpLine` is
 * built on it. X labels at one step counted back from today (`evenTicks`), as
 * many as fit the measured width.
 */
export function ValueLine<T>({
  points,
  dateOf,
  valueOf,
  tooltip,
  label,
  height = 240,
}: ValueLineProps<T>) {
  const format = useFormat();
  const { attach, width } = useElementWidth();
  const rows: Row<T>[] = points.map((point) => ({
    date: dateOf(point),
    value: valueOf(point),
    point,
  }));
  const plotWidth = width === null ? null : width - Y_AXIS_WIDTH - MARGIN.left - MARGIN.right;
  const xTicks = evenTicks(
    rows.map((row) => row.date),
    maxTickLabels(plotWidth, DATE_LABEL_WIDTH),
  );
  return (
    <div ref={attach} role="img" aria-label={label} style={{ height }} className="tabular-nums">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart accessibilityLayer={false} data={rows} margin={MARGIN}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="date"
            tickFormatter={formatAxisDate}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: 'var(--grid)' }}
            ticks={xTicks}
            interval={0}
          />
          <YAxis
            dataKey="value"
            domain={valueDomain(rows.map((row) => row.value))}
            tickFormatter={formatCompact}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={Y_AXIS_WIDTH}
          />
          <Tooltip
            cursor={CHART_CURSOR}
            isAnimationActive={false}
            content={({ active, payload }) => {
              // Recharts gives the whole data row for the hovered point.
              const row = payload[0]?.payload as Row<T> | undefined;
              if (!active || !row) return null;
              return (
                <ChartTooltipBox title={format.localDate(row.date)}>
                  {tooltip(row.point)}
                </ChartTooltipBox>
              );
            }}
          />
          <Line dataKey="value" {...seriesLineProps(rows.length)} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
