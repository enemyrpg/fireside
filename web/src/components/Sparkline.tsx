import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from 'recharts';
import { ChartTooltipBox } from '@/components/ChartTooltipBox';
import { useFormat } from '@/hooks/useFormat';
import { CHART_CURSOR, seriesLineProps, valueDomain } from '@/lib/chart';
import { SPARKLINE_AREA_HEIGHT, SPARKLINE_HEIGHT } from '@/lib/sparkline';

export interface SparklinePoint {
  /** Local date (`2026-11-09`). */
  date: string;
  value: number;
}

export interface SparklineProps {
  /** One point per local day, oldest first. */
  points: readonly SparklinePoint[];
  /** Accessible name, e.g. "Net worth, last 30 days: 2.41B gp to 2.5B gp". */
  label: string;
  /** Formats the value in the tooltip, e.g. `formatGp`. */
  format: (value: number) => ReactNode;
  /**
   * `line` (default): just the line, 56 px. `area` (Weekly `Bank`, Home): the
   * line with a light fill under it down to a baseline, a dot on the last
   * point, 64 px, and `startLabel`/`endLabel` under it ("Mon", "Today").
   */
  variant?: 'line' | 'area';
  startLabel?: string;
  endLabel?: string;
}

function useTooltip(format: (value: number) => ReactNode) {
  const time = useFormat();
  return (
    <Tooltip
      cursor={CHART_CURSOR}
      isAnimationActive={false}
      content={({ active, payload }) => {
        const point = payload[0]?.payload as SparklinePoint | undefined;
        if (!active || !point) return null;
        return (
          <ChartTooltipBox title={time.localDate(point.date)}>
            <div>{format(point.value)}</div>
          </ChartTooltipBox>
        );
      }}
    />
  );
}

/** A dot on the last point only (the value now). */
function LastDot(props: {
  cx?: number | undefined;
  cy?: number | undefined;
  index?: number | undefined;
  count: number;
}) {
  const { cx, cy, index, count } = props;
  if (cx === undefined || cy === undefined || index !== count - 1) return null;
  return <circle cx={cx} cy={cy} r={4} fill="var(--active)" />;
}

/**
 * A small line without axes: one series in `--active` and a tooltip per point.
 * The trend at a glance; the page behind it has the chart.
 */
export function Sparkline({
  points,
  label,
  format,
  variant = 'line',
  startLabel,
  endLabel,
}: SparklineProps) {
  const tooltip = useTooltip(format);
  const domain = valueDomain(points.map((point) => point.value));

  if (variant === 'area') {
    const count = points.length;
    const values = points.map((point) => point.value);
    const areaDomain: [number, number] =
      domain[0] === 'auto' ? [Math.min(...values), Math.max(...values)] : domain;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div role="img" aria-label={label} style={{ height: SPARKLINE_AREA_HEIGHT }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              accessibilityLayer={false}
              data={[...points]}
              margin={{ top: 6, right: 6, bottom: 0, left: 6 }}
            >
              {/* The lowest value is the baseline the fill goes down to (a flat week keeps its padding). */}
              <YAxis hide dataKey="value" domain={areaDomain} />
              {tooltip}
              <ReferenceLine y={areaDomain[0]} stroke="var(--grid)" />
              <Area
                dataKey="value"
                type="linear"
                stroke="var(--active)"
                strokeWidth={2.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                fill="var(--active)"
                fillOpacity={0.12}
                baseValue={areaDomain[0]}
                isAnimationActive={false}
                dot={(props) => (
                  <LastDot
                    key={String(props.index)}
                    cx={props.cx}
                    cy={props.cy}
                    index={props.index}
                    count={count}
                  />
                )}
                activeDot={{ r: 4, fill: 'var(--active)', stroke: 'none' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        {(startLabel !== undefined || endLabel !== undefined) && (
          <div aria-hidden="true" className="flex justify-between text-axis text-text-3">
            <span>{startLabel}</span>
            <span>{endLabel}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div role="img" aria-label={label} style={{ height: SPARKLINE_HEIGHT }} className="min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          accessibilityLayer={false}
          data={[...points]}
          margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
        >
          <YAxis hide dataKey="value" domain={domain} />
          {tooltip}
          <Line dataKey="value" {...seriesLineProps(points.length)} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
