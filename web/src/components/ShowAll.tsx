import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** "Show all (n)" / "Show fewer" under a list. Nothing when the list is short. */
export function ShowAllButton({
  foldable,
  expanded,
  total,
  toggle,
  label,
  className,
}: {
  foldable: boolean;
  expanded: boolean;
  total: number;
  toggle: () => void;
  /** Text while folded, instead of "Show all (n)", e.g. "Show all 8 this month". */
  label?: string;
  className?: string;
}) {
  if (!foldable) return null;
  return (
    <div className={cn('mt-3 flex justify-center', className)}>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        className="max-desk:h-11 max-desk:px-4"
        onClick={toggle}
      >
        {expanded ? 'Show fewer' : (label ?? `Show all (${String(total)})`)}
      </Button>
    </div>
  );
}
