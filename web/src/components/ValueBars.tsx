import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltipBox } from '@/components/ChartTooltipBox';
import { TooltipRow } from '@/components/TooltipRow';
import { formatCompact } from '@/format';
import { CHART_BAND_CURSOR } from '@/lib/chart';

// One value per period as bars: a single series in `--active` with a rounded
// top and a compact y axis from 0. Not `StackedBars`, which is for active/AFK
// play time.

export interface ValueBar {
  /** Unique key, e.g. the month (`2026-11`). */
  key: string;
  /** Short x-axis label (`Nov`). */
  label: string;
  /** Heading in the tooltip (`Nov 2026`). */
  title: string;
  value: number;
}

export interface ValueBarsProps {
  bars: readonly ValueBar[];
  /** Accessible name, e.g. "Your share per month". */
  label: string;
  /** Name of the value in the tooltip, e.g. "Your share". */
  valueLabel: string;
  /** The value as text in the tooltip. */
  formatValue: (value: number) => string;
  height?: number;
}

const AXIS_TICK = { fill: 'var(--text-3)', fontSize: 11 };

export function ValueBars({ bars, label, valueLabel, formatValue, height = 160 }: ValueBarsProps) {
  // An axis from 0 to at least 1, so a chart of zeros still has one.
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <div role="img" aria-label={label} style={{ height }} className="tabular-nums">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          accessibilityLayer={false}
          data={[...bars]}
          margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
          barCategoryGap="30%"
        >
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: 'var(--grid)' }}
            minTickGap={8}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[0, max === 1 ? 1 : 'auto']}
            tickFormatter={formatCompact}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={52}
          />
          <Tooltip
            cursor={CHART_BAND_CURSOR}
            isAnimationActive={false}
            content={({ active, payload }) => {
              // Recharts gives the whole data row for the hovered bar.
              const bar = payload[0]?.payload as ValueBar | undefined;
              if (!active || !bar) return null;
              return (
                <ChartTooltipBox title={bar.title}>
                  <TooltipRow label={valueLabel} value={formatValue(bar.value)} strong />
                </ChartTooltipBox>
              );
            }}
          />
          <Bar
            dataKey="value"
            fill="var(--active)"
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
