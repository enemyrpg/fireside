import { Suspense } from 'react';
import type { SparklineProps } from '@/components/Sparkline';
import { Skeleton } from '@/components/ui/skeleton';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { lazyNamed } from '@/lib/lazy';
import { SPARKLINE_AREA_HEIGHT, SPARKLINE_HEIGHT } from '@/lib/sparkline';
import { cn } from '@/lib/utils';

const { Component: Sparkline } = lazyNamed(() => import('@/components/Sparkline'), 'Sparkline');

/**
 * Takes exactly the space of the chart, labels included, so nothing moves
 * when it is drawn. The skeleton appears only after 200 ms, like every other.
 */
function SparklineSkeleton({ variant = 'line', startLabel, endLabel }: SparklineProps) {
  const shown = useDelayedFlag(true);
  const height = variant === 'area' ? SPARKLINE_AREA_HEIGHT : SPARKLINE_HEIGHT;
  const box = (
    <Skeleton
      aria-busy="true"
      aria-label="Loading"
      data-testid="sparkline-skeleton"
      className={cn('min-w-0 rounded-md', !shown && 'invisible')}
      style={{ height }}
    />
  );
  if (variant === 'line') return box;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {box}
      {(startLabel !== undefined || endLabel !== undefined) && (
        <div aria-hidden="true" className="flex justify-between text-axis text-text-3">
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      )}
    </div>
  );
}

/**
 * `Sparkline` for a page in the first chunk (Home): the chart library loads
 * on its own, so the rest of the card shows at once (docs/architecture.md,
 * "The dashboard bundle").
 */
export function LazySparkline(props: SparklineProps) {
  return (
    <Suspense fallback={<SparklineSkeleton {...props} />}>
      <Sparkline {...props} />
    </Suspense>
  );
}
