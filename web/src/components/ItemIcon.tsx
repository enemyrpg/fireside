import { itemIconUrl, itemInitials } from '@/lib/icons';
import { IconImage } from './IconImage';

/**
 * `sm` (default): 24 × 24 in lists and tables, scaled down. `slot`: 36 × 32,
 * the game's own size, in `ItemGrid`; on mobile it shrinks with the grid.
 * `lg`: 72 × 64, exactly twice the game's size with hard pixels, only on
 * `PetCard`. `row`: a 32 × 32 box for rows with two lines (`ItemRow`); the
 * 36 × 32 icon is scaled to fit. Other sizes are not used: the icons are pixel
 * art.
 */
export type ItemIconSize = 'sm' | 'row' | 'slot' | 'lg';

const SIZES: Record<
  ItemIconSize,
  { width: number; height: number; box: string; image: string; radius: string }
> = {
  sm: { width: 24, height: 24, box: 'size-6 text-axis', image: 'size-6', radius: 'rounded-md' },
  row: {
    width: 32,
    height: 32,
    box: 'size-8 text-axis',
    image: 'size-full',
    radius: 'rounded-md',
  },
  slot: {
    width: 36,
    height: 32,
    box: 'h-8 w-9 max-h-full max-w-full text-axis',
    image: 'size-full',
    radius: 'rounded-[5px]',
  },
  lg: {
    width: 72,
    height: 64,
    box: 'h-16 w-18 text-lg',
    image: 'size-full [image-rendering:pixelated]',
    radius: 'rounded-lg',
  },
};

/**
 * Item icon: the real icon from the user's own database (uploaded by the plugin) over the
 * placeholder, a dashed 24 px square with two letters. The placeholder shows while the icon loads,
 * and stays when there is none (404) or it can't be shown. The box is always the same size (24 ×
 * 24, or `size`), so nothing moves when the icon arrives. Decorative: every caller shows the item
 * name next to it or in an `aria-label`, so `alt` is empty. Never ship Jagex icons in the repo.
 */
export function ItemIcon({
  itemId,
  name,
  size = 'sm',
  className,
}: {
  itemId: number;
  name: string;
  size?: ItemIconSize;
  className?: string;
}) {
  const { width, height, box, image, radius } = SIZES[size];
  return (
    <IconImage
      src={itemIconUrl(itemId)}
      placeholder={itemInitials(name)}
      width={width}
      height={height}
      // A slot always has a tooltip of its own, so no native one on top of it.
      {...(size === 'sm' ? { title: name } : {})}
      boxClassName={`overflow-hidden ${box} ${radius}`}
      placeholderClassName="border border-dashed border-text-3 bg-raised"
      imageClassName={`inset-0 object-contain ${image}`}
      className={className}
    />
  );
}
