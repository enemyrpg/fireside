import { DIARY_TIERS, type DiaryTier } from '@fireside/shared';
import { titleCase } from '@/format';
import { cn } from '@/lib/utils';

export interface TierPipsProps {
  /** The tiers the region has. One that is missing leaves its place empty. */
  tiers: readonly { tier: DiaryTier; completed: boolean }[];
}

/**
 * The four tiers of a diary region, Easy to Elite. Completed is `--accent-wash`
 * with `--accent-text`, never green; not completed is a border only. On mobile
 * just the initials (E M H E); the label of each pip always has the full name
 * and the state.
 */
export function TierPips({ tiers }: TierPipsProps) {
  return (
    <span className="inline-flex gap-[5px] desk:gap-1.5">
      {DIARY_TIERS.map((name) => {
        const tier = tiers.find((entry) => entry.tier === name);
        const label = titleCase(name);
        const text = (
          <span aria-hidden="true">
            {label.charAt(0)}
            <span className="max-desk:hidden">{label.slice(1)}</span>
          </span>
        );
        // 64 × 24 px pills, 28 px with the initial on mobile.
        const shape = 'w-7 rounded-md border py-[3px] text-center text-xs desk:w-16';
        // Keeps the columns aligned for a region without this tier.
        if (!tier) {
          return (
            <span key={name} className={cn(shape, 'invisible')}>
              {text}
            </span>
          );
        }
        return (
          <span
            key={name}
            role="img"
            aria-label={`${label}: ${tier.completed ? 'completed' : 'not completed'}`}
            className={cn(
              shape,
              tier.completed
                ? 'border-transparent bg-accent-wash font-medium text-accent-text'
                : 'border-border text-text-3',
            )}
          >
            {text}
          </span>
        );
      })}
    </span>
  );
}
