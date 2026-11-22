import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useAccounts, useDrops, useLoot } from '@/api/hooks';
import { BossIcon } from '@/components/BossIcon';
import { NAMED_ICON_SIZES } from '@/components/namedIconSizes';
import { Card, CardHeader } from '@/components/Card';
import { Gp } from '@/components/Gp';
import { HBarList } from '@/components/HBarList';
import { ItemRow } from '@/components/ItemRow';
import { SegmentedFilter } from '@/components/Segmented';
import { QueryCard } from '@/components/QueryCard';
import { AccountDot } from '@/components/shell/AccountDot';
import { PageControls } from '@/components/shell/PageControls';
import { StatStrip, type StatStripItem } from '@/components/StatStrip';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { formatCompact, formatGp, formatGpExact, formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useLocalToday } from '@/hooks/useLocalToday';
import { useParamsOfData } from '@/hooks/useParamsOfData';
import { accountColors, accountNameById } from '@/lib/accounts';
import { bossInitials } from '@/lib/icons';
import { sourceLabel } from '@/lib/loot';
import { cn } from '@/lib/utils';
import { lastDaysFrom } from '@/lib/time';
import { useAccountScope } from '@/routing/useAccountScope';
import {
  MIN_VALUE_GP,
  parseLootRange,
  parseMinValue,
  RANGE_DAYS,
  sourceRows,
  type LootRange,
  type MinValueKey,
} from './loot/rows';

// Loot part of Loot & KC: the number row and value per source for 7 days, 30
// days or all time (`?range=`), beside an all-time list of valuable drops
// filtered at 100K+, 1M+ or 10M+ (`?min=`). Boss KC follows below.

const RANGE_OPTIONS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
] as const satisfies readonly { value: LootRange; label: string }[];

const MIN_VALUE_OPTIONS = [
  { value: '100k', label: '100K+' },
  { value: '1m', label: '1M+' },
  { value: '10m', label: '10M+' },
] as const satisfies readonly { value: MinValueKey; label: string }[];

const RANGE_TEXT: Record<LootRange, { since: string; short: string; empty: string }> = {
  '7d': { since: 'in the last 7 days', short: 'last 7 days', empty: 'No loot in the last 7 days.' },
  '30d': {
    since: 'in the last 30 days',
    short: 'last 30 days',
    empty: 'No loot in the last 30 days.',
  },
  all: { since: 'all time', short: 'all time', empty: 'Loot from your kills shows up here.' },
};

/** Drops per "Load more" page, as for sessions. */
export const DROPS_PAGE_SIZE = 20;

// --- Number row ------------------------------------------------------------------

/**
 * Loot, drops and average per drop (`StatStrip`). `range` is the range of the
 * data on screen (`useParamsOfData`), not the URL's, so the label never
 * names a range that is still loading.
 */
function LootStrip({ loot, range }: { loot: ReturnType<typeof useLoot>; range: LootRange }) {
  const { data } = loot;
  let items: StatStripItem[] | undefined;
  if (data) {
    const { geValue, lootCount } = data.totals;
    const average = lootCount > 0 ? Math.round(geValue / lootCount) : 0;
    items = [
      {
        key: 'total',
        value: <Gp value={geValue} unit={false} />,
        unit: 'gp',
        label: `loot · ${RANGE_TEXT[range].short}, GE value`,
      },
      { key: 'drops', value: formatInt(lootCount), label: 'drops' },
      {
        key: 'average',
        value: <Gp value={average} unit={false} />,
        unit: 'gp',
        label: 'average per drop',
        // The unit is left out of the small numbers on mobile, so it goes in the label.
        shortLabel: 'gp per drop',
      },
    ];
  }
  return (
    <StatStrip
      label="Loot summary"
      items={items}
      skeletonCount={3}
      error={
        data === undefined &&
        loot.isError && <ErrorState className="min-h-0" onRetry={() => void loot.refetch()} />
      }
      // Mobile (`MobileProgressLoot`): the two small numbers share a row in halves.
      className="max-desk:grid-cols-2"
    />
  );
}

// --- By source ------------------------------------------------------------------

/**
 * The source's icon: a boss icon for an NPC (the game's own when the user's
 * database has one), and for a player, clue or event only the initials, so
 * no icon is asked for that can't exist.
 */
function SourceIcon({ label, isNpc }: { label: string; isNpc: boolean }) {
  if (isNpc) return <BossIcon boss={label} />;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-grid flex-none place-items-center bg-raised font-semibold text-text-2',
        NAMED_ICON_SIZES.sm.box,
      )}
    >
      {bossInitials(label)}
    </span>
  );
}

/**
 * Value per source: every source, six rows and then "Show all (n)" (the
 * six-row rule in `HBarList`). The response already has every source,
 * so nothing is fetched. The page remounts this card when data for a new
 * range or account arrives, which folds the list again.
 */
function SourcesCard({ loot, range }: { loot: ReturnType<typeof useLoot>; range: LootRange }) {
  // Mobile (`MobileProgressLoot`) has no room for "gp" after each value.
  const desktop = useIsDesktop();
  return (
    <QueryCard query={loot} title="By source" skeletonLines={8}>
      {(data) => {
        if (data.groupBy !== 'source' || data.groups.length === 0) {
          return <EmptyState className="min-h-[240px]">{RANGE_TEXT[range].empty}</EmptyState>;
        }
        const rows = sourceRows(data.groups).map((row) => ({
          key: row.key,
          label: row.label,
          value: row.geValue,
          icon: <SourceIcon label={row.label} isNpc={row.isNpc} />,
          detail: (
            <div className="text-text-2">
              {formatInt(row.lootCount)} {row.lootCount === 1 ? 'drop' : 'drops'}
            </div>
          ),
        }));
        return (
          <HBarList
            label={`Loot ${RANGE_TEXT[range].since} per source`}
            rows={rows}
            format={desktop ? formatGp : formatCompact}
            formatExact={formatGpExact}
            // `ProgressLoot`: a 22 px icon and 170 px name, the bar, an 80 px value.
            className="grid-cols-[150px_minmax(0,1fr)_auto] desk:grid-cols-[202px_minmax(0,1fr)_minmax(80px,auto)]"
          />
        );
      }}
    </QueryCard>
  );
}

// --- Valuable drops ---------------------------------------------------------------

function DropsCard({
  minValue,
  onMinValueChange,
}: {
  minValue: MinValueKey;
  onMinValueChange: (value: MinValueKey) => void;
}) {
  const scope = useAccountScope();
  const format = useFormat();
  const desktop = useIsDesktop();
  const accounts = useAccounts().data?.accounts;
  const colors = useMemo(() => accountColors(accounts ?? []), [accounts]);
  const drops = useDrops(scope, { minValue: MIN_VALUE_GP[minValue], limit: DROPS_PAGE_SIZE });
  const items = drops.data?.pages.flatMap((page) => page.items);
  // The empty text follows the list on screen, which is the previous filter while a new one loads.
  const shownMinValue = useParamsOfData(drops, minValue);

  const accountLabel = (accountId: number) => {
    if (scope !== 'all' || !accounts) return undefined;
    return {
      name: accountNameById(accountId, accounts),
      color: colors.get(accountId) ?? 'var(--afk)',
    };
  };

  let body;
  if (items !== undefined) {
    body =
      items.length === 0 ? (
        <EmptyState className="min-h-[240px]">
          No drops worth {formatCompact(MIN_VALUE_GP[shownMinValue])}+ gp yet.
        </EmptyState>
      ) : (
        <>
          <ul aria-label="Valuable drops" className="m-0 list-none p-0">
            {items.map((drop, index) => {
              const account = accountLabel(drop.accountId);
              // PC: "Mon 16 Nov, 22:39"; mobile: the date only.
              const when = desktop
                ? `${format.date(drop.occurredAt)}, ${format.clock(drop.occurredAt)}`
                : format.date(drop.occurredAt);
              return (
                <ItemRow
                  // Pages only append, and one event can hold the same item twice.
                  key={`${String(drop.lootEventId)}:${String(index)}`}
                  itemId={drop.itemId}
                  itemName={drop.name}
                  name={`${drop.name}${drop.quantity > 1 ? ` × ${formatInt(drop.quantity)}` : ''}`}
                  detail={
                    <>
                      <span className="truncate">
                        {sourceLabel(drop.source)} · {when}
                      </span>
                      {account && (
                        <>
                          <span aria-hidden="true">·</span>
                          <AccountDot color={account.color} />
                          <span className="truncate">{account.name}</span>
                        </>
                      )}
                    </>
                  }
                  value={<Gp value={drop.geValue} unit={desktop} />}
                  className="max-desk:min-h-12 max-desk:py-1.5"
                />
              );
            })}
          </ul>
          {drops.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                disabled={drops.isFetchingNextPage}
                onClick={() => void drops.fetchNextPage()}
              >
                {drops.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
          {drops.isFetchNextPageError && (
            <ErrorState className="min-h-0" onRetry={() => void drops.fetchNextPage()} />
          )}
        </>
      );
  } else if (drops.isError) {
    body = <ErrorState onRetry={() => void drops.refetch()} />;
  } else {
    body = <CardSkeleton lines={6} />;
  }

  const filter = (
    <SegmentedFilter
      label="Minimum value"
      options={MIN_VALUE_OPTIONS}
      value={minValue}
      onChange={onMinValueChange}
      block={!desktop}
    />
  );
  return (
    <Card>
      {/* PC: "All time" after the title and the filter on the right. Mobile
          (`MobileProgressLoot`): "All time" on the right, the filter in its own row. */}
      <CardHeader
        title={
          <span className="flex items-baseline gap-2.5">
            Valuable drops
            {desktop && <span className="text-xs font-normal text-text-3">All time</span>}
          </span>
        }
        action={desktop ? filter : <span className="text-xs text-text-3">All time</span>}
      />
      {!desktop && <div className="mb-3.5">{filter}</div>}
      {body}
    </Card>
  );
}

// --- Page -------------------------------------------------------------------------

export function LootPage() {
  const scope = useAccountScope();
  const format = useFormat();
  const [params, setParams] = useSearchParams();
  const range = parseLootRange(params.get('range'));
  const minValue = parseMinValue(params.get('min'));

  // The start moves once per local day, so the query key stays stable in between.
  const today = useLocalToday(format.timeZone);
  const days = RANGE_DAYS[range];
  const from = useMemo(
    () => (days === null ? undefined : lastDaysFrom(days, today, format.timeZone)),
    [days, today, format.timeZone],
  );
  const loot = useLoot(scope, { groupBy: 'source', ...(from ? { from } : {}) });
  // Labels follow the data on screen, which is the previous range while a new one loads.
  const shown = useParamsOfData(loot, { scope, range });

  const update = (key: string, value: string, replace: boolean) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(key, value);
        return next;
      },
      { replace },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <PageControls>
        <SegmentedFilter
          block
          label="Period"
          options={RANGE_OPTIONS}
          value={range}
          onChange={(next) => {
            update('range', next, false);
          }}
        />
      </PageControls>
      <LootStrip loot={loot} range={shown.range} />
      {/* Side by side on PC (`ProgressLoot`), wrapping under each other when there isn't room. */}
      <div className="flex flex-wrap items-start gap-5 [&>*]:min-w-0">
        {/* Remounts (back to 8 sources) when data for a new range or account arrives. */}
        <div className="flex-[1_1_400px]">
          <SourcesCard
            key={`${String(shown.scope)}:${shown.range}`}
            loot={loot}
            range={shown.range}
          />
        </div>
        <div className="flex-[1.3_1_480px]">
          <DropsCard
            minValue={minValue}
            onMinValueChange={(next) => {
              update('min', next, true);
            }}
          />
        </div>
      </div>
    </div>
  );
}
