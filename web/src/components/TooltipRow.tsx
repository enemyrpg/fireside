import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One line in a tooltip: a label and its value, right-aligned. `strong` makes
 * the value semibold, for tooltips where the values are the point (slots).
 */
export function TooltipRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4 whitespace-nowrap tabular-nums">
      <span className="text-text-2">{label}</span>
      <span className={cn(strong && 'font-semibold')}>{value}</span>
    </div>
  );
}
