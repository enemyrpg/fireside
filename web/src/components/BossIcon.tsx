import { bossIconUrl, bossInitials } from '@/lib/icons';
import { IconImage } from './IconImage';
import { NAMED_ICON_SIZES, type NamedIconSize } from './namedIconSizes';

/**
 * Boss or raid icon: the game's own sprite from the user's database (uploaded
 * by the plugin) over a square with the boss's initials, which shows while the
 * image loads and stays when there is none (bosses that are not on the
 * hiscores). Never ship Jagex graphics.
 */
export function BossIcon({
  boss,
  size = 'sm',
  className,
}: {
  boss: string;
  size?: NamedIconSize;
  className?: string;
}) {
  const { width, height, box, image } = NAMED_ICON_SIZES[size];
  return (
    <IconImage
      src={bossIconUrl(boss)}
      placeholder={bossInitials(boss)}
      width={width}
      height={height}
      boxClassName={box}
      placeholderClassName="bg-raised"
      imageClassName={image}
      className={className}
    />
  );
}
