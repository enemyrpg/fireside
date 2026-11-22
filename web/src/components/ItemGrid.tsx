import type { CSSProperties, ReactNode } from 'react';
import { ItemIcon } from '@/components/ItemIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCompact } from '@/format';
import { cn } from '@/lib/utils';

// ItemGrid and ItemSlot: the bank, potion storage, the inventory, the equipment and
// the collection log, drawn like the game. The slots fill the grid's columns
// (11:10 on PC, square on mobile). The icon stays at the game's own 36 × 32 px,
// centred, and only shrinks when the slot is smaller: pixel art is never scaled up or
// by an uneven factor.

/**
 * - `item`: icon and quantity.
 * - `placeholder`: the same icon at 38% opacity, no quantity.
 * - `missing`: a collection log item the account does not have. Drawn like a
 *   placeholder (2.5: missing and placeholders look the same).
 * - `filler`: a reserved empty slot, a box with a border and no icon.
 * - `hole`: an empty slot of a fixed layout (inventory, equipment), a faint frame.
 * - `empty`: nothing, but the space is kept so rows and columns stay as in the game.
 */
export type ItemSlotVariant = 'item' | 'placeholder' | 'missing' | 'filler' | 'hole' | 'empty';

export interface ItemSlotProps {
  variant: ItemSlotVariant;
  /** Needed for `item`, `placeholder` and `missing`. */
  itemId?: number;
  name?: string;
  /** Number in the top left corner (compact). Not shown for 1 or less. */
  quantity?: number;
  /** Tooltip content. Slots without one have no tooltip. */
  tooltip?: ReactNode;
}

const SLOT =
  'relative grid aspect-square min-w-0 place-items-center rounded-md desk:aspect-[11/10] desk:rounded-[7px]';

/**
 * One slot. Not a tab stop (a bank has hundreds): the grid has a summary for
 * screen readers, and the page has a list view.
 */
export function ItemSlot({ variant, itemId, name, quantity, tooltip }: ItemSlotProps) {
  if (variant === 'empty') return <span data-slot-variant="empty" className={SLOT} />;

  const framed = variant === 'filler' || variant === 'hole';
  const slot = (
    <span
      data-slot-variant={variant}
      className={cn(
        SLOT,
        framed ? 'shadow-[inset_0_0_0_1px_var(--border)]' : 'bg-raised',
        variant === 'hole' && 'opacity-60',
        tooltip !== undefined && 'hover:shadow-[inset_0_0_0_1px_var(--accent)]',
      )}
    >
      {!framed && itemId !== undefined && name !== undefined && (
        <ItemIcon
          itemId={itemId}
          name={name}
          size="slot"
          className={cn((variant === 'placeholder' || variant === 'missing') && 'opacity-[0.38]')}
        />
      )}
      {variant === 'item' && quantity !== undefined && quantity > 1 && (
        // Always `--text`: the game's yellow, white and green numbers are not used.
        <span className="absolute top-px left-[3px] rounded-[3px] bg-raised px-0.5 text-[10px] leading-[13px] font-medium text-text tabular-nums desk:top-[3px] desk:left-[5px] desk:text-[10.5px]">
          {formatCompact(quantity)}
        </span>
      )}
    </span>
  );
  if (tooltip === undefined) return slot;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{slot}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export interface ItemGridProps {
  /** Slots per row: 8 in the bank, 6 in the collection log, 4 in the inventory, 3 for equipment. */
  columns: number;
  /** Summary for screen readers, e.g. "Tab 2: 7 items worth 19.01M gp". */
  label: string;
  className?: string;
  children: ReactNode;
}

/**
 * Grid with a fixed number of columns on every width. The slots share the
 * card's width (gap 4 px on mobile, 5 px on PC), at most 64 px wide on PC so a
 * full-width card (one column, 861–1100 px) does not blow them up.
 */
export function ItemGrid({ columns, label, className, children }: ItemGridProps) {
  return (
    <div
      role="img"
      aria-label={label}
      style={{ '--cols': columns } as CSSProperties}
      className={cn(
        'grid grid-cols-[repeat(var(--cols),minmax(0,1fr))] gap-1 desk:max-w-[calc(var(--cols)*64px+(var(--cols)-1)*5px)] desk:gap-[5px]',
        className,
      )}
    >
      {children}
    </div>
  );
}
