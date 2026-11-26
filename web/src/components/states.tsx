import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { cn } from '@/lib/utils';

// Empty, error and loading states.

/** One inviting sentence, and an action where it fits. */
export function EmptyState({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-24 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-6 text-center text-text-2',
        className,
      )}
    >
      <p className="m-0">{children}</p>
      {action}
    </div>
  );
}

/** One line in the middle of a card that has nothing to list ("Nothing matches …"). */
export function EmptyMessage({ children }: { children: ReactNode }) {
  return <p className="m-0 py-7 text-center text-text-2">{children}</p>;
}

/** Per-card error. The rest of the page keeps working. Never shows the raw error. */
export function ErrorState({ onRetry, className }: { onRetry: () => void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex min-h-24 flex-col items-center justify-center gap-3 p-4 text-center text-text-2',
        className,
      )}
    >
      <p className="m-0">Couldn&apos;t load this.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Skeleton in the shape of a card's content. Appears only after 200 ms, so
 * fast answers don't flash; until then it just holds the space.
 */
export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  const shown = useDelayedFlag(true);
  return (
    <div aria-busy="true" aria-label="Loading" className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          data-testid="skeleton-line"
          className={cn('h-5 rounded-md', index === 0 ? 'w-2/5' : 'w-full', !shown && 'invisible')}
        />
      ))}
    </div>
  );
}

/**
 * A line of text that hasn't loaded. A no-break space in the text's own classes
 * (`className`: size, line height, `block` or `inline-block`, width) holds the
 * line's final height from the first frame; the bar only covers it, after
 * 200 ms, and never sets its size (docs/design.md, "Loading").
 */
export function TextSkeleton({ className }: { className?: string }) {
  const shown = useDelayedFlag(true);
  return (
    <span aria-hidden="true" data-testid="text-skeleton" className={cn('relative', className)}>
      {' '}
      <Skeleton
        className={cn('absolute inset-x-0 inset-y-[15%] rounded-md', !shown && 'invisible')}
      />
    </span>
  );
}
