import { Fragment, type ReactNode } from 'react';
import { useIsWide } from '@/hooks/useIsWide';
import { stackedOrder } from '@/lib/stacked-columns';
import { cn } from '@/lib/utils';

// Two columns that stack independently: a tall card never pushes down the card
// beside it, and a hidden one just leaves its column shorter. Weekly and the
// raid cards.

export interface StackedItem {
  key: string;
  /** The column on wide screens. */
  column: 'left' | 'right';
  node: ReactNode;
}

/**
 * From the `wide:` breakpoint (1100 px): two columns, each stacked on its own,
 * in the DOM (and tab) order left column top to bottom, then right column.
 * Narrower: one column in the order of `items`.
 */
export function StackedColumns({
  items,
  className,
}: {
  /** In one-column order; `column` says where each goes on wide screens. */
  items: readonly StackedItem[];
  className?: string;
}) {
  const order = stackedOrder(items, useIsWide());
  const column = (list: readonly StackedItem[]) =>
    list.map((item) => <Fragment key={item.key}>{item.node}</Fragment>);
  if (Array.isArray(order)) {
    return <div className={cn('flex min-w-0 flex-col gap-5', className)}>{column(order)}</div>;
  }
  return (
    <div className={cn('grid grid-cols-2 items-start gap-5', className)}>
      <div data-column="left" className="flex min-w-0 flex-col gap-5">
        {column(order.left)}
      </div>
      <div data-column="right" className="flex min-w-0 flex-col gap-5">
        {column(order.right)}
      </div>
    </div>
  );
}
