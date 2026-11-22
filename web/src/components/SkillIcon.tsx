import { skillAbbreviation, skillIconUrl } from '@/lib/icons';
import { IconImage } from './IconImage';
import { NAMED_ICON_SIZES, type NamedIconSize } from './namedIconSizes';

/**
 * Skill icon: the game's own sprite from the user's database (uploaded by the
 * plugin) over a square with the abbreviation, which shows while the image
 * loads and stays when there is none. `OVERALL` is the total level. Never ship
 * Jagex graphics.
 */
export function SkillIcon({
  skill,
  size = 'sm',
  className,
}: {
  skill: string;
  size?: NamedIconSize;
  className?: string;
}) {
  const { width, height, box, image } = NAMED_ICON_SIZES[size];
  return (
    <IconImage
      src={skillIconUrl(skill)}
      placeholder={skillAbbreviation(skill)}
      width={width}
      height={height}
      boxClassName={box}
      placeholderClassName="bg-raised"
      imageClassName={image}
      className={className}
    />
  );
}
