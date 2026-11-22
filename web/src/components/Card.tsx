import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Card: radius 16 px and padding 18 px on mobile, radius 14 px and padding 22 ×
 * 24 px on PC, 1 px border.
 */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-2xl border border-border bg-card p-[18px] desk:rounded-[14px] desk:px-6 desk:py-[22px]',
        className,
      )}
      {...props}
    />
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Link or controls on the right ("Open →", period toggle). */
  action?: ReactNode;
  /**
   * DOM id of the heading, which can then take focus from code (not a tab
   * stop), e.g. after the last row of its list was deleted.
   */
  headingId?: string;
  className?: string;
}

/** Title on the left, link or controls on the right. */
export function CardHeader({ title, action, headingId, className }: CardHeaderProps) {
  return (
    <div className={cn('mb-3.5 flex flex-wrap items-center gap-2.5', className)}>
      <h2
        className="text-base font-semibold outline-none"
        {...(headingId === undefined ? {} : { id: headingId, tabIndex: -1 })}
      >
        {title}
      </h2>
      {action !== undefined && <div className="ml-auto flex items-center gap-2">{action}</div>}
    </div>
  );
}
