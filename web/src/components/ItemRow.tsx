import type { ReactNode } from 'react';
import { ItemIcon } from '@/components/ItemIcon';
import { cn } from '@/lib/utils';

// One item in a card's list: a 32 px icon box, the name, one line under it
// (source · date, and the account for `all`), and the value in semibold on the
// right. Weekly's Loot and Collection log; the "Latest" feed on Home can use it
// too.

export function ItemRow({
  itemId,
  itemName,
  name,
  detail,
  value,
  className,
}: {
  itemId: number;
  /** The item's name, for the placeholder's letters. */
  itemName: string;
  /** "Dragon arrowtips × 356". */
  name: ReactNode;
  /** The line under the name: "The Fractured Archive · Mon 16 Nov". One line, cut with "…". */
  detail: ReactNode;
  /** Right-hand value, e.g. `<Gp />`. None for collection log items. */
  value?: ReactNode;
  className?: string;
}) {
  return (
    <li
      className={cn(
        'grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-[9px]',
        className,
      )}
    >
      <ItemIcon itemId={itemId} name={itemName} size="row" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-text-3">
          {detail}
        </span>
      </span>
      <span className="font-semibold whitespace-nowrap tabular-nums">{value}</span>
    </li>
  );
}
