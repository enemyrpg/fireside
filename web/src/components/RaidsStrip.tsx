import type { AccountScope, RaidSplitsResponse, SplitMode } from '@fireside/shared';
import type { ReactNode } from 'react';
import { useSetSplitDefault } from '@/api/hooks';
import { Gp } from '@/components/Gp';
import { SegmentedFilter } from '@/components/Segmented';
import { AccountDot } from '@/components/shell/AccountDot';
import { StatStrip, type StatStripItem } from '@/components/StatStrip';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatGp, formatGpExact, formatInt } from '@/format';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { modeLabel, monthBars, SAVE_FAILED, type MonthBar } from '@/lib/raid-splits';
import type { AccountLabel } from './SpecialLootTable';

// The number row of the Raids tab. It replaces the "Your share" card. One
// account: your share, from your drops and from teammates' drops, bars per
// month and the account's default Split or FFA. All accounts: your share,
// special loot and completions, and each account's default as text. All values
// are before GE tax.

export const DEFAULT_LABEL = 'Default for this account';
export const PICK_AN_ACCOUNT = 'Pick an account to change its default';

/** Months shown as bars: the latest twelve, so the row keeps its width. */
export const MONTH_BARS_SHOWN = 12;

const MODE_OPTIONS = [
  { value: 'SPLIT', label: 'Split' },
  { value: 'FFA', label: 'FFA' },
] as const satisfies readonly { value: SplitMode; label: string }[];

/**
 * Split | FFA for one account. Saved right away; the choice shows while it
 * saves, and goes back with a message if saving failed. PC: the label over
 * the toggle. Mobile (`MobileRaids`): the label on the left, a 150 px toggle
 * with 44 px buttons on the right.
 */
function DefaultToggle({ accountId, mode }: { accountId: number; mode: SplitMode }) {
  const save = useSetSplitDefault();
  return (
    <div className="flex flex-col gap-1.5 desk:items-end">
      <div className="flex items-center justify-between gap-3 desk:flex-col desk:items-end desk:gap-1.5">
        <span className="text-xs text-text-3">{DEFAULT_LABEL}</span>
        <SegmentedFilter
          label={DEFAULT_LABEL}
          options={MODE_OPTIONS}
          value={save.isPending ? save.variables.mode : mode}
          onChange={(next) => {
            if (next !== mode && !save.isPending) save.mutate({ accountId, mode: next });
          }}
          block
          className="max-desk:w-[150px]"
        />
      </div>
      {save.isError && (
        <p role="alert" className="m-0 text-xs text-down">
          {SAVE_FAILED}
        </p>
      )}
    </div>
  );
}

/** For `all`: each account's default as text. It is changed by picking an account. */
function DefaultsText({
  defaults,
  accountLabel,
}: {
  defaults: RaidSplitsResponse['defaults'];
  accountLabel: AccountLabel;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-sm text-text-2 desk:items-end">
      <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        <span className="text-text-3">Default</span>
        {defaults.map((entry) => {
          const account = accountLabel(entry.accountId);
          return (
            <span key={entry.accountId} className="inline-flex items-center gap-1.5">
              {account && <AccountDot color={account.color} />}
              {account ? `${account.name} · ` : ''}
              {modeLabel(entry.mode)}
            </span>
          );
        })}
      </span>
      <span className="text-xs text-text-3">{PICK_AN_ACCOUNT}</span>
    </div>
  );
}

/**
 * Your share per month as plain bars (`ProgressRaids`): 34 px wide in a 70 px
 * row, the month under each, the exact share on hover or focus. PC only.
 */
function MonthBars({ bars }: { bars: readonly MonthBar[] }) {
  const shown = bars.slice(-MONTH_BARS_SHOWN);
  const max = Math.max(1, ...shown.map((bar) => bar.value));
  return (
    <ul
      aria-label="Your share per month"
      className="m-0 flex h-[70px] list-none items-end gap-2.5 p-0"
    >
      {shown.map((bar) => (
        <li key={bar.key} className="flex h-full flex-col items-center justify-end gap-[5px]">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="img"
                tabIndex={0}
                aria-label={`${bar.title}: ${formatGp(bar.value)}`}
                className="block w-[34px] cursor-default rounded bg-active focus-visible:outline-2 focus-visible:outline-accent"
                // At least 2 px, so a month with a small share still shows.
                style={{ height: `${String(Math.max(2, Math.round((bar.value / max) * 52)))}px` }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <div className="font-semibold">{bar.title}</div>
              <div className="tabular-nums">Your share {formatGpExact(bar.value)}</div>
            </TooltipContent>
          </Tooltip>
          <span aria-hidden="true" className="text-[11px] text-text-3">
            {bar.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface RaidTotals {
  specialLoot: number;
  completions: number;
  raids: number;
}

/** For `all`: special loot and completions, "–" until `kc` and `raids` have loaded. */
function totalItems(
  totals: RaidTotals | undefined,
  gp: (value: number) => ReactNode,
): StatStripItem[] {
  return [
    {
      key: 'special',
      value: totals ? gp(totals.specialLoot) : '–',
      ...(totals ? { unit: 'gp' } : {}),
      label: 'special loot',
    },
    {
      key: 'completions',
      value: totals ? formatInt(totals.completions) : '–',
      label: totals
        ? `completions · ${formatInt(totals.raids)} ${totals.raids === 1 ? 'raid' : 'raids'}`
        : 'completions',
      shortLabel: 'completions',
    },
  ];
}

export function RaidsStrip({
  scope,
  query,
  totals,
  totalsFailed,
  accountLabel,
}: {
  scope: AccountScope;
  /** `raids/splits`: the share, the months and the defaults. */
  query: { data: RaidSplitsResponse | undefined; isError: boolean; refetch: () => unknown };
  /** For `all`, from the raid cards; `undefined` until `kc` and `raids` have loaded. */
  totals: RaidTotals | undefined;
  /** `kc` or `raids` failed, so `totals` won't come (the cards have Retry). */
  totalsFailed: boolean;
  accountLabel: AccountLabel;
}) {
  const desktop = useIsDesktop();
  const { data } = query;
  let items: StatStripItem[] | undefined;
  let aside;
  const gp = (value: number) => <Gp value={value} unit={false} />;
  // All accounts: special loot and completions come from `kc` and `raids`,
  // so they still show when the tracker failed; only the share has Retry.
  const shareFailedOnly = scope === 'all' && data === undefined && query.isError && !totalsFailed;
  if (shareFailedOnly) {
    items = [
      {
        key: 'share',
        value: '–',
        label: 'your share · all time',
        note: (
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        ),
      },
      ...totalItems(totals, gp),
    ];
  }
  if (data !== undefined) {
    const { total } = data;
    items = [
      {
        key: 'share',
        value: gp(total.share),
        unit: 'gp',
        label: 'your share · all time',
      },
    ];
    if (scope === 'all') {
      items.push(...totalItems(totals, gp));
      aside = data.defaults.length > 0 && (
        <DefaultsText defaults={data.defaults} accountLabel={accountLabel} />
      );
    } else {
      items.push(
        {
          key: 'own',
          value: gp(total.fromOwnDrops),
          unit: 'gp',
          label: 'from your drops',
        },
        {
          key: 'teammates',
          value: gp(total.fromTeammateDrops),
          unit: 'gp',
          label: 'from teammates’ drops',
          shortLabel: 'from teammates',
        },
      );
      // No entry: the data on screen is still another account's, kept while this one loads.
      const own = data.defaults.find((entry) => entry.accountId === scope);
      const bars = monthBars(data.months);
      const showBars = desktop && bars.length > 0;
      // Nothing to show (no bars on mobile, no default yet): no empty row under the numbers.
      aside = (showBars || own) && (
        <div className="flex items-end gap-7">
          {showBars && <MonthBars bars={bars} />}
          {/* Keyed by account, so a save in progress or a failed one never shows under another account. */}
          {own && <DefaultToggle key={own.accountId} accountId={own.accountId} mode={own.mode} />}
        </div>
      );
    }
  }
  return (
    <StatStrip
      label="Raids summary"
      items={items}
      skeletonCount={3}
      aside={aside}
      error={
        data === undefined &&
        query.isError &&
        !shareFailedOnly && <ErrorState className="min-h-0" onRetry={() => void query.refetch()} />
      }
      // Mobile (`MobileRaids`): the two small numbers share a row in halves.
      className="max-desk:grid-cols-2"
    />
  );
}
