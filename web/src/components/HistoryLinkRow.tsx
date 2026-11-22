import { Link } from 'react-router';
import { formatInt } from '@/format';
import { cn } from '@/lib/utils';

/**
 * A dashed row at the foot of a list that leads to its history, e.g.
 * "Revoked keys · 5 →". Nothing when there is nothing behind it. 44 px high on
 * mobile.
 */
export function HistoryLinkRow({
  to,
  label,
  count,
  className,
}: {
  to: string;
  /** What is behind the link, e.g. "Revoked keys". */
  label: string;
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <Link
      to={to}
      className={cn(
        'mt-3 flex min-h-11 items-center justify-between gap-3 rounded-[10px] border border-dashed border-border-strong px-3.5 py-2.5 text-sm text-text-2 no-underline hover:border-accent hover:text-text desk:min-h-10',
        className,
      )}
    >
      <span>
        {label} <span className="text-text-3 tabular-nums">· {formatInt(count)}</span>
      </span>
      <span aria-hidden="true" className="text-accent-text">
        →
      </span>
    </Link>
  );
}
