import type { AccountScope, AccountSummary, FeedEntry, Session } from '@fireside/shared';
import { ChevronDownIcon, PlayIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useFeed, useSession } from '@/api/hooks';
import { LiveBadge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { ItemIcon } from '@/components/ItemIcon';
import { SegmentedFilter } from '@/components/Segmented';
import { SkillIcon } from '@/components/SkillIcon';
import { AccountDot } from '@/components/shell/AccountDot';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatCompact, formatDuration, formatGpExact, formatInt, formatSkill } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { accountColors, accountNameById } from '@/lib/accounts';
import { clogHref, clogSlug } from '@/lib/clog';
import { sourceLabel } from '@/lib/loot';
import {
  FEED_FILTER_PARAM,
  FEED_FILTERS,
  isOpenSession,
  LATEST_MAX_PAGES,
  latestFeed,
  parseFeedFilter,
  pickSession,
  showsSessions,
  type FeedFilter,
  type LatestRow,
} from '@/lib/overview';
import { petDetail, petsHref } from '@/lib/pets';
import { sessionHref, type SessionGroup } from '@/lib/session-groups';
import { sessionNumbers } from '@/lib/session-stats';
import { cn } from '@/lib/utils';
import { hrefOf, pageById } from '../registry';
import { usePageExists } from '../useVisiblePages';

// "Latest" on Home: what happened lately from the feed endpoint, a card per
// local day, newest first: six rows, then a link to the page that has the rest.
// The live session is pinned on top from the sessions list and never repeated
// from the feed. The filter lives in the URL (`?show=`).

const FILTER_OPTIONS = FEED_FILTERS.map(({ value, label }) => ({ value, label }));

/** Most first (then by name), at most `max`. */
function topBosses(kcByBoss: Readonly<Record<string, number>>, max: number) {
  return Object.entries(kcByBoss)
    .filter(([, gained]) => gained > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, max);
}

/** Between the parts of a row's second line. */
const SEPARATOR = ' · ';

/** A part of the second line that only PC has room for. */
interface DeskPart {
  node: ReactNode;
  desk: true;
}

const desk = (node: ReactNode): DeskPart => ({ node, desk: true });

function isDeskPart(part: ReactNode | DeskPart): part is DeskPart {
  return typeof part === 'object' && part !== null && 'desk' in part;
}

interface RowContext {
  scope: AccountScope;
  /** Link to a session: selected in the list on PC, its own screen on mobile. */
  sessionLink: (sessionId: string) => string;
  /** Name and colour of an account, for `all` only. */
  accountOf: ((accountId: number) => { name: string; color: string }) | undefined;
}

/** The frame of every row: time, icon box, two lines and a value, all one link. */
function Row({
  to,
  time,
  mobileTime = time,
  icon,
  title,
  badge,
  tag,
  shortTag,
  meta,
  accountId,
  value,
  context,
}: {
  to: string;
  /** Clock in the server's time zone, "~" in front when it is approximate. */
  time: string;
  /** What starts the second line on mobile instead of `time`: a session's whole span. */
  mobileTime?: string;
  icon: ReactNode;
  title: string;
  /** After the title, never cut: the `LiveBadge`. */
  badge?: ReactNode;
  /** After the title in `--info-text`: "· new collection log". */
  tag?: string;
  /** The tag on mobile: "· new log". */
  shortTag?: string;
  /**
   * Parts of the line under the title, joined with " · ". Empty parts are left
   * out; a `desk` part is on PC only (and takes its separator with it).
   */
  meta: readonly (ReactNode | DeskPart)[];
  accountId: number;
  /** GE value in gp, shown compact on the right. */
  value?: number | undefined;
  context: RowContext;
}) {
  const account = context.accountOf?.(accountId);
  const parts = meta
    .map((part) => (isDeskPart(part) ? part : { node: part, desk: false }))
    .filter(({ node }) => node !== null && node !== undefined && node !== false && node !== '');
  return (
    <li className="border-t border-grid first:border-t-0">
      <Link
        to={to}
        className="grid min-h-14 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2 text-text no-underline hover:bg-hover hover:text-text hover:no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent desk:min-h-0 desk:grid-cols-[52px_36px_minmax(0,1fr)_auto] desk:gap-3.5 desk:px-[18px] desk:py-3.5"
      >
        <span className="font-mono text-xs whitespace-nowrap text-text-3 tabular-nums max-desk:hidden">
          {time}
        </span>
        {icon}
        <span className="flex min-w-0 flex-col gap-px desk:gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <span className="truncate">{title}</span>
            {badge}
            {tag !== undefined && (
              <span className="flex-none text-xs text-info-text">
                {shortTag === undefined ? (
                  tag
                ) : (
                  <>
                    <span className="desk:hidden">{shortTag}</span>
                    <span className="max-desk:hidden">{tag}</span>
                  </>
                )}
              </span>
            )}
          </span>
          {/* One line of inline text, cut with "…" at the end. */}
          <span className="truncate text-xs text-text-3 desk:text-[12.5px]">
            <span className="tabular-nums desk:hidden">{mobileTime}</span>
            {account && (
              <>
                <span aria-hidden="true" className="desk:hidden">
                  {SEPARATOR}
                </span>
                <AccountDot color={account.color} className="mr-1.5 align-[-1px]" />
                {account.name}
              </>
            )}
            {parts.map((part, index) => (
              <span key={index} className={cn(part.desk && 'max-desk:hidden')}>
                <span
                  aria-hidden="true"
                  // On PC the time has its own column, so the first part starts the line.
                  className={cn(index === 0 && !account && 'desk:hidden')}
                >
                  {SEPARATOR}
                </span>
                {part.node}
              </span>
            ))}
          </span>
        </span>
        <span
          className="text-right text-table font-semibold whitespace-nowrap tabular-nums desk:text-sm"
          {...(value === undefined ? {} : { title: formatGpExact(value) })}
        >
          {value !== undefined && (
            <>
              {formatCompact(value)}
              <span className="max-desk:hidden"> gp</span>
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

/** The 36 × 32 box of a row that has no item icon. */
function IconBox({ session = false, children }: { session?: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-8 w-9 items-center justify-center rounded-[7px]',
        session ? 'border border-(--heat-2) bg-accent-wash text-accent-text' : 'bg-raised',
      )}
    >
      {children}
    </span>
  );
}

interface Extra {
  xp: number;
  loot: number;
  /** Boss and kills, as pairs: a boss can have any name. */
  kc: readonly (readonly [string, number])[];
}

/**
 * A session, or a chain of world hops as one session (`mergeHops`). `extra`
 * adds the numbers of an open part, which has no summary yet.
 */
function SessionRowItem({
  group,
  at,
  extra,
  context,
}: {
  group: SessionGroup;
  /**
   * The row's clock. In the days it is the end (the feed's `at`), so the time
   * column reads in the order of the rows; the pinned live session has its start.
   */
  at: string;
  extra?: Extra | undefined;
  context: RowContext;
}) {
  const format = useFormat();
  // No prototype, so a boss called `constructor` is counted like any other (as in `toGroup`).
  const kcByBoss = Object.create(null) as Record<string, number>;
  for (const [boss, gained] of [...Object.entries(group.kcByBoss), ...(extra?.kc ?? [])]) {
    kcByBoss[boss] = (kcByBoss[boss] ?? 0) + gained;
  }
  const xp = (group.xpGained ?? 0) + (extra?.xp ?? 0);
  const loot = (group.lootGeValue ?? 0) + (extra?.loot ?? 0);
  const bosses = topBosses(kcByBoss, 2);
  const first = group.parts[0] ?? group.newest;
  // "19:03–21:06": from the first part's start to the end, "now" while it is open.
  const span = `${format.clock(group.startedAt)}–${group.endedAt === null ? 'now' : format.clock(group.endedAt)}`;
  return (
    <Row
      to={context.sessionLink(first.id)}
      time={format.clock(at)}
      mobileTime={span}
      icon={
        <IconBox session>
          <PlayIcon className="size-3 fill-current" />
        </IconBox>
      }
      title={`Session · ${formatDuration(group.durationSeconds)}`}
      badge={group.live ? <LiveBadge /> : undefined}
      meta={[
        // On mobile the span already starts the line.
        desk(span),
        // The bosses only where there is room for them (PC).
        desk(
          bosses.length > 0 &&
            bosses.map(([boss, gained], index) => (
              <span key={boss}>
                {index > 0 && ', '}
                {boss} <span className="text-accent-text">+{formatInt(gained)}</span>
              </span>
            )),
        ),
        xp > 0 && `${formatCompact(xp)} XP`,
        loot > 0 && <span title={formatGpExact(loot)}>{formatCompact(loot)} gp</span>,
        group.newCollectionLogCount > 0 &&
          `${formatInt(group.newCollectionLogCount)} new log${group.newCollectionLogCount === 1 ? '' : 's'}`,
      ]}
      accountId={group.accountId}
      context={context}
    />
  );
}

/** The live session on top: the closed parts' sums plus the open part's own numbers. */
function PinnedSession({ group, context }: { group: SessionGroup; context: RowContext }) {
  // Polls itself while the session is open (`useSession`).
  const detail = useSession(group.newest.id).data;
  const extra = useMemo<Extra | undefined>(() => {
    if (detail === undefined || !isOpenSession(detail.session)) return undefined;
    const numbers = sessionNumbers(detail);
    return {
      xp: numbers.xpTotal,
      loot: numbers.lootGeValue,
      kc: detail.kc.map((row) => [row.boss, row.gained] as const),
    };
  }, [detail]);
  return (
    <section aria-label="Live session">
      <ul className="m-0 list-none overflow-hidden rounded-[14px] border border-border bg-card p-0">
        <SessionRowItem group={group} at={group.startedAt} extra={extra} context={context} />
      </ul>
    </section>
  );
}

type Entry = Extract<LatestRow, { kind: 'entry' }>['entry'];

function EntryRow({ entry, context }: { entry: Entry; context: RowContext }) {
  const format = useFormat();
  const clock = (approximate = false) => `${approximate ? '~' : ''}${format.clock(entry.at)}`;
  switch (entry.type) {
    case 'drop': {
      const { drop } = entry;
      return (
        <Row
          to={context.sessionLink(drop.sessionId)}
          time={clock()}
          icon={<ItemIcon itemId={drop.itemId} name={drop.name} size="slot" />}
          title={`${drop.name}${drop.quantity > 1 ? ` × ${formatInt(drop.quantity)}` : ''}`}
          {...(entry.newCollectionLog
            ? { tag: '· new collection log', shortTag: '· new log' }
            : {})}
          meta={[sourceLabel(drop.source)]}
          accountId={entry.accountId}
          value={drop.geValue}
          context={context}
        />
      );
    }
    case 'clog':
      return (
        <Row
          // The item's own account: `all` has no collection log of its own to open at a page.
          to={clogHref(entry.accountId, {
            tab: clogSlug(entry.tab) || undefined,
            page: clogSlug(entry.page) || undefined,
          })}
          time={clock(entry.approximate)}
          icon={<ItemIcon itemId={entry.itemId} name={entry.name} size="slot" />}
          title={entry.name}
          tag="· new collection log"
          shortTag="· new log"
          meta={[
            entry.page,
            desk(`${formatInt(entry.obtainedAfter)} of ${formatInt(entry.total)} slots`),
          ]}
          accountId={entry.accountId}
          value={entry.drop?.geValue}
          context={context}
        />
      );
    case 'level': {
      const levels = entry.toLevel - entry.fromLevel;
      return (
        <Row
          to={context.sessionLink(entry.sessionId)}
          time={clock()}
          icon={
            <IconBox>
              <SkillIcon skill={entry.skill} />
            </IconBox>
          }
          title={`${formatSkill(entry.skill)} level ${formatInt(entry.toLevel)}`}
          meta={[
            levels === 1
              ? `up from ${formatInt(entry.fromLevel)}`
              : `${formatInt(levels)} levels, up from ${formatInt(entry.fromLevel)}`,
          ]}
          accountId={entry.accountId}
          context={context}
        />
      );
    }
    case 'pet':
      return (
        <Row
          to={petsHref(context.scope)}
          time={clock(entry.pet.approximate)}
          icon={<ItemIcon itemId={entry.pet.itemId} name={entry.pet.name} size="slot" />}
          title={entry.pet.name}
          tag="· new pet"
          meta={[petDetail(entry.pet)]}
          accountId={entry.accountId}
          context={context}
        />
      );
  }
}

/** PC: the shared segmented filter. Mobile: one 44 px menu, since five options don't fit. */
function Filter({ value, onChange }: { value: FeedFilter; onChange: (value: FeedFilter) => void }) {
  const desktop = useIsDesktop();
  if (desktop) {
    return (
      <SegmentedFilter label="Filter" options={FILTER_OPTIONS} value={value} onChange={onChange} />
    );
  }
  const current = FILTER_OPTIONS.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Filter: ${current?.label ?? ''}`}
          className="flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-table text-text-2 hover:border-accent"
        >
          {current?.label}
          <ChevronDownIcon aria-hidden="true" className="size-3.5 text-text-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const option = FILTER_OPTIONS.find((item) => item.value === next);
            if (option) onChange(option.value);
          }}
        >
          {FILTER_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="min-h-11">
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Latest({
  scope,
  sessions,
  sessionsError,
  live,
  accounts,
}: {
  scope: AccountScope;
  /** The sessions list Home already has (`undefined` while it loads). */
  sessions: readonly Session[] | undefined;
  /** Set when the sessions list couldn't load: retries it. The feed rows still show. */
  sessionsError?: (() => void) | undefined;
  /** A session is open: the feed is fetched again every 30 s. */
  live: boolean;
  accounts: readonly AccountSummary[];
}) {
  const format = useFormat();
  const desktop = useIsDesktop();
  const [params, setParams] = useSearchParams();
  const filter = parseFeedFilter(params.get(FEED_FILTER_PARAM));
  const feed = useFeed(scope, filter.types === undefined ? {} : { types: filter.types }, { live });

  // The feed stops polling when the open session closes. Fetch it once more
  // then, so the closed session and its level-ups arrive without a new visit.
  const wasLive = useRef(live);
  const refetchFeed = feed.refetch;
  useEffect(() => {
    if (wasLive.current && !live) void refetchFeed();
    wasLive.current = live;
  }, [live, refetchFeed]);

  const setFilter = (next: FeedFilter) => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === 'all') updated.delete(FEED_FILTER_PARAM);
        else updated.set(FEED_FILTER_PARAM, next);
        return updated;
      },
      { replace: true },
    );
  };

  const entries = useMemo<FeedEntry[] | undefined>(
    () => feed.data?.pages.flatMap((page) => page.items),
    [feed.data],
  );
  const picked = sessions === undefined ? undefined : pickSession(sessions);
  const liveId = picked !== undefined && isOpenSession(picked) ? picked.id : undefined;
  const pinnedShown = showsSessions(filter);
  const latest = useMemo(
    () =>
      entries === undefined
        ? undefined
        : latestFeed({
            entries,
            sessions: sessions ?? [],
            liveId,
            timeZone: format.timeZone,
            pinnedShown,
          }),
    [entries, sessions, liveId, format.timeZone, pinnedShown],
  );

  // One page nearly always fills the six rows. When it doesn't (a page of
  // empty short sessions, which are left out), the next page is asked for.
  const needsMore =
    latest !== undefined &&
    !latest.filled &&
    feed.hasNextPage &&
    (feed.data?.pages.length ?? 0) < LATEST_MAX_PAGES &&
    !feed.isFetchNextPageError;
  const fetchNextPage = feed.fetchNextPage;
  useEffect(() => {
    if (needsMore && !feed.isFetchingNextPage) void fetchNextPage();
  }, [needsMore, feed.isFetchingNextPage, fetchNextPage]);

  const colors = useMemo(() => accountColors(accounts), [accounts]);
  const listPath = hrefOf('sessions', scope);
  const context: RowContext = {
    scope,
    sessionLink: (sessionId) => sessionHref(sessionId, desktop, listPath),
    accountOf:
      scope === 'all'
        ? (accountId) => ({
            name: accountNameById(accountId, accounts),
            color: colors.get(accountId) ?? 'var(--afk)',
          })
        : undefined,
  };

  // The page that has the rest of what the filter shows. The Collection log
  // only when the page exists (an account has a log).
  const pageExists = usePageExists();
  const more =
    filter.value === 'drops'
      ? { to: hrefOf('loot', scope), label: 'Loot & KC' }
      : filter.value === 'levels'
        ? { to: hrefOf('xp', scope), label: 'XP' }
        : filter.value === 'clog'
          ? pageExists(pageById('clog')) === true
            ? { to: hrefOf('clog', scope), label: 'Collection log' }
            : undefined
          : { to: listPath, label: 'All sessions' };

  let body: ReactNode;
  if (latest === undefined) {
    body = (
      <Card>
        {feed.isError ? (
          <ErrorState onRetry={() => void feed.refetch()} />
        ) : (
          <CardSkeleton lines={5} />
        )}
      </Card>
    );
  } else {
    const pinned = pinnedShown ? latest.pinned : undefined;
    body =
      pinned === undefined && latest.days.length === 0 ? (
        <Card>
          {/* Still looking in the next page: not empty yet. */}
          {needsMore ? <CardSkeleton lines={5} /> : <EmptyState>{filter.empty}</EmptyState>}
        </Card>
      ) : (
        <>
          {pinned && <PinnedSession group={pinned} context={context} />}
          {latest.days.map((day) => (
            <section key={day.date} className="flex flex-col gap-1.5 desk:gap-2">
              <h3 className="m-0 px-0.5 text-xs font-semibold text-text-3 desk:px-1 desk:text-table">
                {format.localDate(day.date)}
              </h3>
              <ul className="m-0 list-none overflow-hidden rounded-[14px] border border-border bg-card p-0">
                {day.rows.map((row) =>
                  row.kind === 'session' ? (
                    <SessionRowItem key={row.key} group={row.group} at={row.at} context={context} />
                  ) : (
                    <EntryRow key={row.key} entry={row.entry} context={context} />
                  ),
                )}
              </ul>
            </section>
          ))}
        </>
      );
  }

  return (
    <section aria-label="Latest" className="flex min-w-0 flex-col gap-3 desk:gap-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <h2 className="m-0 font-display text-xl font-semibold desk:text-[22px]">Latest</h2>
        <Filter value={filter.value} onChange={setFilter} />
      </div>
      {sessionsError && pinnedShown && (
        // Where the live session would stand: without the list, nobody knows if there is one.
        <Card>
          <ErrorState className="min-h-0" onRetry={sessionsError} />
        </Card>
      )}
      {body}
      {more && (
        <Link
          to={more.to}
          className="self-start px-1 font-medium no-underline max-desk:flex max-desk:min-h-11 max-desk:items-center"
        >
          {more.label} →
        </Link>
      )}
    </section>
  );
}
