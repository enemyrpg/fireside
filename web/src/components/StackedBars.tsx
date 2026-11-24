import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
} from 'recharts';
import { Tooltip as HoverTip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatAxisHours, formatDuration } from '@/format';
import { useElementWidth } from '@/hooks/useElementWidth';
import {
  CHART_BAND_CURSOR,
  DATE_LABEL_WIDTH,
  SHORT_LABEL_WIDTH,
  evenTicks,
  hourTicks,
  maxTickLabels,
} from '@/lib/chart';
import { cn } from '@/lib/utils';

// Active/AFK play time per period: active at the bottom in `--active`, AFK on
// top in the neutral `--afk`, 2 px between them. Never used with account
// colours.

export interface StackedBar {
  /** Unique key, e.g. the period (`2026-11-09`, `2026-W46`). */
  key: string;
  /** Short x-axis label (`Mon`, `9`, `9 Nov`). */
  label: string;
  /** Heading in the tooltip (`Tue 10 Nov`). */
  title: string;
  activeSeconds: number;
  afkSeconds: number;
}

export interface StackedBarsProps {
  bars: readonly StackedBar[];
  /** Accessible name, e.g. "Active and AFK play time per day, last 30 days". */
  label: string;
  /** `chart` only: the height in px. `compact` is 96 px on PC and 86 on mobile. */
  height?: number;
  /**
   * `chart` (default): axes, gridlines and hour ticks. `compact`: a few wide
   * rounded bars with the labels under them, no axes or gridlines, and a thin
   * stub for an empty period (Weekly, `Weekly`/`MobileWeekly`). On mobile the
   * labels are their first letter (`M`, `T`). Same stacking and tooltips.
   */
  variant?: 'chart' | 'compact';
  /** `chart` only: the labels are dates (`9 Nov`), not weekdays or days of the month. */
  dateLabels?: boolean;
}

const AXIS_TICK = { fill: 'var(--text-3)', fontSize: 11 };
const Y_AXIS_WIDTH = 40;
const MARGIN = { top: 8, right: 4, bottom: 0, left: 0 };
/** Space between the active and AFK segments. */
const GAP = 2;
const RADIUS = 4;

/** A bar segment with rounded top corners (`radius` 0 = square). */
function segmentPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height);
  return [
    `M${String(x)},${String(y + height)}`,
    `V${String(y + r)}`,
    `Q${String(x)},${String(y)} ${String(x + r)},${String(y)}`,
    `H${String(x + width - r)}`,
    `Q${String(x + width)},${String(y)} ${String(x + width)},${String(y + r)}`,
    `V${String(y + height)}`,
    'Z',
  ].join(' ');
}

function barOf(props: BarShapeProps): StackedBar {
  // Recharts passes the whole data row as `payload`.
  return props.payload as StackedBar;
}

function ActiveShape(props: BarShapeProps) {
  const { x, y, width, height } = props;
  if (height <= 0 || width <= 0) return null;
  // Square top when AFK sits on it.
  const radius = barOf(props).afkSeconds > 0 ? 0 : RADIUS;
  return <path d={segmentPath(x, y, width, height, radius)} fill="var(--active)" />;
}

function AfkShape(props: BarShapeProps) {
  const { x, y, width, height } = props;
  if (barOf(props).afkSeconds <= 0 || width <= 0) return null;
  // Moved up by the gap (not shrunk), so AFK keeps its true height. At least
  // 1 px, so a few AFK minutes on a long day still show.
  const gap = barOf(props).activeSeconds > 0 ? GAP : 0;
  const shown = Math.max(1, height);
  return (
    <path d={segmentPath(x, y + height - shown - gap, width, shown, RADIUS)} fill="var(--afk)" />
  );
}

/** Day, active, AFK and total: the lines of a bar's tooltip. */
function BarsTooltipBody({ bar }: { bar: StackedBar }) {
  const row = (color: string | undefined, name: string, seconds: number, bold = false) => (
    <div className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5 text-text-2">
        {color && (
          <i aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: color }} />
        )}
        {name}
      </span>
      <span className={cn(bold && 'font-semibold')}>{formatDuration(seconds)}</span>
    </div>
  );
  return (
    <div className="text-xs whitespace-nowrap tabular-nums">
      <div className="mb-1 font-semibold">{bar.title}</div>
      {row('var(--active)', 'Active', bar.activeSeconds)}
      {row('var(--afk)', 'AFK', bar.afkSeconds)}
      {row(undefined, 'Total', bar.activeSeconds + bar.afkSeconds, true)}
    </div>
  );
}

function BarsTooltip({ bar }: { bar: StackedBar | undefined }) {
  if (!bar) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-2.5 py-2 shadow-menu">
      <BarsTooltipBody bar={bar} />
    </div>
  );
}

/** Height of a bar as a percentage of the tallest (at least a sliver when there is play). */
function barPercent(bar: StackedBar, max: number): number {
  const total = bar.activeSeconds + bar.afkSeconds;
  return max > 0 ? (total / max) * 100 : 0;
}

/** The compact bars (`variant="compact"`), plain HTML. */
function CompactBars({ bars, label }: { bars: readonly StackedBar[]; label: string }) {
  const max = Math.max(0, ...bars.map((bar) => bar.activeSeconds + bar.afkSeconds));
  return (
    <div
      role="img"
      aria-label={label}
      className="grid h-[86px] items-end gap-2 desk:h-24"
      style={{ gridTemplateColumns: `repeat(${String(bars.length)}, minmax(0, 1fr))` }}
    >
      {bars.map((bar) => {
        const total = bar.activeSeconds + bar.afkSeconds;
        return (
          <div key={bar.key} className="flex h-full min-w-0 flex-col items-stretch gap-1.5">
            <div className="flex min-h-0 flex-1 flex-col justify-end">
              {total === 0 ? (
                // A day without play: a thin stub on the baseline.
                <div className="h-[3px] rounded-[4px] bg-grid" />
              ) : (
                <HoverTip>
                  <TooltipTrigger asChild>
                    <div
                      className="flex flex-col gap-0.5"
                      style={{ height: `${String(barPercent(bar, max))}%`, minHeight: 3 }}
                    >
                      {bar.afkSeconds > 0 && (
                        <div
                          className={cn(
                            'min-h-px rounded-t-[4px] bg-afk',
                            bar.activeSeconds === 0 && 'rounded-b-[4px]',
                          )}
                          style={{ flex: bar.afkSeconds }}
                        />
                      )}
                      {bar.activeSeconds > 0 && (
                        <div
                          className={cn(
                            'min-h-px rounded-b-[4px] bg-active',
                            bar.afkSeconds === 0 && 'rounded-t-[4px]',
                          )}
                          style={{ flex: bar.activeSeconds }}
                        />
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <BarsTooltipBody bar={bar} />
                  </TooltipContent>
                </HoverTip>
              )}
            </div>
            <span className="text-center text-axis leading-none text-text-3" aria-hidden="true">
              <span className="max-desk:hidden">{bar.label}</span>
              <span className="desk:hidden">{bar.label.slice(0, 1)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Stacked active/AFK bars with whole-hour ticks and a tooltip per bar. */
export function StackedBars({ variant = 'chart', ...props }: StackedBarsProps) {
  if (variant === 'compact') return <CompactBars bars={props.bars} label={props.label} />;
  return <ChartBars {...props} />;
}

/**
 * The `chart` variant. X labels at one step counted back from the last bar
 * (`evenTicks`), as many as fit the measured width. The axis is keyed by `key`,
 * so two bars with the same label (`1` twice in a 30-day range over February)
 * are still two ticks.
 */
function ChartBars({ bars, label, height = 220, dateLabels = false }: StackedBarsProps) {
  const { attach, width } = useElementWidth();
  const max = Math.max(0, ...bars.map((bar) => bar.activeSeconds + bar.afkSeconds));
  const ticks = hourTicks(max);
  const plotWidth = width === null ? null : width - Y_AXIS_WIDTH - MARGIN.left - MARGIN.right;
  const xTicks = evenTicks(
    bars.map((bar) => bar.key),
    maxTickLabels(plotWidth, dateLabels ? DATE_LABEL_WIDTH : SHORT_LABEL_WIDTH),
  );
  const labelOf = new Map(bars.map((bar) => [bar.key, bar.label]));
  return (
    <div ref={attach} role="img" aria-label={label} style={{ height }} className="tabular-nums">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart accessibilityLayer={false} data={bars} margin={MARGIN} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="key"
            ticks={xTicks}
            interval={0}
            tickFormatter={(key: string) => labelOf.get(key) ?? key}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: 'var(--grid)' }}
          />
          <YAxis
            domain={[0, ticks[ticks.length - 1] ?? 0]}
            ticks={ticks}
            tickFormatter={(seconds: number) => formatAxisHours(seconds / 3600)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={Y_AXIS_WIDTH}
          />
          <Tooltip
            cursor={CHART_BAND_CURSOR}
            isAnimationActive={false}
            content={({ active, payload }) =>
              active ? <BarsTooltip bar={payload[0]?.payload as StackedBar | undefined} /> : null
            }
          />
          <Bar
            dataKey="activeSeconds"
            stackId="time"
            maxBarSize={28}
            shape={ActiveShape}
            isAnimationActive={false}
          />
          <Bar
            dataKey="afkSeconds"
            stackId="time"
            maxBarSize={28}
            shape={AfkShape}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Legend for the bars, for the card header. */
export function StackedBarsLegend({ className }: { className?: string }) {
  const item = 'inline-flex items-center gap-1.5';
  return (
    <div className={cn('flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-text-2', className)}>
      <span className={item}>
        <i aria-hidden="true" className="size-2.5 rounded-[3px] bg-active" />
        Active
      </span>
      <span className={item}>
        <i aria-hidden="true" className="size-2.5 rounded-[3px] bg-afk" />
        AFK
      </span>
    </div>
  );
}
