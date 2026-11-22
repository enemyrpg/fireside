import { cn } from '@/lib/utils';

/**
 * Progress bar: 6 px, `--active` on `--raised` with a 1 px border so it shows in
 * the light theme. Always put the numbers as text next to it: the bar alone says
 * too little, and `label` is all a screen reader gets.
 */
export function ProgressBar({
  value,
  max,
  label,
  className,
}: {
  value: number;
  max: number;
  /** E.g. "712 of 1,568 slots". */
  label: string;
  className?: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      className={cn(
        'h-1.5 overflow-hidden rounded-full border border-border bg-raised box-content',
        className,
      )}
    >
      <div className="h-full rounded-full bg-active" style={{ width: `${String(ratio * 100)}%` }} />
    </div>
  );
}
