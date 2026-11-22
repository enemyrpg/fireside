import type { BossKc } from '@fireside/shared';
import type { ReactNode } from 'react';
import { BossIcon } from '@/components/BossIcon';
import { Card } from '@/components/Card';
import { KcByAccount, type AccountsView } from '@/components/KcByAccount';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TooltipRow } from '@/components/TooltipRow';
import { formatCompact, formatGpExact, formatInt, formatPbTime } from '@/format';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import {
  completedModes,
  fastestTeamSizes,
  RAID_EMPTY,
  SPECIAL_LOOT_MANUAL,
  SPECIAL_LOOT_MANUAL_RULE,
  SPECIAL_LOOT_RECORDED,
  specialLootValue,
  teamSizeLabel,
  type RaidCardData,
  type RaidModeRow,
} from '@/lib/raids';
import { cn } from '@/lib/utils';

// One raid: loot without own purples, own special loot (purples added by hand
// included) and your share of its purples, then per mode with completions the
// KC and the best time per team size done, the fastest highlighted. No
// Split/FFA switch here: the default is per account.

/**
 * `single`: the only card, full width (`ProgressRaids`): 26 px values with
 * "gp" in the same size, and "Best time per team size" over the times.
 * `stacked`: one of several in two columns (`ProgressRaidsAll`): 24 px values
 * in three equal columns with a 13 px "gp"; the page explains the times once.
 */
export type RaidCardLayout = 'single' | 'stacked';

/** A value at the top of the card, with the exact value (and more) in the tooltip. */
function Value({
  layout,
  value,
  label,
  tooltip,
}: {
  layout: RaidCardLayout;
  /** `undefined`: not known yet (the share while the tracker loads or failed). */
  value: number | undefined;
  label: string;
  tooltip?: ReactNode;
}) {
  const desktop = useIsDesktop();
  const number =
    value === undefined ? (
      <span className="text-text-3" aria-label="Not available">
        –
      </span>
    ) : (
      <>
        {formatCompact(value)}
        {/* Mobile (`MobileRaids`) has no room for "gp" in three columns. */}
        {desktop && (
          <span className={cn(layout === 'stacked' && 'text-[13px] text-text-2')}> gp</span>
        )}
      </>
    );
  return (
    <div className="flex min-w-0 flex-col">
      {value === undefined ? (
        <span className="font-display text-xl font-semibold desk:text-2xl">{number}</span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className={cn(
                'cursor-default rounded-sm font-display text-xl font-semibold whitespace-nowrap tabular-nums',
                layout === 'single' ? 'desk:text-[26px]' : 'desk:text-2xl',
              )}
            >
              {number}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px]">
            <div className="font-semibold tabular-nums">{formatGpExact(value)}</div>
            {tooltip}
          </TooltipContent>
        </Tooltip>
      )}
      <span className="text-xs text-text-3">{label}</span>
    </div>
  );
}

/** Best time per team size done (only those), the fastest in `--accent-text`. */
function BestTimes({ row }: { row: RaidModeRow & { kc: BossKc } }) {
  const times = row.kc.bestTimesByTeamSize;
  if (times.length === 0) return null;
  const fastest = fastestTeamSizes(times);
  return (
    <ul aria-label={`${row.label} best times`} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {times.map((time) => {
        const best = fastest.has(time.teamSize);
        return (
          <li
            key={time.teamSize}
            className="flex items-baseline gap-1.5 rounded-lg bg-raised px-2.5 py-[5px] text-xs"
          >
            <span className="text-text-3">{teamSizeLabel(time.teamSize)}</span>
            <span className={cn('font-mono', best ? 'text-accent-text' : 'text-text')}>
              {formatPbTime(time.seconds)}
            </span>
            {best && <span className="sr-only">(fastest)</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** One mode: its name and KC (with the split per account for `all`), then the times. */
function ModeRow({
  row,
  layout,
  accounts,
}: {
  row: RaidModeRow & { kc: BossKc };
  layout: RaidCardLayout;
  accounts: AccountsView | undefined;
}) {
  const { kc } = row;
  return (
    <li
      className={cn(
        'flex flex-col gap-2 border-t border-hover',
        layout === 'single' ? 'pt-3' : 'pt-3 desk:pt-3.5',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className={layout === 'single' ? 'text-text-2' : 'font-medium'}>{row.label}</span>
        <span className="tabular-nums">
          {accounts ? (
            <KcByAccount
              name={row.mode}
              killCount={kc.killCount}
              byAccount={kc.byAccount}
              accounts={accounts}
            />
          ) : (
            <span className="font-semibold">{formatInt(kc.killCount)}</span>
          )}
        </span>
      </div>
      {layout === 'single' && kc.bestTimesByTeamSize.length > 0 && (
        <span className="text-xs text-text-3">Best time per team size</span>
      )}
      <BestTimes row={row} />
    </li>
  );
}

export function RaidCard({
  card,
  layout,
  accounts,
}: {
  card: RaidCardData;
  layout: RaidCardLayout;
  /** For `all`: the split per account on each mode's KC. */
  accounts: AccountsView | undefined;
}) {
  const modes = completedModes(card);
  const special = specialLootValue(card);
  const manual = card.manualSpecialLoot > 0;
  return (
    <Card className={cn('flex flex-col', layout === 'single' ? 'gap-3.5' : 'gap-4')}>
      <h2 className="m-0 flex items-center gap-2.5 font-display text-[17px] font-semibold desk:text-lg">
        <BossIcon boss={card.raid} />
        {card.raid}
      </h2>
      <div
        className={cn(
          'grid grid-cols-3 gap-2.5',
          layout === 'single'
            ? 'desk:flex desk:flex-wrap desk:gap-x-12 desk:gap-y-4'
            : 'desk:gap-3',
        )}
      >
        <Value layout={layout} value={card.summary?.lootGeValue ?? 0} label="loot" />
        <Value
          layout={layout}
          value={special}
          // `ProgressRaids`: the label says when purples added by hand are in it.
          label={manual ? 'special loot · includes manual drops' : 'special loot'}
          {...(manual
            ? {
                tooltip: (
                  <>
                    <TooltipRow
                      label={SPECIAL_LOOT_RECORDED}
                      value={formatGpExact(card.summary?.specialLootGeValue ?? 0)}
                    />
                    <TooltipRow
                      label={SPECIAL_LOOT_MANUAL}
                      value={formatGpExact(card.manualSpecialLoot)}
                    />
                    <div className="mt-1 text-text-2">{SPECIAL_LOOT_MANUAL_RULE}</div>
                  </>
                ),
              }
            : {})}
        />
        {/* `undefined` while the tracker loads or when it failed (Retry is in the number row). */}
        <Value layout={layout} value={card.share} label="your share" />
      </div>
      {modes.length > 0 ? (
        <ul aria-label={`${card.raid} modes`} className="m-0 flex list-none flex-col gap-3.5 p-0">
          {modes.map((row) => (
            <ModeRow key={row.mode} row={row} layout={layout} accounts={accounts} />
          ))}
        </ul>
      ) : (
        // Loot or a share without completions (a purple added by hand).
        <p className="m-0 border-t border-hover pt-3 text-sm text-text-3">{RAID_EMPTY}</p>
      )}
    </Card>
  );
}
