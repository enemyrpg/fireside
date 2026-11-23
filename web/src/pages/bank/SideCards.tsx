import type {
  AccountScope,
  BankHistoryResponse,
  PriceMoverItem,
  PriceMoverPeriod,
  PriceMoverPeriodResult,
} from '@fireside/shared';
import { useBankHistory } from '@/api/hooks';
import { Card, CardHeader } from '@/components/Card';
import { Gp } from '@/components/Gp';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HBarList } from '@/components/HBarList';
import { ItemIcon } from '@/components/ItemIcon';
import { SegmentedFilter } from '@/components/Segmented';
import { QueryCard } from '@/components/QueryCard';
import { EmptyState } from '@/components/states';
import { TooltipRow } from '@/components/TooltipRow';
import { ValueLine } from '@/components/ValueLine';
import {
  formatBankTab,
  formatCompact,
  formatCount,
  formatGp,
  formatGpExact,
  formatInt,
  formatSignedPercent,
} from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useLocalToday } from '@/hooks/useLocalToday';
import { useParamsOfData } from '@/hooks/useParamsOfData';
import {
  HISTORY_RANGE_DAYS,
  historyPoints,
  MOVER_PERIOD_LABEL,
  MOVER_PERIOD_TEXT,
  moverKey,
  moverRatio,
  MOVERS_SHOWN,
  mostValuable,
  splitMovers,
  sectionsOf,
  valueOf,
  VALUE_MODE_LABEL,
  type BankSection,
  type HistoryRange,
  type TabChoice,
  type ValueMode,
} from '@/lib/bank';
import { lastDaysRange } from '@/lib/time';

// The right column of the Bank page on PC, and the Value section on mobile:
// value over time, value by tab, price movers and the most valuable stacks.

const RANGE_OPTIONS = [
  { value: '30d', label: '30 d' },
  { value: '90d', label: '90 d' },
  { value: '1y', label: '1 y' },
] as const satisfies readonly { value: HistoryRange; label: string }[];

const RANGE_TEXT: Record<HistoryRange, string> = {
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  '1y': 'last year',
};

/** Small text next to a card title. */
function Subtitle({ children }: { children: string }) {
  return <span className="ml-1.5 text-xs font-normal text-text-3">{children}</span>;
}

/** Net worth (bank + potion storage + carried) per day, in GE or HA. */
export function ValueOverTimeCard({
  scope,
  mode,
  range,
  onRange,
}: {
  scope: AccountScope;
  mode: ValueMode;
  range: HistoryRange;
  onRange: (range: HistoryRange) => void;
}) {
  const format = useFormat();
  const today = useLocalToday(format.timeZone);
  // One year is the API's own default (a rolling year), so it takes no range.
  const params =
    range === '1y' ? {} : lastDaysRange(HISTORY_RANGE_DAYS[range], today, format.timeZone);
  const query = useBankHistory(scope, params);
  // The label follows the data on screen, not the URL, while a new range loads.
  const shown = useParamsOfData(query, range);
  const label = VALUE_MODE_LABEL[mode];

  return (
    <QueryCard<BankHistoryResponse>
      query={query}
      title={
        <>
          Value over time{' '}
          <Subtitle>
            {scope === 'all' ? `All accounts · net worth · ${label}` : `Net worth · ${label}`}
          </Subtitle>
        </>
      }
      action={
        <SegmentedFilter
          options={RANGE_OPTIONS}
          value={range}
          onChange={onRange}
          label="Period"
          className="desk:bg-page"
          itemClassName="desk:h-[26px] desk:px-2.5 desk:text-xs"
        />
      }
      skeletonLines={6}
    >
      {(data) => {
        const points = historyPoints(data.days, mode);
        if (points.length === 0) {
          return <EmptyState>Your net worth over time shows up here.</EmptyState>;
        }
        return (
          // All accounts: the card is full width, the chart at most 760 px.
          <div className={scope === 'all' ? 'max-w-[760px]' : undefined}>
            <ValueLine
              points={points}
              dateOf={(point) => point.date}
              valueOf={(point) => point.value}
              label={`Net worth over time (${label}), ${RANGE_TEXT[shown]}`}
              height={scope === 'all' ? 220 : 180}
              tooltip={(point) => (
                <>
                  <TooltipRow label="Net worth" value={formatGp(point.value)} />
                  <TooltipRow label="Bank" value={formatGp(point.bank)} />
                  <TooltipRow label="Potion storage" value={formatGp(point.potionStorage)} />
                  <TooltipRow label="Carried" value={formatGp(point.carried)} />
                  <TooltipRow label="Cash" value={formatGp(point.cash)} />
                </>
              )}
            />
          </div>
        );
      }}
    </QueryCard>
  );
}

/** Value per tab in the bank's own order. A row chooses the tab, like the tab buttons. */
export function ByTabCard({
  sections,
  mode,
  tab,
  onTab,
}: {
  sections: readonly BankSection[];
  mode: ValueMode;
  tab: TabChoice;
  onTab: (tab: TabChoice) => void;
}) {
  return (
    <Card>
      <CardHeader
        title={
          <>
            By tab <Subtitle>{VALUE_MODE_LABEL[mode]}</Subtitle>
          </>
        }
        action={
          <span className="text-xs text-text-3">
            <span className="desk:hidden">Tap</span>
            <span className="max-desk:hidden">Click</span> a tab to open it
          </span>
        }
      />
      <HBarList
        label="Value by tab"
        // Every tab: the list chooses the tab shown in the bank.
        limit={false}
        rows={sections.map((section) => ({
          key: String(section.tab),
          label: formatBankTab(section.tab),
          value: valueOf(section, mode),
          detail: <div>{formatCount(section.itemCount, 'item')}</div>,
        }))}
        format={formatGp}
        formatExact={formatGpExact}
        selectedKey={tab === 'all' ? undefined : String(tab)}
        // A second click on the chosen tab goes back to All.
        onSelect={(key) => {
          onTab(String(tab) === key ? 'all' : Number(key));
        }}
        className="grid-cols-[64px_minmax(0,1fr)_auto] desk:grid-cols-[64px_minmax(0,1fr)_minmax(84px,auto)]"
      />
    </Card>
  );
}

interface MostValuableProps {
  sections: readonly BankSection[];
  mode: ValueMode;
  tab: TabChoice;
  /** Name the tab in the subtitle. Off for a bank without tabs. */
  showScope: boolean;
}

/** The all-scope of Most valuable: the bank's tabs. */
const ALL_TABS = 'All tabs';
/**
 * The all-scope of Price movers: the API's sum also covers inventory,
 * equipment and potion storage, so it is more than "All tabs".
 */
const EVERYTHING_HELD = 'Everything held';

/** "Tab 3 · GE": what a list covers. Only the value mode for a bank without tabs. */
function scopeText(
  allLabel: string,
  { mode, tab, showScope }: { mode: ValueMode; tab: TabChoice; showScope: boolean },
) {
  const label = VALUE_MODE_LABEL[mode];
  return showScope ? `${tab === 'all' ? allLabel : formatBankTab(tab)} · ${label}` : label;
}

const mostValuableScope = (props: Omit<MostValuableProps, 'sections'>) =>
  scopeText(ALL_TABS, props);

/** Price movers are changes in GE prices: always GE. */
const moversScope = (view: PriceMoversView) => scopeText(EVERYTHING_HELD, { ...view, mode: 'ge' });

function MostValuableList({ sections, mode, tab }: Omit<MostValuableProps, 'showScope'>) {
  const items = mostValuable(
    sectionsOf(sections, tab).flatMap((section) => section.items),
    mode,
  );
  if (items.length === 0) return <EmptyState>Nothing of value here yet.</EmptyState>;
  return (
    <ul className="m-0 list-none p-0">
      {items.map((item) => (
        <li
          key={item.position}
          className="flex min-w-0 items-center gap-2.5 border-t border-hover py-[7px] text-table max-desk:min-h-12"
        >
          <ItemIcon itemId={item.itemId} name={item.name} />
          <span className="min-w-0 flex-1 truncate">
            {item.name}
            {item.quantity > 1 && (
              <span className="text-text-3"> × {formatInt(item.quantity)}</span>
            )}
          </span>
          <Gp value={valueOf(item, mode)} className="flex-none tabular-nums" />
        </li>
      ))}
    </ul>
  );
}

/** The most valuable stacks in the chosen tab. */
export function MostValuableCard(props: MostValuableProps) {
  return (
    <Card>
      <CardHeader
        title={
          <>
            Most valuable <Subtitle>{mostValuableScope(props)}</Subtitle>
          </>
        }
      />
      <MostValuableList {...props} />
    </Card>
  );
}

// --- Price movers --------------------------------------------------

/** What the Price movers views need: the period shown and the ones to choose from. */
export interface PriceMoversView {
  /** The periods the server has price history for, shortest first. Never empty. */
  periods: readonly PriceMoverPeriodResult[];
  /** The period shown, narrowed to `tab` (`moversForTab`). */
  shown: PriceMoverPeriodResult;
  /** The bank tab shown, for the subtitle. */
  tab: TabChoice;
  /** Name the tab in the subtitle. Off for a bank without tabs. */
  showScope: boolean;
  onPeriod: (period: PriceMoverPeriod) => void;
  /** "Show all": page state, kept by the page across the PC breakpoint. */
  expanded: boolean;
  onExpanded: (expanded: boolean) => void;
}

/**
 * A change in gp with its direction: ▲ in `--up` or ▼ in `--down`, never the
 * colour alone (3.2: the one place a change is not neutral). The exact amount
 * is in a tooltip for the sum (`focusable`: a tab stop, like `Gp`). A row has
 * it as `title` and for screen readers instead, so a long list is not one tab
 * stop per item.
 */
function Change({
  value,
  focusable = false,
  className,
}: {
  value: number;
  focusable?: boolean;
  className?: string;
}) {
  const up = value > 0;
  const amount = Math.abs(value);
  const exact = value === 0 ? formatGpExact(0) : `${up ? '+' : '−'}${formatGpExact(amount)}`;
  const arrow = value !== 0 && <span aria-hidden="true">{up ? '▲' : '▼'} </span>;
  if (!focusable) {
    return (
      <span title={exact} className={className}>
        {arrow}
        <span aria-hidden="true">{formatCompact(amount)}</span>
        <span className="sr-only">
          {up ? 'Up ' : 'Down '}
          {formatGpExact(amount)}
        </span>
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={className}>
          {arrow}
          {value !== 0 && <span className="sr-only">{up ? 'Up ' : 'Down '}</span>}
          {formatCompact(amount)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{exact}</TooltipContent>
    </Tooltip>
  );
}

/** "Dragon arrowtips × 356", or the doses of a potion in potion storage. */
function MoverName({ item }: { item: PriceMoverItem }) {
  return (
    <>
      {item.name}
      {item.kind === 'POTION' ? (
        <span className="text-text-3"> · {formatCount(item.doses, 'dose')}</span>
      ) : (
        item.quantity > 1 && <span className="text-text-3"> × {formatInt(item.quantity)}</span>
      )}
    </>
  );
}

function MoverList({
  title,
  items,
  desktop,
}: {
  title: string;
  items: readonly PriceMoverItem[];
  desktop: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col">
      <h3 className="m-0 mb-0.5 text-[11px] font-medium tracking-[0.05em] text-text-3 uppercase desk:mb-1 desk:text-xs">
        {title}
      </h3>
      <ul className="m-0 list-none p-0">
        {items.map((item) => {
          const percent = formatSignedPercent(moverRatio(item));
          const change = (
            <Change
              value={item.change}
              className={`flex-none text-right font-semibold whitespace-nowrap tabular-nums ${item.change > 0 ? 'text-up' : 'text-down'}`}
            />
          );
          return desktop ? (
            <li
              key={moverKey(item)}
              className="grid grid-cols-[26px_minmax(0,1fr)_52px_92px] items-center gap-2.5 border-t border-hover py-[7px] text-table"
            >
              <ItemIcon itemId={item.itemId} name={item.name} />
              <span className="min-w-0 truncate">
                <MoverName item={item} />
              </span>
              <span className="text-right text-text-3 tabular-nums">{percent}</span>
              {change}
            </li>
          ) : (
            <li
              key={moverKey(item)}
              className="flex min-h-12 items-center gap-3 border-t border-hover text-table"
            >
              <ItemIcon itemId={item.itemId} name={item.name} size="row" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">
                  <MoverName item={item} />
                </span>
                <span className="text-xs text-text-3 tabular-nums">{percent}</span>
              </span>
              {change}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The sum, "Gained most", "Lost most" and "Show all". */
function PriceMoversBody({ view, desktop }: { view: PriceMoversView; desktop: boolean }) {
  const { shown, expanded, onExpanded } = view;
  const { gained, lost } = splitMovers(shown.items);
  const limit = desktop ? MOVERS_SHOWN.desktop : MOVERS_SHOWN.mobile;
  const more = gained.length > limit || lost.length > limit;
  const cut = (items: PriceMoverItem[]) => (expanded ? items : items.slice(0, limit));
  return (
    <div className="flex flex-col gap-3 desk:gap-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 desk:gap-x-3.5">
        <span className="font-display text-2xl font-semibold whitespace-nowrap tabular-nums desk:text-[26px]">
          <Change value={shown.change} focusable /> gp
        </span>
        <span className="text-xs text-text-3">
          from price changes
          <span className="max-desk:hidden">
            {' '}
            in {MOVER_PERIOD_TEXT[shown.period]} · what you hold now
          </span>
        </span>
      </div>
      {shown.items.length === 0 ? (
        <EmptyState>No price changes for what you hold.</EmptyState>
      ) : (
        <>
          <MoverList title="Gained most" items={cut(gained)} desktop={desktop} />
          <MoverList title="Lost most" items={cut(lost)} desktop={desktop} />
        </>
      )}
      {/* Nothing moved: no list to explain or to show more of. */}
      {shown.items.length > 0 && (desktop || more) && (
        <div className="flex items-baseline justify-between gap-3 text-xs text-text-3">
          <span className="max-desk:hidden">Ranked by gp change for the amount you hold.</span>
          {more && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => {
                onExpanded(!expanded);
              }}
              className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-text hover:underline max-desk:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {expanded ? 'Show fewer' : 'Show all'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MoverPeriods({ view, block = false }: { view: PriceMoversView; block?: boolean }) {
  return (
    <SegmentedFilter
      block={block}
      options={view.periods.map(({ period }) => ({
        value: period,
        label: MOVER_PERIOD_LABEL[period],
      }))}
      value={view.shown.period}
      onChange={view.onPeriod}
      label="Period"
      className="desk:bg-page"
      itemClassName="desk:h-[26px] desk:px-2.5 desk:text-xs"
    />
  );
}

/** Mobile: Price movers as its own card under Value. */
export function PriceMoversCard({ view }: { view: PriceMoversView }) {
  return (
    <Card className="flex flex-col gap-3">
      <CardHeader
        title={
          <>
            Price movers <Subtitle>{moversScope(view)}</Subtitle>
          </>
        }
        className="mb-0"
      />
      {view.periods.length > 1 && <MoverPeriods view={view} block />}
      <PriceMoversBody view={view} desktop={false} />
    </Card>
  );
}

export type RankingChoice = 'movers' | 'valuable';

const RANKING_OPTIONS = [
  { value: 'movers', label: 'Price movers' },
  { value: 'valuable', label: 'Most valuable' },
] as const satisfies readonly { value: RankingChoice; label: string }[];

/**
 * PC: one card shared by Price movers and Most valuable. Without `movers` (no
 * price history, the price source off, or HA values) it is the plain "Most
 * valuable" card.
 */
export function RankingsCard({
  movers,
  choice,
  onChoice,
  ...valuable
}: MostValuableProps & {
  movers: PriceMoversView | undefined;
  choice: RankingChoice;
  onChoice: (choice: RankingChoice) => void;
}) {
  if (movers === undefined) return <MostValuableCard {...valuable} />;
  return (
    <Card className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* The heading of the card, for the page outline and screen readers. */}
        <h2 className="sr-only">{choice === 'movers' ? 'Price movers' : 'Most valuable'}</h2>
        <SegmentedFilter
          options={RANKING_OPTIONS}
          value={choice}
          onChange={onChoice}
          label="Item rankings"
          className="desk:bg-page"
          itemClassName="desk:h-7"
        />
        {choice === 'movers' ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs text-text-3">{moversScope(movers)}</span>
            {movers.periods.length > 1 && <MoverPeriods view={movers} />}
          </div>
        ) : (
          <span className="text-xs text-text-3">{mostValuableScope(valuable)}</span>
        )}
      </div>
      {choice === 'movers' ? (
        <PriceMoversBody view={movers} desktop />
      ) : (
        <MostValuableList {...valuable} />
      )}
    </Card>
  );
}
