import type {
  AccountBank,
  AccountPotionStorage,
  AccountScope,
  BankResponse,
  PotionStorageResponse,
} from '@fireside/shared';
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useAccounts, useBank, usePotionStorage, usePriceMovers } from '@/api/hooks';
import { AccountCards, type AccountCard } from '@/components/AccountCards';
import { Card } from '@/components/Card';
import { TooltipRow as Row } from '@/components/TooltipRow';
import { SegmentedFilter } from '@/components/Segmented';
import { PageControls } from '@/components/shell/PageControls';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { StatStrip } from '@/components/StatStrip';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCompact, formatGp, formatGpExact, formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { accountCardInfo } from '@/lib/accounts';
import {
  bankHref,
  bankSections,
  hasTabs,
  netWorth,
  bankSectionsFor,
  parseBankSection,
  moverParam,
  moverPeriodOf,
  moversForTab,
  parseHistoryRange,
  parseTab,
  parseValueMode,
  sectionParam,
  sumNetWorth,
  tabParam,
  VALUE_MODE_LABEL,
  type BankSectionChoice,
  type HistoryRange,
  type NetWorth,
  type TabChoice,
  type ValueMode,
} from '@/lib/bank';
import { useAccountScope } from '@/routing/useAccountScope';
import { BankCard } from './bank/BankCard';
import { CarriedCard, PotionStorageCard } from './bank/CarriedCards';
import {
  ByTabCard,
  MostValuableCard,
  PriceMoversCard,
  RankingsCard,
  ValueOverTimeCard,
  type PriceMoversView,
} from './bank/SideCards';

// Bank: `/:acc/bank?value=ge|ha&tab=main|1…9
// &range=30d|90d|1y&q=&view=list&placeholders=off&section=carried|potions|value
// &movers=24h|7d|30d&top=valuable` (the last two for Price movers, which
// follow `tab` like Most valuable). For one
// account a row with net worth large and three numbers, then three columns on PC: the bank 1:1 with
// the game; what was carried and potion storage; value over time, value by tab
// and the most valuable stacks. On mobile one section at a time (`?section=`,
// ignored on PC). For `all`: three numbers and the chart summed, and one card
// per account. Nothing polls: a bank changes only when it is closed in the
// game. The page exists only once an account has bank data (`requires` in the
// registry).

const VALUE_OPTIONS = [
  { value: 'ge', label: 'GE' },
  { value: 'ha', label: 'HA' },
] as const satisfies readonly { value: ValueMode; label: string }[];

const SECTION_OPTIONS = [
  { value: 'bank', label: 'Bank' },
  { value: 'carried', label: 'Carried' },
  { value: 'potions', label: 'Potions' },
  { value: 'value', label: 'Value' },
] as const satisfies readonly { value: BankSectionChoice; label: string }[];

/** Whether the account's latest potion storage has any potions (the card and sub-tab need some). */
function hasPotions(potions: AccountPotionStorage | undefined): potions is AccountPotionStorage {
  return potions !== undefined && potions.potions.length > 0;
}

/** One account's latest snapshots. Either may be missing. */
interface AccountData {
  accountId: number;
  bank: AccountBank | undefined;
  potions: AccountPotionStorage | undefined;
}

/** The accounts that have a bank or potion storage, by account ID. */
function accountData(bank: BankResponse, potions: PotionStorageResponse): AccountData[] {
  const ids = new Set([
    ...bank.banks.map((entry) => entry.accountId),
    ...potions.storages.map((entry) => entry.accountId),
  ]);
  return [...ids]
    .sort((a, b) => a - b)
    .map((accountId) => ({
      accountId,
      bank: bank.banks.find((entry) => entry.accountId === accountId),
      potions: potions.storages.find((entry) => entry.accountId === accountId),
    }));
}

/** The newest snapshot of an account, bank or potion storage. */
function updatedAt({ bank, potions }: AccountData): string {
  return (
    [bank?.takenAt, potions?.takenAt]
      .filter((at) => at !== undefined)
      .sort()
      .at(-1) ?? ''
  );
}

function cashOf(data: readonly AccountData[]): number {
  return data.reduce((sum, entry) => sum + (entry.bank?.totals.cashValue ?? 0), 0);
}

/** The parts of a net worth, exact, for a tooltip. */
function WorthParts({ worth }: { worth: NetWorth }) {
  return (
    <>
      <Row strong label="Bank" value={formatGpExact(worth.bank)} />
      <Row strong label="Potion storage" value={formatGpExact(worth.potionStorage)} />
      <Row strong label="Carried" value={formatGpExact(worth.carried)} />
    </>
  );
}

/** A number with details on hover or focus. */
function WithDetail({ children, detail }: { children: ReactNode; detail: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default rounded-sm">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

// --- The numbers at the top ---------------------------------------------------

function NetWorthDetail({
  worth,
  mode,
  pricesFetchedAt,
}: {
  worth: NetWorth;
  mode: ValueMode;
  pricesFetchedAt: string | null;
}) {
  const format = useFormat();
  return (
    <>
      <WorthParts worth={worth} />
      {mode === 'ge' && pricesFetchedAt !== null && (
        <div className="text-text-3">
          Current GE prices · fetched {format.relative(pricesFetchedAt)}
        </div>
      )}
    </>
  );
}

function CashDetail({ cash }: { cash: number }) {
  return (
    <>
      <div className="font-semibold tabular-nums">{formatGpExact(cash)}</div>
      <div className="text-text-3">
        Coins + platinum tokens × 1,000
        <br />
        in the bank and the inventory
      </div>
    </>
  );
}

/**
 * GE | HA in the row at the top of one account's bank. It stands there from the
 * first render, also while loading, so it never moves from the top bar into the
 * row when the data arrives.
 */
function ValueToggle({ mode, onMode }: { mode: ValueMode; onMode: (mode: ValueMode) => void }) {
  return (
    <SegmentedFilter
      options={VALUE_OPTIONS}
      value={mode}
      onChange={onMode}
      label="Value"
      itemClassName="max-desk:min-w-11 max-desk:px-2.5 max-desk:text-sm desk:px-3.5 desk:text-sm"
    />
  );
}

/** A small number on the right of the net worth (PC): label above, 22 px value. */
function SmallNumber({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-text-3">{label}</span>
      <span className="font-display text-tile font-semibold whitespace-nowrap tabular-nums">
        {children}
      </span>
    </div>
  );
}

/** Net worth large with its age (left of the row at the top). */
function HeroWorth({
  data,
  mode,
  pricesFetchedAt,
}: {
  data: AccountData;
  mode: ValueMode;
  pricesFetchedAt: string | null;
}) {
  const format = useFormat();
  const worth = netWorth(data.bank, data.potions, mode);
  const cash = cashOf([data]);
  const newest = updatedAt(data);
  return (
    <div className="flex min-w-0 flex-col gap-[3px] desk:gap-1">
      <span className="text-axis tracking-[0.05em] text-text-3 uppercase desk:text-xs">
        Net worth · {VALUE_MODE_LABEL[mode]}
      </span>
      <span className="font-display text-[38px] leading-none font-semibold tracking-[-0.02em] whitespace-nowrap tabular-nums desk:text-[48px]">
        <WithDetail
          detail={<NetWorthDetail worth={worth} mode={mode} pricesFetchedAt={pricesFetchedAt} />}
        >
          {formatCompact(worth.total)}
        </WithDetail>
        <span className="ml-2 text-[17px] text-text-2 desk:text-tile">gp</span>
      </span>
      {newest !== '' && (
        <>
          <span className="text-xs text-text-3 desk:hidden">
            Cash {formatCompact(cash)} · updated {format.dateTime(newest)}
          </span>
          <span className="text-table text-text-3 max-desk:hidden">
            Updated {format.date(newest)}, {format.clock(newest)} · when the bank was last closed
          </span>
        </>
      )}
    </div>
  );
}

/** Carried, Bank + potions and Cash at 22 px (PC, right of the net worth). */
function HeroParts({ data, mode }: { data: AccountData; mode: ValueMode }) {
  const worth = netWorth(data.bank, data.potions, mode);
  const cash = cashOf([data]);
  return (
    <div className="contents max-desk:hidden">
      <SmallNumber label="Carried">
        <WithDetail
          detail={
            <>
              <Row strong label="Inventory" value={formatGpExact(worth.inventory)} />
              <Row strong label="Equipment" value={formatGpExact(worth.equipment)} />
              <div className="text-text-3">When the bank was last closed</div>
            </>
          }
        >
          {formatGp(worth.carried)}
        </WithDetail>
      </SmallNumber>
      <SmallNumber label="Bank + potions">
        <WithDetail
          detail={
            <>
              <Row strong label="Bank" value={formatGpExact(worth.bank)} />
              <Row strong label="Potion storage" value={formatGpExact(worth.potionStorage)} />
            </>
          }
        >
          {formatGp(worth.bank + worth.potionStorage)}
        </WithDetail>
      </SmallNumber>
      <SmallNumber label="Cash">
        <WithDetail detail={<CashDetail cash={cash} />}>{formatGp(cash)}</WithDetail>
      </SmallNumber>
    </div>
  );
}

/**
 * The row at the top of one account's bank: net worth large with its age, and
 * on PC Carried, Bank + potions and Cash at 22 px next to GE | HA. The page
 * title stays above it. `data` is `undefined` while loading:
 * skeletons, with GE | HA already in place, so the toggle is the same element
 * before and after the data arrives (it never moves, and keeps focus).
 */
function BankHero({
  data,
  mode,
  onMode,
  pricesFetchedAt,
}: {
  data: AccountData | undefined;
  mode: ValueMode;
  onMode: (mode: ValueMode) => void;
  pricesFetchedAt: string | null;
}) {
  return (
    <section
      aria-label="Bank summary"
      aria-busy={data === undefined ? true : undefined}
      className="flex items-end justify-between gap-3 px-0.5 desk:flex-wrap desk:gap-x-10 desk:gap-y-4 desk:px-0"
    >
      {data ? (
        <HeroWorth data={data} mode={mode} pricesFetchedAt={pricesFetchedAt} />
      ) : (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-[38px] w-48 desk:h-12 desk:w-56" />
          <Skeleton className="h-3 w-40" />
        </div>
      )}
      <div className="flex flex-wrap items-end gap-x-9 gap-y-3">
        {data && <HeroParts data={data} mode={mode} />}
        <ValueToggle mode={mode} onMode={onMode} />
      </div>
    </section>
  );
}

/** All accounts: net worth, cash and how many accounts have a bank. */
function AllStrip({
  data,
  mode,
  pricesFetchedAt,
}: {
  data: readonly AccountData[];
  mode: ValueMode;
  pricesFetchedAt: string | null;
}) {
  const worth = sumNetWorth(data.map((entry) => netWorth(entry.bank, entry.potions, mode)));
  const cash = cashOf(data);
  return (
    <StatStrip
      label="Bank summary"
      items={[
        {
          key: 'worth',
          value: (
            <WithDetail
              detail={
                <NetWorthDetail worth={worth} mode={mode} pricesFetchedAt={pricesFetchedAt} />
              }
            >
              {formatCompact(worth.total)}
            </WithDetail>
          ),
          unit: 'gp',
          label: `net worth · all accounts, ${VALUE_MODE_LABEL[mode]}`,
          shortLabel: `net worth · ${VALUE_MODE_LABEL[mode]}`,
        },
        {
          key: 'cash',
          value: <WithDetail detail={<CashDetail cash={cash} />}>{formatCompact(cash)}</WithDetail>,
          unit: 'gp',
          label: 'cash',
        },
        {
          key: 'accounts',
          value: formatInt(data.length),
          label: data.length === 1 ? 'account with a bank' : 'accounts with a bank',
          shortLabel: 'accounts',
        },
      ]}
    />
  );
}

// --- One account --------------------------------------------------------------

interface ViewParams {
  mode: ValueMode;
  range: HistoryRange;
  onRange: (range: HistoryRange) => void;
}

/**
 * A column on PC (`wide:`). It scrolls with the page like the others: a
 * column that stuck while its neighbour scrolled looked broken (only the
 * Sessions pane sticks).
 */
function SideColumn({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-5">{children}</div>;
}

function AccountView({
  scope,
  data,
  mode,
  range,
  onRange,
  currentPrices,
}: ViewParams & {
  scope: number;
  data: AccountData;
  /** The server values the bank at current GE prices: only then can it have price movers. */
  currentPrices: boolean;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const desktop = useIsDesktop();
  const { bank, potions } = data;
  // Price movers are changes in GE prices, so HA values never show them.
  const priceMovers = usePriceMovers(scope, { enabled: currentPrices && mode === 'ge' });
  // Kept between renders, so the grid is not drawn again on every keystroke in the search.
  const sections = useMemo(() => (bank ? bankSections(bank) : []), [bank]);
  const tab = parseTab(searchParams.get('tab'), sections);
  const query = searchParams.get('q') ?? '';
  const asList = searchParams.get('view') === 'list';
  const showPlaceholders = searchParams.get('placeholders') !== 'off';
  const withPotions = hasPotions(potions);
  // Bank and Carried need a bank snapshot, Potions a potion storage with potions.
  const available = bankSectionsFor(bank !== undefined, withPotions);
  const section = parseBankSection(searchParams.get('section'), available);
  // "Show all" of the bank and of potion storage live here, not in the cards:
  // the mobile and PC layouts are different trees, and crossing 861 px (a
  // tablet turned) must not fold them again. The view is keyed by account,
  // so another account starts folded.
  const [bankExpanded, setBankExpanded] = useState(false);
  const [potionsExpanded, setPotionsExpanded] = useState(false);
  const [moversExpanded, setMoversExpanded] = useState(false);
  // Price movers list another set of items per tab, so any change of tab (the
  // buttons, "By tab" or back/forward) folds them again. Reset while
  // rendering, as React advises for state that follows a prop:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [moversTab, setMoversTab] = useState(tab);
  if (moversTab !== tab) {
    setMoversTab(tab);
    setMoversExpanded(false);
  }

  const update = (changes: Record<string, string | null>, replace: boolean) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [name, value] of Object.entries(changes)) {
          if (value === null) next.delete(name);
          else next.set(name, value);
        }
        // Choosing a tab leaves the search, as the tab buttons are hidden while searching.
        if ('tab' in changes) next.delete('q');
        return next;
      },
      { replace },
    );
  };
  // A new tab goes in the history; search and switches replace the URL.
  const onTab = (next: TabChoice) => {
    update({ tab: tabParam(next) }, false);
  };
  // On mobile "By tab" sits under Value: a row opens the tab in the bank, one step in the history.
  const onTabFromValue = (next: TabChoice) => {
    update({ tab: tabParam(next), section: null }, false);
  };

  const bankCard = bank && (
    <BankCard
      sections={sections}
      mode={mode}
      tab={tab}
      onTab={onTab}
      query={query}
      onQuery={(value) => {
        update({ q: value === '' ? null : value }, true);
      }}
      showPlaceholders={showPlaceholders}
      onShowPlaceholders={(show) => {
        update({ placeholders: show ? null : 'off' }, true);
      }}
      asList={asList}
      onAsList={(list) => {
        update({ view: list ? 'list' : null }, true);
      }}
      expanded={bankExpanded}
      onExpanded={setBankExpanded}
    />
  );
  const carried = bank && <CarriedCard bank={bank} mode={mode} />;
  const potionCard = withPotions && (
    <PotionStorageCard
      storage={potions}
      mode={mode}
      expanded={potionsExpanded}
      onExpanded={setPotionsExpanded}
    />
  );
  // Price movers: only with price history for at least one period. While
  // loading, on an error, in HA and with the price source off there is no trace
  // of them: the card is "Most valuable" alone, without any message.
  const moverPeriods = mode === 'ge' && currentPrices ? (priceMovers.data?.periods ?? []) : [];
  const moverPeriod = moverPeriodOf(searchParams.get('movers'), moverPeriods);
  // The API sums everything held; a chosen tab narrows it to that tab's items.
  const shownMovers = useMemo(
    () => moverPeriod && moversForTab(moverPeriod, sections, tab),
    [moverPeriod, sections, tab],
  );
  const movers: PriceMoversView | undefined = shownMovers && {
    periods: moverPeriods,
    shown: shownMovers,
    tab,
    showScope: hasTabs(sections),
    // A period is a view choice: it replaces the URL, like a switch.
    onPeriod: (next) => {
      update({ movers: moverParam(next, moverPeriods) }, true);
    },
    expanded: moversExpanded,
    onExpanded: setMoversExpanded,
  };
  const valuable = { sections, mode, tab, showScope: hasTabs(sections) };
  const value = (
    <>
      <ValueOverTimeCard scope={scope} mode={mode} range={range} onRange={onRange} />
      {/* Mobile: its own card under the chart. */}
      {!desktop && movers && <PriceMoversCard view={movers} />}
      {hasTabs(sections) && (
        <ByTabCard sections={sections} mode={mode} tab={tab} onTab={onTabFromValue} />
      )}
      {bank &&
        (desktop ? (
          <RankingsCard
            {...valuable}
            movers={movers}
            choice={searchParams.get('top') === 'valuable' ? 'valuable' : 'movers'}
            onChoice={(next) => {
              update({ top: next === 'valuable' ? next : null }, true);
            }}
          />
        ) : (
          <MostValuableCard {...valuable} />
        ))}
    </>
  );

  if (!desktop) {
    const options = SECTION_OPTIONS.filter((option) => available.includes(option.value));
    return (
      <>
        <SegmentedFilter
          block
          label="Bank sections"
          options={options}
          value={section}
          // A section is a view choice: one step in the history, like a tab.
          onChange={(next) => {
            update({ section: sectionParam(next, available) }, false);
          }}
        />
        {section === 'bank' && bankCard}
        {section === 'carried' && carried}
        {section === 'potions' && potionCard}
        {section === 'value' && value}
      </>
    );
  }

  return (
    // PC from `wide:`: bank | carried and potions | value. Below that one column in the same order.
    <div className="grid items-start gap-5 wide:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="min-w-0">{bankCard}</div>
      {(bank !== undefined || withPotions) && (
        <SideColumn>
          {carried}
          {potionCard}
        </SideColumn>
      )}
      <SideColumn>{value}</SideColumn>
    </div>
  );
}

// --- All accounts ---------------------------------------------------------------

function AllAccountsView({
  data,
  mode,
  range,
  onRange,
}: ViewParams & { data: readonly AccountData[] }) {
  const format = useFormat();
  const accounts = useAccounts().data?.accounts ?? [];
  // The card keeps GE | HA for the account it opens.
  const search = mode === 'ha' ? `?value=${mode}` : '';

  const cards: AccountCard[] = data.map((entry) => {
    const worth = netWorth(entry.bank, entry.potions, mode);
    return {
      ...accountCardInfo(entry.accountId, accounts),
      to: `${bankHref(entry.accountId)}${search}`,
      stats: [
        {
          key: 'worth',
          value: (
            <WithDetail detail={<WorthParts worth={worth} />}>{formatGp(worth.total)}</WithDetail>
          ),
          label: 'net worth',
        },
        {
          key: 'cash',
          value: formatGp(entry.bank?.totals.cashValue ?? 0),
          label: `cash · updated ${format.relative(updatedAt(entry))}`,
        },
      ],
    };
  });

  return (
    <>
      <ValueOverTimeCard scope="all" mode={mode} range={range} onRange={onRange} />
      <AccountCards
        cards={cards}
        size="lg"
        label="Net worth per account"
        note="Net worth is bank + potion storage + carried. A bank belongs to one account. Pick an account to see its tabs and items."
      />
    </>
  );
}

// --- Page ---------------------------------------------------------------------

/** All accounts while loading; one account has the row at the top with skeletons (`BankHero`). */
function Loading() {
  return (
    <>
      <StatStrip items={undefined} label="Bank summary" skeletonCount={3} />
      <Card>
        <CardSkeleton lines={8} />
      </Card>
    </>
  );
}

export function BankPage() {
  const scope: AccountScope = useAccountScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const bank = useBank(scope);
  const potions = usePotionStorage(scope);

  const mode = parseValueMode(searchParams.get('value'));
  // Missing or invalid: one year.
  const range = parseHistoryRange(searchParams.get('range'));

  const setParam = (name: string, value: string | null, replace: boolean) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === null) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace },
    );
  };
  // GE | HA replaces the URL, like a switch.
  const onMode = (next: ValueMode) => {
    setParam('value', next === 'ge' ? null : next, true);
  };
  const view: ViewParams = {
    mode,
    range,
    // A new period goes in the history.
    onRange: (next) => {
      setParam('range', next === '1y' ? null : next, false);
    },
  };

  let body: ReactNode;
  if (bank.data !== undefined && potions.data !== undefined) {
    const data = accountData(bank.data, potions.data);
    const own = scope === 'all' ? undefined : data.find((entry) => entry.accountId === scope);
    const pricesFetchedAt = bank.data.prices.fetchedAt;
    if (data.length === 0 || (scope !== 'all' && own === undefined)) {
      body = (
        <Card>
          <EmptyState>
            Close your bank in the game with the plugin running and it shows up here.
          </EmptyState>
        </Card>
      );
    } else if (own !== undefined && scope !== 'all') {
      body = (
        <>
          <BankHero data={own} mode={mode} onMode={onMode} pricesFetchedAt={pricesFetchedAt} />
          {/* Keyed by account: "Show all" and the list start over for another account. */}
          <AccountView
            key={scope}
            scope={scope}
            data={own}
            currentPrices={bank.data.prices.source === 'CURRENT'}
            {...view}
          />
        </>
      );
    } else {
      body = (
        <>
          <AllStrip data={data} mode={mode} pricesFetchedAt={pricesFetchedAt} />
          <AllAccountsView data={data} {...view} />
        </>
      );
    }
  } else if (bank.isError || potions.isError) {
    body = (
      <Card>
        <ErrorState
          onRetry={() => {
            void bank.refetch();
            void potions.refetch();
          }}
        />
      </Card>
    );
  } else {
    // One account: GE | HA in the row at the top (BankHero) from the first
    // render, the same element once the data is in. All accounts: in the top
    // bar.
    body =
      scope === 'all' ? (
        <Loading />
      ) : (
        <>
          <BankHero data={undefined} mode={mode} onMode={onMode} pricesFetchedAt={null} />
          <Card>
            <CardSkeleton lines={8} />
          </Card>
        </>
      );
  }

  return (
    <div className="flex flex-col gap-4 desk:gap-5">
      {scope === 'all' && (
        <PageControls>
          <SegmentedFilter
            block
            options={VALUE_OPTIONS}
            value={mode}
            onChange={onMode}
            label="Value"
          />
        </PageControls>
      )}
      {body}
    </div>
  );
}
