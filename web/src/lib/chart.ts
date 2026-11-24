// Small helpers for the Recharts charts.

/**
 * Y range of a line chart. Recharts picks even steps itself (`auto`), but a
 * flat line (nothing changed in the period) would give five equal ticks, so it
 * gets a small range around its value instead: ±1%, at least ±10, never below 0.
 */
export function valueDomain(values: readonly number[]): [number, number] | ['auto', 'auto'] {
  const min = Math.min(...values);
  if (values.length === 0 || min !== Math.max(...values)) return ['auto', 'auto'];
  const pad = Math.max(10, Math.round(min * 0.01));
  return [Math.max(0, min - pad), min + pad];
}

// X labels (docs/design.md, "Chart axes"). Recharts would drop labels by their
// measured text width, which leaves uneven gaps; these pick them at one step.

/**
 * Room per x label at 11 px Inter, in px: the widest label plus space between
 * two labels. Dates: `30 Sept` is about 41 px. Short labels: `Mon` is about
 * 24 px and a day of the month (`30`) about 14 px.
 */
export const DATE_LABEL_WIDTH = 52;
export const SHORT_LABEL_WIDTH = 28;

/** Label count before the chart is measured, and in tests (no `ResizeObserver`). */
const UNMEASURED_LABELS = 6;

/** How many x labels fit on a plot `plotWidth` px wide, at least one. */
export function maxTickLabels(plotWidth: number | null, labelWidth: number): number {
  if (plotWidth === null) return UNMEASURED_LABELS;
  return Math.max(1, Math.floor(plotWidth / labelWidth));
}

/**
 * The x values to label: every `step`-th value counted back from the last,
 * `step = ceil(n / maxLabels)`. The last value (today) is always labelled and
 * every gap is the same; the first value only when the step lands on it.
 */
export function evenTicks<T>(values: readonly T[], maxLabels: number): T[] {
  const step = Math.ceil(values.length / Math.max(1, maxLabels));
  const ticks: T[] = [];
  for (let index = values.length - 1; index >= 0; index -= step) ticks.push(values[index] as T);
  return ticks.reverse();
}

const HOUR_SECONDS = 3600;

/**
 * Y ticks for a chart of durations in seconds: 0 and four equal steps of
 * whole hours (2-hour steps from 10 hours), so the axis reads `0h 1h 2h …`.
 * At least one hour, so an empty chart still has an axis.
 */
export function hourTicks(maxSeconds: number): number[] {
  const unit = maxSeconds > 10 * HOUR_SECONDS ? 2 * HOUR_SECONDS : HOUR_SECONDS;
  const step = unit * Math.max(1, Math.ceil(maxSeconds / unit / 4));
  return [0, 1, 2, 3, 4].map((index) => index * step);
}

// The tooltip cursors set every colour themselves. Without a `RechartsThemeProvider`,
// Recharts (from 3.11) fills in `#ccc` for any colour a cursor leaves out, so a
// band without `stroke` gets a grey border.

/** The soft column behind the hovered bar (`StackedBars`). */
export const CHART_BAND_CURSOR = { fill: 'var(--hover)', opacity: 0.6, stroke: 'none' };

// Shared by the line charts (`ValueLine`, `Sparkline`), so they look and behave the same.

/** The dashed crosshair under the pointer. */
export const CHART_CURSOR = { stroke: 'var(--text-3)', strokeDasharray: '3 3', fill: 'none' };

/** Props of the one series: `--active`, 2 px, a dot only on hover. */
export function seriesLineProps(pointCount: number) {
  return {
    type: 'linear',
    stroke: 'var(--active)',
    strokeWidth: 2,
    // A single day has no line to draw, so show its point.
    dot: pointCount === 1 ? { r: 3, fill: 'var(--active)', strokeWidth: 0 } : false,
    activeDot: { r: 4, fill: 'var(--active)', stroke: 'var(--card)', strokeWidth: 2 },
    isAnimationActive: false,
  } as const;
}
