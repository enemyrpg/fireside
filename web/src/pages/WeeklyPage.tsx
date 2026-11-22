import type {
  AccountScope,
  AccountSummary,
  ScreentimeResponse,
  WeeklyKc,
  WeeklyLoot,
  WeeklyPlaytime,
  WeeklyResponse,
  WeeklyXp,
} from '@fireside/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, isNotFound, PageNotFoundError } from '@/api/errors';
import { useAccounts, useScreentime, useWeekly } from '@/api/hooks';
import { LiveBadge } from '@/components/Badge';
import { BossIcon } from '@/components/BossIcon';
import { Card, CardHeader } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { Delta } from '@/components/Delta';
import { ItemRow } from '@/components/ItemRow';
import { AccountDot } from '@/components/shell/AccountDot';
import { Gp } from '@/components/Gp';
import { HBarList } from '@/components/HBarList';
import { PageControls } from '@/components/shell/PageControls';
import { StackedBars, StackedBarsLegend, type StackedBar } from '@/components/StackedBars';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { SkillIcon } from '@/components/SkillIcon';
import { StackedColumns, type StackedItem } from '@/components/StackedColumns';
import { StatStrip, type StatStripItem } from '@/components/StatStrip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  formatAxisDate,
  formatAxisWeekday,
  formatCompact,
  formatDuration,
  formatInt,
  formatIsoWeek,
  formatPercent,
  formatSkill,
} from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useLocalToday } from '@/hooks/useLocalToday';
import { accountColors, accountNameById } from '@/lib/accounts';
import { sourceLabel } from '@/lib/loot';
import { cn } from '@/lib/utils';
import { isIsoWeekKey, shiftWeek, weekDates, weekOfDate, weeksBetween } from '@/lib/time';
import { WEEKLY_PAGE_PATH } from '@/lib/weekly';
import { useAccountScope } from '@/routing/useAccountScope';
import { BankCard, CollectionLogCard, PetLines, QuestsCard } from './weekly/NewSections';

// Weekly summary: one local ISO week with new pets, play time, the bank, XP, loot, KC, the
// collection log and quests and diaries (for the order). Sections that are `null` are hidden. ← →
// in the top bar and an archive of weeks. The day chart and the session count come from screen
// time for the same week; the tiles always show the weekly numbers.

export const WEEK_NOT_FOUND = "That week doesn't exist.";

/** Archive rows shown at first and added per "Show more". */
export const ARCHIVE_PAGE = 12;

/** An invalid week (`400` on `query.week`, e.g. `2025-W53`) is a missing page. */
function isMissingWeek(error: unknown): boolean {
  return (
    isNotFound(error) ||
    (error instanceof ApiError &&
      error.code === 'VALIDATION_ERROR' &&
      error.details.some((detail) => detail.path.startsWith('query.week')))
  );
}

function weekPath(scope: AccountScope, week: string, current: string): string {
  // The current week has the plain URL, which keeps meaning "this week".
  return `/${String(scope)}/${WEEKLY_PAGE_PATH}${week === current ? '' : `/${week}`}`;
}

/** The week of the oldest first-seen time in the scope; the archive starts there. */
function oldestWeek(
  scope: AccountScope,
  accounts: readonly AccountSummary[],
  localDateOf: (value: string) => string,
): string | undefined {
  const inScope = scope === 'all' ? accounts : accounts.filter((a) => a.id === scope);
  const first = inScope.map((a) => a.firstSeenAt).sort()[0];
  return first === undefined ? undefined : weekOfDate(localDateOf(first));
}

// --- Top bar ------------------------------------------------------------------------

function WeekNav({
  week,
  previous,
  next,
  picker,
}: {
  week: string;
  previous: string | undefined;
  next: string | undefined;
  /** Mobile: the archive in a picker between the arrows (`MobileWeekly`). */
  picker?: ReactNode;
}) {
  const arrow = (to: string | undefined, label: string, icon: ReactNode) =>
    to === undefined ? (
      <Button
        variant="outline"
        size="icon-sm"
        disabled
        aria-label={label}
        className="max-desk:size-11 max-desk:flex-none"
      >
        {icon}
      </Button>
    ) : (
      <Button
        asChild
        variant="outline"
        size="icon-sm"
        className="max-desk:size-11 max-desk:flex-none"
      >
        <Link to={to} aria-label={label}>
          {icon}
        </Link>
      </Button>
    );
  return (
    <div className="flex items-center gap-2 max-desk:w-full">
      {arrow(previous, 'Previous week', <ChevronLeft />)}
      {picker ?? (
        <span className="min-w-[120px] text-center font-display text-base font-semibold tabular-nums">
          {formatIsoWeek(week, { withYear: true })}
        </span>
      )}
      {arrow(next, 'Next week', <ChevronRight />)}
    </div>
  );
}

/** The archive as a picker on mobile: every week from the oldest, newest first. */
function WeekPicker({
  scope,
  week,
  current,
  oldest,
}: {
  scope: AccountScope;
  week: string;
  current: string;
  oldest: string | undefined;
}) {
  const navigate = useNavigate();
  const weeks = useMemo(() => weeksBetween(oldest ?? current, current), [oldest, current]);
  // The shown week is always a choice, also before the accounts load.
  const options = weeks.includes(week) ? weeks : [week, ...weeks];
  return (
    <Select
      value={week}
      onValueChange={(next) => {
        // A new week goes in the history, like the arrows and the archive.
        void navigate(weekPath(scope, next, current));
      }}
    >
      <SelectTrigger
        aria-label="Week"
        // Only the week in the field; the dates are in the list.
        className="h-11 min-w-0 flex-1 font-semibold tabular-nums [&_[data-week-dates]]:hidden"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((item) => {
          const { monday, sunday } = weekDates(item);
          return (
            <SelectItem key={item} value={item} textValue={formatIsoWeek(item, { withYear: true })}>
              <span className="tabular-nums">{formatIsoWeek(item, { withYear: true })}</span>
              <span data-week-dates className="ml-2 text-xs text-text-3 tabular-nums">
                {formatAxisDate(monday)} – {formatAxisDate(sunday)}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

// --- Play time -----------------------------------------------------------------------

type ScreentimeQuery = ReturnType<typeof useScreentime>;

const DAY_COLUMNS: readonly Column<StackedBar>[] = [
  { id: 'day', header: 'Day', cell: (bar) => bar.title },
  {
    id: 'active',
    header: 'Active',
    align: 'right',
    cell: (bar) => formatDuration(bar.activeSeconds),
  },
  { id: 'afk', header: 'AFK', align: 'right', cell: (bar) => formatDuration(bar.afkSeconds) },
  {
    id: 'total',
    header: 'Total',
    align: 'right',
    cell: (bar) => formatDuration(bar.activeSeconds + bar.afkSeconds),
  },
];

function dayBars(data: ScreentimeResponse, localDate: (value: string) => string): StackedBar[] {
  return data.buckets.map((bucket) => ({
    key: bucket.period,
    label: formatAxisWeekday(bucket.period),
    title: localDate(bucket.period),
    activeSeconds: bucket.activeSeconds,
    afkSeconds: bucket.afkSeconds,
  }));
}

function PlaytimeCard({
  playtime,
  week,
  screentime,
}: {
  playtime: WeeklyPlaytime;
  week: string;
  screentime: ScreentimeQuery;
}) {
  const format = useFormat();
  const [asTable, setAsTable] = useState(false);
  // Screen time for another week (kept while this one loads) is not shown.
  const days = screentime.isPlaceholderData ? undefined : screentime.data;
  const { playedSeconds, activeSeconds, afkSeconds } = playtime;

  let chart;
  if (days) {
    const bars = dayBars(days, format.localDate);
    const label = `play time per day, ${formatIsoWeek(week, { withYear: true })}`;
    chart = asTable ? (
      <DataTable
        label={`Active and AFK ${label}`}
        columns={DAY_COLUMNS}
        rows={bars}
        rowKey={(bar) => bar.key}
      />
    ) : (
      <StackedBars bars={bars} label={`Active and AFK ${label}`} variant="compact" />
    );
  } else if (screentime.isError) {
    chart = <ErrorState className="min-h-24" onRetry={() => void screentime.refetch()} />;
  } else {
    chart = <CardSkeleton lines={3} />;
  }

  // Plain numbers in two columns, then the compact bars (`Weekly`): no tiles,
  // no axes. "Show as table" under the bars.
  const number = (value: ReactNode, label: string) => (
    <div className="flex min-w-0 flex-col">
      <span className="truncate font-display text-lg font-semibold tabular-nums desk:text-xl">
        {value}
      </span>
      <span className="text-xs text-text-3">{label}</span>
    </div>
  );
  return (
    <Card className="flex flex-col gap-3.5">
      <CardHeader
        title="Play time"
        className="mb-0"
        action={!screentime.isError && <StackedBarsLegend />}
      />
      <div className="grid grid-cols-2 gap-3.5">
        {number(formatDuration(activeSeconds), 'active')}
        {number(
          formatDuration(afkSeconds),
          `AFK · ${formatPercent(playedSeconds > 0 ? afkSeconds / playedSeconds : 0)}`,
        )}
        {number(days ? formatInt(days.stats.sessionCount) : '–', 'sessions')}
        {number(
          playtime.mostPlayedWorld === null ? '–' : `World ${String(playtime.mostPlayedWorld)}`,
          'most played',
        )}
      </div>
      <div className="min-w-0">{chart}</div>
      {days && (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={asTable}
          className="-ml-2 self-start text-xs text-text-2"
          onClick={() => {
            setAsTable((value) => !value);
          }}
        >
          {asTable ? 'Show as chart' : 'Show as table'}
        </Button>
      )}
    </Card>
  );
}

// --- XP, loot and KC -------------------------------------------------------------------------

function Summary({ children }: { children: ReactNode }) {
  return <span className="text-xs text-text-2 tabular-nums">{children}</span>;
}

function XpCard({ xp }: { xp: WeeklyXp }) {
  const levels = xp.levelsGained;
  return (
    <Card>
      <CardHeader
        title="XP"
        action={
          <Summary>
            {formatInt(xp.xpGained)} XP
            {levels > 0 && ` · ${formatInt(levels)} ${levels === 1 ? 'level' : 'levels'} gained`}
          </Summary>
        }
      />
      {xp.topSkills.length > 0 ? (
        <HBarList
          label="Top skills by XP gained"
          rows={xp.topSkills.map((skill) => ({
            key: skill.skill,
            label: formatSkill(skill.skill),
            value: skill.xpGained,
            icon: <SkillIcon skill={skill.skill} />,
          }))}
          format={(value) => `${formatCompact(value)} XP`}
          formatExact={(value) => `${formatInt(value)} XP`}
        />
      ) : (
        // Levels without XP in a known skill (only unknown skills gained XP).
        <EmptyState>No XP in known skills this week.</EmptyState>
      )}
    </Card>
  );
}

function LootCard({ loot, scope }: { loot: WeeklyLoot; scope: AccountScope }) {
  const format = useFormat();
  const accounts = useAccounts().data?.accounts;
  const colors = useMemo(() => accountColors(accounts ?? []), [accounts]);
  const accountLabel = (accountId: number) =>
    scope === 'all' && accounts
      ? { name: accountNameById(accountId, accounts), color: colors.get(accountId) ?? 'var(--afk)' }
      : undefined;
  return (
    <Card>
      <CardHeader
        title="Loot"
        action={
          <Summary>
            <Gp value={loot.geValue} />
          </Summary>
        }
      />
      {/* All five: the six-row rule. */}
      <ul aria-label="Top drops" className="m-0 list-none p-0">
        {loot.topDrops.map((drop, index) => {
          const account = accountLabel(drop.accountId);
          return (
            <ItemRow
              // One loot event can hold the same item twice (`position`), as on Loot.
              key={`${String(drop.lootEventId)}:${String(index)}`}
              itemId={drop.itemId}
              itemName={drop.name}
              name={`${drop.name}${drop.quantity > 1 ? ` × ${formatInt(drop.quantity)}` : ''}`}
              detail={
                <>
                  <span className="truncate">
                    {sourceLabel(drop.source)} · {format.date(drop.occurredAt)}
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
              value={<Gp value={drop.geValue} />}
            />
          );
        })}
      </ul>
    </Card>
  );
}

function KcCard({ kc }: { kc: WeeklyKc }) {
  const kills = kc.bosses.reduce((sum, boss) => sum + boss.gained, 0);
  const count = kc.bosses.length;
  return (
    <Card>
      <CardHeader
        title="Kill count"
        action={
          <Summary>
            {formatInt(kills)} {kills === 1 ? 'kill' : 'kills'} · {formatInt(count)}{' '}
            {count === 1 ? 'boss' : 'bosses'}
          </Summary>
        }
      />
      <HBarList
        label="Kill count gained per boss"
        // Boss and raid names are long; the full name is in the tooltip.
        className="grid-cols-[150px_minmax(0,1fr)_auto] desk:grid-cols-[200px_minmax(0,1fr)_minmax(90px,auto)]"
        rows={kc.bosses.map((boss) => ({
          key: boss.boss,
          label: boss.boss,
          value: boss.gained,
          icon: <BossIcon boss={boss.boss} />,
        }))}
        format={(value) => `+${formatInt(value)}`}
      />
    </Card>
  );
}

function WeekSections({
  data,
  scope,
  screentime,
}: {
  data: WeeklyResponse;
  scope: AccountScope;
  screentime: ScreentimeQuery;
}) {
  const empty =
    !data.playtime &&
    !data.xp &&
    !data.loot &&
    !data.kc &&
    !data.pets &&
    !data.bank &&
    !data.collectionLog &&
    !data.quests;
  // Two columns that stack on their own (`StackedColumns`): Play time, XP, Kill
  // count and Quests on the left; Bank, Loot and Collection log on the right.
  // One column below 1100 px, in the order in docs/design.md#weekly.
  const sections: StackedItem[] = [];
  const add = (key: string, column: StackedItem['column'], node: ReactNode) => {
    sections.push({ key, column, node });
  };
  if (data.playtime) {
    add(
      'playtime',
      'left',
      <PlaytimeCard
        // Starts on the chart again for a new week.
        key={`${String(scope)}:${data.week}`}
        playtime={data.playtime}
        week={data.week}
        screentime={screentime}
      />,
    );
  }
  if (data.bank) {
    add(
      'bank',
      'right',
      <BankCard bank={data.bank} week={data.week} complete={data.complete} scope={scope} />,
    );
  }
  if (data.xp) {
    // Lists start folded again for a new week (six-row rule).
    add('xp', 'left', <XpCard key={`xp:${String(scope)}:${data.week}`} xp={data.xp} />);
  }
  if (data.loot) add('loot', 'right', <LootCard loot={data.loot} scope={scope} />);
  if (data.kc) add('kc', 'left', <KcCard key={`kc:${String(scope)}:${data.week}`} kc={data.kc} />);
  if (data.collectionLog) {
    add('clog', 'right', <CollectionLogCard clog={data.collectionLog} scope={scope} />);
  }
  if (data.quests) add('quests', 'left', <QuestsCard quests={data.quests} scope={scope} />);

  return (
    <>
      {data.pets && <PetLines pets={data.pets} scope={scope} />}
      <StackedColumns items={sections} />
      {empty && (
        <Card>
          <EmptyState className="min-h-[160px]">No play time this week.</EmptyState>
        </Card>
      )}
    </>
  );
}

/** The week's big numbers (`Weekly`): played, XP, loot and kills. `null` sections are 0. */
function WeekStrip({ data }: { data: WeeklyResponse | undefined }) {
  let items: StatStripItem[] | undefined;
  if (data) {
    const playtime = data.playtime;
    const levels = data.xp?.levelsGained ?? 0;
    const kills = data.kc?.bosses.reduce((sum, boss) => sum + boss.gained, 0) ?? 0;
    const bosses = data.kc?.bosses.length ?? 0;
    items = [
      {
        key: 'played',
        value: formatDuration(playtime?.playedSeconds ?? 0),
        label: 'played',
        ...(playtime
          ? {
              note:
                // Against a week without play, a ▲ would look like a jump (as on Screen time).
                playtime.previousWeekPlayedSeconds === 0 ? (
                  'No play time last week'
                ) : (
                  <Delta
                    current={playtime.playedSeconds}
                    previous={playtime.previousWeekPlayedSeconds}
                    format={formatDuration}
                    comparedTo="last week"
                  />
                ),
            }
          : {}),
      },
      {
        key: 'xp',
        value: formatCompact(data.xp?.xpGained ?? 0),
        label: levels > 0 ? `XP · ${formatInt(levels)} ${levels === 1 ? 'level' : 'levels'}` : 'XP',
        shortLabel: 'XP',
      },
      {
        key: 'loot',
        value: <Gp value={data.loot?.geValue ?? 0} />,
        label: 'loot',
      },
      {
        key: 'kills',
        value: formatInt(kills),
        label:
          bosses > 0 ? `kills · ${formatInt(bosses)} ${bosses === 1 ? 'boss' : 'bosses'}` : 'kills',
        shortLabel: 'kills',
      },
    ];
  }
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-[18px] desk:flex-row desk:flex-wrap desk:items-end desk:justify-between desk:gap-x-10 desk:pb-7">
      <StatStrip label="Week summary" items={items} className="border-b-0 pb-0 desk:pb-0" />
      {data && <WeekHeading data={data} />}
    </div>
  );
}

/** Dates of the week on screen, and "In progress" while it isn't over. */
function WeekHeading({ data }: { data: WeeklyResponse }) {
  const format = useFormat();
  const { monday, sunday } = weekDates(data.week);
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="text-text-2">
        {format.localDate(monday)} – {format.localDate(sunday)}
      </span>
      {!data.complete && <LiveBadge>In progress</LiveBadge>}
    </div>
  );
}

// --- Archive ------------------------------------------------------------------------------

function Archive({
  scope,
  week,
  current,
  oldest,
  accountsQuery,
}: {
  scope: AccountScope;
  week: string;
  current: string;
  oldest: string | undefined;
  accountsQuery: ReturnType<typeof useAccounts>;
}) {
  const weeks = useMemo(() => weeksBetween(oldest ?? current, current), [oldest, current]);
  const [more, setMore] = useState(ARCHIVE_PAGE);
  // The shown week is always in the list, also far back: after the accounts
  // load, after many ← and when opened directly.
  const shown = Math.max(more, weeks.indexOf(week) + 1);

  let body;
  if (accountsQuery.data) {
    body = (
      <>
        <ul className="m-0 flex list-none flex-col p-0">
          {weeks.slice(0, shown).map((item) => {
            const { monday, sunday } = weekDates(item);
            const on = item === week;
            return (
              <li key={item}>
                <Link
                  to={weekPath(scope, item, current)}
                  aria-current={on ? 'page' : undefined}
                  className={cn(
                    'flex items-baseline justify-between gap-3 rounded-md px-2.5 py-2 text-text hover:bg-hover hover:no-underline',
                    on && 'bg-accent-wash hover:bg-accent-wash',
                  )}
                >
                  <span className="whitespace-nowrap tabular-nums">
                    {formatIsoWeek(item, { withYear: true })}
                  </span>
                  <span className="text-xs whitespace-nowrap text-text-3 tabular-nums">
                    {formatAxisDate(monday)} – {formatAxisDate(sunday)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        {weeks.length > shown && (
          <div className="mt-2 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMore(shown + ARCHIVE_PAGE);
              }}
            >
              Show more
            </Button>
          </div>
        )}
      </>
    );
  } else if (accountsQuery.isError) {
    body = <ErrorState onRetry={() => void accountsQuery.refetch()} />;
  } else {
    body = <CardSkeleton lines={6} />;
  }

  return (
    <Card className="px-3.5 max-desk:px-3.5" aria-label="Archive">
      <CardHeader title="Archive" className="px-2.5" />
      {body}
    </Card>
  );
}

// --- Page ---------------------------------------------------------------------------------

export function WeeklyPage() {
  const scope = useAccountScope();
  const format = useFormat();
  const today = useLocalToday(format.timeZone);
  const current = weekOfDate(today);
  const week = useParams().week ?? current;
  // A malformed week (`foo`, `2026-46`) can't be shifted or shown; a
  // well-formed one without that week (`2025-W53`) gets the server's 400.
  if (!isIsoWeekKey(week)) throw new PageNotFoundError(WEEK_NOT_FOUND);

  const desktop = useIsDesktop();
  const weekly = useWeekly(scope, week);
  const data = weekly.data;
  // Same `[start, end)` as the week on screen, so the chart matches the tiles.
  const screentime = useScreentime(
    scope,
    data ? { from: data.start, to: data.end, bucket: 'day' } : {},
    { enabled: data?.playtime != null },
  );

  const accountsQuery = useAccounts();
  const oldest = oldestWeek(scope, accountsQuery.data?.accounts ?? [], format.localDateOf);

  // The full-page 404 (with the footer) comes from the router's error page.
  if (data === undefined && isMissingWeek(weekly.error)) {
    throw new PageNotFoundError(WEEK_NOT_FOUND);
  }

  const previous = shiftWeek(week, -1);
  const next = shiftWeek(week, 1);
  const hasPrevious = oldest !== undefined && previous >= oldest;
  const hasNext = next <= current;

  let main;
  if (data) {
    main = <WeekSections data={data} scope={scope} screentime={screentime} />;
  } else if (weekly.isError) {
    main = (
      <Card>
        <ErrorState onRetry={() => void weekly.refetch()} />
      </Card>
    );
  } else {
    main = (
      <>
        <Card>
          <CardSkeleton lines={6} />
        </Card>
        <Card>
          <CardSkeleton lines={4} />
        </Card>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-5 desk:gap-7">
      <PageControls>
        <WeekNav
          week={week}
          previous={hasPrevious ? weekPath(scope, previous, current) : undefined}
          next={hasNext ? weekPath(scope, next, current) : undefined}
          picker={
            desktop ? undefined : (
              <WeekPicker scope={scope} week={week} current={current} oldest={oldest} />
            )
          }
        />
      </PageControls>
      {/* Kept when a refetch fails: the week on screen still has its numbers. */}
      {(data !== undefined || !weekly.isError) && <WeekStrip data={data} />}
      <div className="grid grid-cols-1 items-start gap-5 desk:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-5">{main}</div>
        {/* PC: the archive in a narrow column. Mobile: in the week picker. */}
        {desktop && (
          <Archive
            // Starts on the first weeks again for another account.
            key={String(scope)}
            scope={scope}
            week={week}
            current={current}
            oldest={oldest}
            accountsQuery={accountsQuery}
          />
        )}
      </div>
    </div>
  );
}
