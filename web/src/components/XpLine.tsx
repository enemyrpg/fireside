import type { XpPoint } from '@fireside/shared';
import { TooltipRow } from '@/components/TooltipRow';
import { ValueLine } from '@/components/ValueLine';
import { formatInt, formatXpGain } from '@/format';

export interface XpLineProps {
  /** One point per local day, oldest first. */
  points: readonly XpPoint[];
  /** Accessible name, e.g. "XP over time for Overall, last 90 days". */
  label: string;
  /** Show the level in the tooltip. Only for a single account. */
  showLevel: boolean;
  /** Name of the level in the tooltip: "Level" or "Total level". */
  levelLabel?: string;
  height?: number;
}

/**
 * XP over time: a `ValueLine` of total XP with the day's gain (and the level,
 * for one account) in the tooltip.
 */
export function XpLine({
  points,
  label,
  showLevel,
  levelLabel = 'Level',
  height = 240,
}: XpLineProps) {
  return (
    <ValueLine
      points={points}
      dateOf={(point) => point.period}
      valueOf={(point) => point.xp}
      label={label}
      height={height}
      tooltip={(point) => (
        <>
          <TooltipRow label="Gained that day" value={`${formatXpGain(point.gained)} XP`} />
          <TooltipRow label="Total" value={`${formatInt(point.xp)} XP`} />
          {showLevel && <TooltipRow label={levelLabel} value={formatInt(point.level)} />}
        </>
      )}
    />
  );
}
