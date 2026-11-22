import type {
  CollectionLogItem,
  CollectionLogPage as LogPage,
  CollectionLogResponse,
  CollectionLogStatusResponse,
  CollectionLogTab,
} from '@fireside/shared';
import { CheckIcon } from 'lucide-react';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  hasClogData,
  useAccounts,
  useClogStatuses,
  useCollectionLog,
  useCollectionLogStatus,
  useSyncCollectionLog,
} from '@/api/hooks';
import { AccountCards, type AccountCard } from '@/components/AccountCards';
import { Card } from '@/components/Card';
import { ItemGrid, ItemSlot } from '@/components/ItemGrid';
import { ItemRow } from '@/components/ItemRow';
import { ProgressBar } from '@/components/ProgressBar';
import { SearchField } from '@/components/SearchField';
import { SegmentedTabs } from '@/components/Segmented';
import { PageControls } from '@/components/shell/PageControls';
import { ShowAllButton } from '@/components/ShowAll';
import { CardSkeleton, EmptyMessage, EmptyState, ErrorState } from '@/components/states';
import { StatStrip } from '@/components/StatStrip';
import { SyncNowButton, SyncStatus } from '@/components/SyncStatus';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatInt, formatProgressPercent } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useLocalToday } from '@/hooks/useLocalToday';
import { useViewportRoom } from '@/hooks/useStickyTop';
import { accountCardInfo, accountNameById, SETTINGS_ACCOUNTS_PATH } from '@/lib/accounts';
import {
  CLOG_NEEDS_ACTION,
  clogHref,
  clogSlugs,
  clogStatusText,
  filterPages,
  isClogSyncProblem,
  isPageComplete,
  newItemCounts,
  pageListMaxHeight,
  pagesCompleted,
  recentItems,
  recentItemsShown,
  revealScrollTop,
  selectPage,
  selectTab,
  type DatedItem,
} from '@/lib/clog';
import { cn } from '@/lib/utils';
import { useAccountScope } from '@/routing/useAccountScope';

// Collection log: `/:acc/collections/log?tab=&page=&find=`. Three numbers, the game's
// tabs, and in three columns on PC the page list, the chosen page with what the account
// has and is missing, and the newest items. A collection log belongs to one account, so
// `all` shows one card per account (`ClogAll`). The top bar has the sync state and "Sync
// now". The page exists only once an account has a collection log (`requires` in the
// registry). Only the small status is polled, and only while a sync runs.

/** "712 of 1,568". */
function ofTotal(done: number, total: number): string {
  return `${formatInt(done)} of ${formatInt(total)}`;
}

/** A time with "~" in front when it is the sync that found the item, not the drop. */
function approxDate(date: string, approximate: boolean): string {
  return approximate ? `~${date}` : date;
}

// --- The three numbers --------------------------------------------------------

function ClogStrip({
  log,
  status,
}: {
  log: CollectionLogResponse;
  status: CollectionLogStatusResponse;
}) {
  const format = useFormat();
  const today = useLocalToday(format.timeZone);
  const counts = useMemo(
    () => newItemCounts(log.tabs, today, format.timeZone),
    [log.tabs, today, format.timeZone],
  );
  const pages = useMemo(() => pagesCompleted(log.tabs), [log.tabs]);
  const obtained = log.obtained ?? 0;
  const total = log.total ?? 0;
  // On mobile the top bar has no sync text, so the age goes under the first number.
  const synced = status.sync?.lastSuccessAt ?? status.updatedAt;
  return (
    <StatStrip
      label="Collection log summary"
      mobileColumns={2}
      items={[
        {
          key: 'slots',
          value: formatInt(obtained),
          label: `of ${formatInt(total)} slots`,
          shortLabel:
            synced === null
              ? `of ${formatInt(total)} slots`
              : `of ${formatInt(total)} slots · synced ${format.relative(synced)}`,
        },
        {
          key: 'new',
          value: formatInt(counts.month),
          label: `new this month · ${formatInt(counts.week)} this week`,
          shortLabel: 'new this month',
        },
        {
          key: 'pages',
          value: (
            <>
              <span className="desk:hidden">{ofTotal(pages.completed, pages.total)}</span>
              <span className="max-desk:hidden">{formatInt(pages.completed)}</span>
            </>
          ),
          label: `of ${formatInt(pages.total)} pages completed`,
          shortLabel: 'pages completed',
        },
      ]}
      trailing={
        <div className="flex flex-col gap-1.5">
          <ProgressBar
            value={obtained}
            max={total}
            label={`${ofTotal(obtained, total)} slots`}
            className="h-2"
          />
          <span className="text-xs text-text-3 max-desk:hidden">
            {formatProgressPercent(obtained, total)} complete
          </span>
        </div>
      }
    />
  );
}

// --- Tabs, the page list and the chosen page -----------------------------------

interface PageListProps {
  accountId: number;
  tab: CollectionLogTab;
  /** The tab's slug in the URL. */
  tabSlug: string;
  chosen: LogPage;
}

/** Link to a page of the tab, keeping `find` when asked to. */
function usePageHref({ accountId, tab, tabSlug }: Omit<PageListProps, 'chosen'>) {
  // What stands in `?page=` per page: unique, also for names that look alike.
  const slugs = useMemo(() => clogSlugs(tab.pages), [tab.pages]);
  const hrefOf = (page: LogPage, keep: { find?: string } = {}) =>
    clogHref(accountId, { tab: tabSlug, page: slugs.get(page), ...keep });
  return { slugs, hrefOf };
}

/**
 * PC: a filter and every page of the tab with its count. The one list on the
 * site that scrolls inside its card: the card is at most 600 px, or the room under
 * the top bar when that is less (`pageListMaxHeight`). It scrolls with the page;
 * only its list scrolls inside it.
 */
function PageListCard({
  find,
  onFind,
  ...props
}: PageListProps & {
  /** The filter of the names (`?find=`). */
  find: string;
  onFind: (find: string) => void;
}) {
  const { tab, chosen } = props;
  const { slugs, hrefOf } = usePageHref(props);
  const room = useViewportRoom();
  const pages = useMemo(() => filterPages(tab.pages, find), [tab.pages, find]);
  const list = useRef<HTMLElement>(null);
  const current = useRef<HTMLAnchorElement>(null);
  // Whether the chosen page was in view when the list last moved.
  const inView = useRef(true);

  // The list scrolls on its own, so the chosen page is brought into view when
  // the tab, the page or what the list shows changes. When the list changes
  // height it is brought back only if it was in view: someone who has
  // scrolled away to browse keeps their place. Only the list is scrolled,
  // never the window.
  useLayoutEffect(() => {
    const view = list.current;
    if (view === null) return;
    const place = () => {
      const link = current.current;
      if (link === null) return null;
      const linkTop = link.getBoundingClientRect().top - view.getBoundingClientRect().top;
      return { top: linkTop + view.scrollTop, height: link.getBoundingClientRect().height };
    };
    const reveal = () => {
      const link = place();
      if (link !== null) {
        view.scrollTop = revealScrollTop(view.scrollTop, view.clientHeight, link.top, link.height);
      }
      inView.current = true;
    };
    const onScroll = () => {
      const link = place();
      inView.current =
        link === null ||
        revealScrollTop(view.scrollTop, view.clientHeight, link.top, link.height) ===
          view.scrollTop;
    };
    reveal();
    view.addEventListener('scroll', onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (inView.current) reveal();
          });
    observer?.observe(view);
    return () => {
      view.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [tab.name, chosen.name, pages]);

  return (
    <Card
      style={{ maxHeight: room === undefined ? undefined : pageListMaxHeight(room) }}
      className="flex min-h-0 flex-col gap-3.5 self-start max-desk:hidden"
    >
      <h2 className="m-0 text-[15px] font-semibold">
        Pages{' '}
        <span className="text-xs font-normal text-text-3">
          {formatInt(tab.pages.length)} in {tab.name}
        </span>
      </h2>
      <SearchField query={find} onQuery={onFind} label="Find a page" className="flex-none" />
      <nav
        ref={list}
        aria-label={`${tab.name} pages`}
        className="-mr-2 min-h-0 flex-auto overflow-y-auto pr-2"
      >
        {pages.length === 0 ? (
          <p role="status" className="m-0 px-2.5 py-2 text-table text-text-3">
            No pages match “{find.trim()}”.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {pages.map((page) => {
              const complete = isPageComplete(page);
              const isCurrent = page === chosen;
              return (
                <li key={slugs.get(page)}>
                  <Link
                    ref={isCurrent ? current : undefined}
                    to={hrefOf(page, { find })}
                    aria-current={isCurrent ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-lg px-2.5 py-2 no-underline hover:bg-raised hover:no-underline',
                      isCurrent
                        ? 'bg-accent-wash font-semibold text-accent-text hover:bg-accent-wash hover:text-accent-text'
                        : complete
                          ? 'text-accent-text hover:text-accent-text'
                          : 'text-text-2 hover:text-text',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{page.name}</span>
                    {complete && <CheckIcon aria-label="Completed" className="size-3.5 shrink-0" />}
                    <span
                      className={cn(
                        'tabular-nums',
                        complete || isCurrent ? 'text-accent-text' : 'text-text-3',
                      )}
                    >
                      {page.obtained}/{page.total}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </Card>
  );
}

/** Mobile: every page of the tab as a select above the grid. */
function MobilePagePicker(props: PageListProps) {
  const navigate = useNavigate();
  const { tab, chosen } = props;
  const { slugs, hrefOf } = usePageHref(props);
  return (
    <div className="desk:hidden">
      <Select
        value={slugs.get(chosen) ?? ''}
        onValueChange={(value) => {
          const page = tab.pages.find((entry) => slugs.get(entry) === value);
          if (page) void navigate(hrefOf(page));
        }}
      >
        <SelectTrigger
          aria-label="Page"
          className="h-11 w-full rounded-[10px] border-border bg-card px-3.5 data-[size=default]:h-11"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {tab.pages.map((page) => (
            <SelectItem key={slugs.get(page)} value={slugs.get(page) ?? ''}>
              {page.name}{' '}
              <span className="text-text-3">
                · {page.obtained}/{page.total}
                {isPageComplete(page) && ' ✓'}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SlotTooltip({ item }: { item: CollectionLogItem }) {
  const format = useFormat();
  if (!item.obtained) {
    return (
      <>
        <div className="font-semibold">{item.name}</div>
        <div className="text-text-3">Not obtained</div>
      </>
    );
  }
  return (
    <>
      <div>
        <span className="font-semibold">{item.name}</span>
        {item.quantity > 1 && ` × ${formatInt(item.quantity)}`}
      </div>
      <div className="text-text-3">
        {item.firstSeenAt === null
          ? 'Obtained before tracking'
          : item.approximate
            ? `First seen ${approxDate(format.date(item.firstSeenAt), true)}`
            : `Obtained ${format.date(item.firstSeenAt)}`}
      </div>
    </>
  );
}

// Memoised: the slots are the same for every re-render that the clock causes.
const Slots = memo(function Slots({ items }: { items: readonly CollectionLogItem[] }) {
  return items.map((item) => (
    <ItemSlot
      key={item.itemId}
      variant={item.obtained ? 'item' : 'missing'}
      itemId={item.itemId}
      name={item.name}
      quantity={item.quantity}
      tooltip={<SlotTooltip item={item} />}
    />
  ));
});

/** The chosen page. Grows with its items: nothing but the page list scrolls inside a card. */
function ChosenPage({ page }: { page: LogPage }) {
  const complete = isPageComplete(page);
  return (
    <Card className="flex flex-col gap-3 max-desk:px-3.5 desk:gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold desk:text-[15px]">{page.name}</h2>
        <span
          className={cn(
            'text-xs tabular-nums desk:text-table',
            complete ? 'text-accent-text' : 'text-text-3',
          )}
        >
          Obtained {ofTotal(page.obtained, page.total)}
        </span>
      </div>
      {page.items.length === 0 ? (
        <EmptyMessage>This page has no items.</EmptyMessage>
      ) : (
        <>
          <ItemGrid
            columns={6}
            label={`${page.name}: ${ofTotal(page.obtained, page.total)} obtained`}
            className="desk:gap-1.5"
          >
            <Slots items={page.items} />
          </ItemGrid>
          {/* Tooltips open on hover and focus, not on a tap, so mobile says nothing about them. */}
          <span className="text-xs text-text-3">
            Dimmed items are not obtained yet.
            <span className="max-desk:hidden"> Hover for name and date.</span>
          </span>
        </>
      )}
    </Card>
  );
}

/**
 * The game's tabs: links in the filter look (`SegmentedTabs`), so they open in
 * a new tab and have `aria-current`. Each is a step in the history; a click,
 * also on the chosen tab, opens the tab's first page without the filter.
 */
function ClogTabs({
  accountId,
  log,
  tab,
}: {
  accountId: number;
  log: CollectionLogResponse;
  tab: CollectionLogTab | undefined;
}) {
  // What stands in `?tab=` per tab: unique, also for names that look alike.
  const tabSlugs = useMemo(() => clogSlugs(log.tabs), [log.tabs]);
  return (
    <SegmentedTabs
      look="filter"
      label="Collection log tabs"
      tabs={log.tabs.map((entry) => ({
        key: tabSlugs.get(entry) ?? '',
        to: clogHref(accountId, { tab: tabSlugs.get(entry) }),
        label: entry.name,
        current: entry === tab,
      }))}
      className="desk:self-start"
      itemClassName="max-desk:px-0 max-desk:text-xs"
    />
  );
}

function LogColumns({
  accountId,
  log,
  recent,
}: {
  accountId: number;
  log: CollectionLogResponse;
  recent: readonly DatedItem[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  // What stands in `?tab=` per tab: unique, also for names that look alike.
  const tabSlugs = useMemo(() => clogSlugs(log.tabs), [log.tabs]);
  const tab = selectTab(log.tabs, searchParams.get('tab'));
  const page = selectPage(tab, searchParams.get('page'));
  const recentCard = <RecentCard accountId={accountId} items={recent} />;
  if (!tab || !page) {
    return (
      <>
        <ClogTabs accountId={accountId} log={log} tab={tab} />
        <Card>
          <EmptyMessage>This tab has no pages.</EmptyMessage>
        </Card>
        {recentCard}
      </>
    );
  }
  const list = { accountId, tab, tabSlug: tabSlugs.get(tab) ?? '', chosen: page };
  return (
    <>
      <ClogTabs accountId={accountId} log={log} tab={tab} />
      {/* PC: page list | chosen page | recent items from `wide:`; recent items under the two below it. */}
      <div className="grid items-start gap-3 desk:grid-cols-[300px_minmax(0,1fr)] desk:gap-5 wide:grid-cols-[300px_minmax(0,1.4fr)_minmax(0,1fr)]">
        <PageListCard
          {...list}
          find={searchParams.get('find') ?? ''}
          // Typing replaces the URL.
          onFind={(value) => {
            setSearchParams(
              (previous) => {
                const next = new URLSearchParams(previous);
                if (value === '') next.delete('find');
                else next.set('find', value);
                return next;
              },
              { replace: true },
            );
          }}
        />
        <div className="flex min-w-0 flex-col gap-4 desk:contents">
          <MobilePagePicker {...list} />
          <ChosenPage
            key={`${String(log.tabs.indexOf(tab))}/${String(tab.pages.indexOf(page))}`}
            page={page}
          />
        </div>
        <div className="min-w-0 desk:col-span-full wide:col-span-1">{recentCard}</div>
      </div>
    </>
  );
}

// --- Recent items ---------------------------------------------------------------

function RecentCard({ accountId, items }: { accountId: number; items: readonly DatedItem[] }) {
  const format = useFormat();
  const today = useLocalToday(format.timeZone);
  const [expanded, setExpanded] = useState(false);
  const shown = recentItemsShown(items, expanded, today, format.timeZone);
  const anyApproximate = shown.rows.some((entry) => entry.item.approximate);
  return (
    <Card className="flex flex-col gap-3 desk:gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold desk:text-[15px]">Recent items</h2>
        {anyApproximate && (
          <span className="text-xs text-text-3">~ is the sync that found it, not the drop</span>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyMessage>Items you get from now on show up here.</EmptyMessage>
      ) : (
        <ul aria-label="Recent items" className="m-0 list-none p-0">
          {shown.rows.map(({ item, page, tabSlug, pageSlug }) => (
            <ItemRow
              key={item.itemId}
              itemId={item.itemId}
              itemName={item.name}
              name={item.name}
              className="border-hover max-desk:min-h-12 max-desk:py-1.5"
              detail={
                <>
                  <Link
                    to={clogHref(accountId, { tab: tabSlug, page: pageSlug })}
                    className="min-w-0 truncate text-text-3 hover:text-text"
                  >
                    {page}
                  </Link>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">
                    {approxDate(format.date(item.firstSeenAt), item.approximate)}
                  </span>
                </>
              }
            />
          ))}
        </ul>
      )}
      <ShowAllButton
        foldable={shown.foldable}
        expanded={expanded}
        total={shown.thisMonth}
        label={`Show all ${formatInt(shown.thisMonth)} this month`}
        toggle={() => {
          setExpanded((value) => !value);
        }}
        className="mt-0 justify-start max-desk:[&>button]:w-full"
      />
    </Card>
  );
}

// --- One account --------------------------------------------------------------

function Loading({ strip }: { strip: boolean }) {
  return (
    <>
      {strip && <StatStrip items={undefined} label="Collection log summary" skeletonCount={3} />}
      <Card>
        <CardSkeleton lines={8} />
      </Card>
    </>
  );
}

/** What stands in for the collection log of an account that has none yet. */
function NoLog({
  status,
  stale,
  name,
}: {
  status: CollectionLogStatusResponse;
  /** The status could not be read again: a running sync is not something to wait for. */
  stale: boolean;
  name: string;
}) {
  if (status.sync === null) {
    return (
      <EmptyState action={<Link to={SETTINGS_ACCOUNTS_PATH}>Open Settings → OSRS accounts</Link>}>
        Turn on collection log sync for this account in Settings and its collection log shows up
        here.
      </EmptyState>
    );
  }
  if (status.sync.status === 'SYNCING' && !stale) {
    return <EmptyState>Syncing… The collection log shows up here in a moment.</EmptyState>;
  }
  // A sync that failed is explained by the line above the card.
  return (
    <EmptyState>
      {isClogSyncProblem(status.sync.status) || status.sync.status === 'SYNCING'
        ? 'No collection log yet. It shows up here after the first sync that works.'
        : `Not synced yet. Press Sync now to fetch ${name}’s collection log.`}
    </EmptyState>
  );
}

function AccountView({ accountId }: { accountId: number }) {
  const desktop = useIsDesktop();
  const status = useCollectionLogStatus(accountId);
  const log = useCollectionLog(accountId, status.data);
  const sync = useSyncCollectionLog();
  const accounts = useAccounts().data?.accounts ?? [];
  const recent = useMemo(() => recentItems(log.data?.tabs ?? []), [log.data]);

  if (status.data === undefined) {
    if (status.isError) {
      return (
        <Card>
          <ErrorState onRetry={() => void status.refetch()} />
        </Card>
      );
    }
    return <Loading strip />;
  }
  const name = accountNameById(accountId, accounts);
  const state = status.data.sync?.status;
  const problem = state !== undefined && isClogSyncProblem(state);

  return (
    <>
      <PageControls>
        <SyncStatus status={status.data} stale={status.isError} sync={sync} button={desktop} />
      </PageControls>
      {/* A sync that did not work: said here, and the stored collection log stays below. */}
      {problem && (
        <p
          role={CLOG_NEEDS_ACTION.has(state) ? 'alert' : 'status'}
          className="m-0 text-sm text-down"
        >
          {clogStatusText(state, name)}
        </p>
      )}
      {sync.isError && (
        <p role="alert" className="m-0 text-sm text-down">
          Couldn&apos;t start a sync. Try again in a minute.
        </p>
      )}
      {!hasClogData(status.data) ? (
        <Card>
          <NoLog status={status.data} stale={status.isError} name={name} />
        </Card>
      ) : log.data === undefined ? (
        log.isError ? (
          <Card>
            <ErrorState onRetry={() => void log.refetch()} />
          </Card>
        ) : (
          <Loading strip />
        )
      ) : (
        <>
          <ClogStrip log={log.data} status={status.data} />
          <LogColumns accountId={accountId} log={log.data} recent={recent} />
        </>
      )}
      {/* Mobile: "Sync now" last on the page, full width. */}
      {!desktop && status.data.source !== null && status.data.sync !== null && (
        <SyncNowButton
          status={status.data}
          stale={status.isError}
          sync={sync}
          className="h-11 w-full rounded-[10px]"
        />
      )}
    </>
  );
}

// --- All accounts ---------------------------------------------------------------

function AllAccountsView() {
  const { statuses, isComplete, isError, refetch } = useClogStatuses();
  const accounts = useAccounts().data?.accounts ?? [];
  const format = useFormat();
  const failed = (
    <Card>
      <ErrorState onRetry={refetch} />
    </Card>
  );

  if (statuses === undefined || (!isComplete && !isError)) {
    // Without the account list there is nobody to ask.
    return statuses === undefined && isError ? failed : <Loading strip={false} />;
  }

  const cards: AccountCard[] = statuses.flatMap((status) => {
    if (status === undefined || status.updatedAt === null) return [];
    const obtained = status.obtained ?? 0;
    const total = status.total ?? 0;
    return [
      {
        ...accountCardInfo(status.accountId, accounts),
        to: clogHref(status.accountId),
        // The status has no page counts (only the whole log has), so the age stands in for them.
        stats: [
          { key: 'slots', value: ofTotal(obtained, total), label: 'slots' },
          {
            key: 'updated',
            value: format.relative(status.updatedAt),
            label: 'updated',
          },
        ],
        footer: (
          <ProgressBar
            value={obtained}
            max={total}
            label={`${ofTotal(obtained, total)} slots`}
            className="h-2"
          />
        ),
      },
    ];
  });

  // A failed call never hides the accounts that answered.
  return (
    <>
      {cards.length > 0 && (
        <AccountCards
          cards={cards}
          label="Collection log per account"
          note="A collection log belongs to one account. Pick an account to see its pages."
        />
      )}
      {isError && failed}
    </>
  );
}

// --- Page ---------------------------------------------------------------------

export function CollectionLogPage() {
  const scope = useAccountScope();
  return (
    <div className="flex flex-col gap-4 desk:gap-5">
      {scope === 'all' ? <AllAccountsView /> : <AccountView key={scope} accountId={scope} />}
    </div>
  );
}
