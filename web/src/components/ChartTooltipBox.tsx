import type { ReactNode } from 'react';

/**
 * The box of a chart tooltip (`ValueLine`, `Sparkline`): the date as a heading,
 * then the chart's own lines.
 */
export function ChartTooltipBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs whitespace-nowrap tabular-nums shadow-menu">
      <div className="mb-1 font-semibold">{title}</div>
      {children}
    </div>
  );
}
