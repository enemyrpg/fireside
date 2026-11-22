/**
 * Sizes of `SkillIcon` and `BossIcon`. The game's sprites are 25 × 25 pixel
 * art, so they are only drawn at whole multiples. `sm` (default): a 24 × 24
 * box, like item icons in lists, so rows line up. The image is drawn unscaled
 * at 25 × 25, centred, and sticks out half a pixel on each side (the box does
 * not clip it). `lg`: 50 × 50, exactly twice.
 */
export type NamedIconSize = 'sm' | 'lg';

export const NAMED_ICON_SIZES: Record<
  NamedIconSize,
  { width: number; height: number; box: string; image: string }
> = {
  sm: {
    width: 25,
    height: 25,
    box: 'size-6 rounded-md text-axis',
    image: '-left-[0.5px] -top-[0.5px] size-[25px] max-w-none [image-rendering:pixelated]',
  },
  lg: {
    width: 50,
    height: 50,
    box: 'size-[50px] rounded-lg text-lg',
    image: 'inset-0 size-full [image-rendering:pixelated]',
  },
};
