import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** Small label: account type, "Revoked", "Sample", "New". */
export function Badge({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-[5px] bg-raised px-[7px] py-px text-axis font-medium whitespace-nowrap text-text-2',
        className,
      )}
      {...props}
    />
  );
}

/** "Live" / "Online" with a pulsing dot (no pulse with reduced motion). */
export function LiveBadge({ children = 'Live' }: { children?: string }) {
  return (
    <Badge>
      <span aria-hidden="true" className="size-[7px] rounded-full bg-live animate-live-pulse" />
      {children}
    </Badge>
  );
}
