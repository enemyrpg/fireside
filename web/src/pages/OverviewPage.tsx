import {
  BRANDING,
  type AccountScope,
  type AccountSummary,
  type Session,
  type WeeklyResponse,
} from '@fireside/shared';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  useAccounts,
  useCalendar,
  useGains,
  useScreentime,
  useSessions,
  useWeekly,
} from '@/api/hooks';
import { ActivityCalendar } from '@/components/ActivityCalendar';
import { Card, CardHeader } from '@/components/Card';
import { HBarList } from '@/components/HBarList';
import { NetWorthCard } from '@/components/NetWorthCard';
import { SkillIcon } from '@/components/SkillIcon';
import { StatStrip, type StatStripItem } from '@/components/StatStrip';
import { WeekDayBars } from '@/components/WeekDayBars';
import { AccountDot } from '@/components/shell/AccountDot';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatAccountType,
  formatAxisWeekday,
  formatCompact,
  formatDelta,
  formatDuration,
  formatGpExact,
  formatInt,
  formatIsoWeek,
  formatSkill,
  parseLocalDate,
} from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useLocalToday } from '@/hooks/useLocalToday';
import { useNow } from '@/hooks/useNow';
import { accountColors, accountName, anyOnline, isOnline } from '@/lib/accounts';
import { calendarRange, daysPlayedLabel } from '@/lib/calendar';
import { hasLiveSession, onlineLine, OVERVIEW_SESSION_LIMIT, weekDayBars } from '@/lib/overview';
import { weekDates } from '@/lib/time';
import { skillsTrained } from './xp/gains-rows';
import { useAccountScope } from '@/routing/useAccountScope';
import { Latest } from './home/Latest';
import { hrefOf } from './registry';

// Home (formerly Overview): this week's numbers with who is online, "Latest" from
// the feed beside the net worth and the week's top skills, and a calendar of
// the last year. While a session is open, every part is fetched again every
// 30 s; otherwise nothing polls.

const plural = (count: number, word: string, words = `${word}s`) =>
  `${formatInt(count)} ${count === 1 ? word : words}`;

/** Tooltip lines. */
function Lines({ lines }: { lines: readonly ReactNode[] }) {
  return (
    <div className="flex flex-col tabular-nums">
      {lines.map((line, index) => (
        <span key={index}>{line}</span>
      ))}
    </div>
  );
}

/** A number of the strip with its details on hover or focus. */
function WithDetail({ detail, children }: { detail: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{children}</span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

// --- This week ---------------------------------------------------------------------------

/** "Mon 16 – Sun 22 Nov", with the month on both when the week crosses one. */
function weekRangeText(week: string, localDate: (value: string) => string): string {
  const { monday, sunday } = weekDates(week);
  const from = parseLocalDate(monday);
  const to = parseLocalDate(sunday);
  const start =
    from.month === to.month && from.year === to.year
      ? `${formatAxisWeekday(monday)} ${String(from.day)}`
      : localDate(monday);
  return `${start} – ${localDate(sunday)}`;
}

/** Account chips for `all`: a link to each account's Home, online or not. */
function AccountChips({ accounts }: { accounts: readonly AccountSummary[] }) {
  const format = useFormat();
  const now = useNow();
  const colors = useMemo(() => accountColors(accounts), [accounts]);
  return (
    <ul aria-label="Accounts" className="m-0 flex list-none flex-wrap gap-2 p-0">
      {[...accounts]
        .sort((a, b) => a.id - b.id)
        .map((account) => {
          const online = isOnline(account, now);
          return (
            <li key={account.id}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to={`/${String(account.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-table max-desk:min-h-11 text-text hover:border-accent hover:no-underline"
                  >
                    <AccountDot color={colors.get(account.id) ?? 'var(--afk)'} />
                    {accountName(account)}
                    {online && (
                      <span className="size-[7px] rounded-full bg-live">
                        <span className="sr-only">(online)</span>
                      </span>
                    )}
                  </Link>
                </TooltipTrigger>
                <TooltipContent>
                  <Lines
                    lines={[
                      <b key="name">{accountName(account)}</b>,
                      [
                        account.displayName !== null && account.accountType !== null
                          ? formatAccountType(account.accountType)
                          : null,
                        account.totalLevel === null
                          ? null
                          : `total level ${formatInt(account.totalLevel)}`,
                      ]
                        .filter((part) => part !== null)
                        .join(' · '),
                      online ? 'Online now' : `Last seen ${format.relative(account.lastSeenAt)}`,
                    ].filter((line) => line !== '')}
                  />
                </TooltipContent>
              </Tooltip>
            </li>
          );
        })}
    </ul>
  );
}

function weekItems(week: WeeklyResponse, skills: number | undefined): StatStripItem[] {
  const { playtime, xp, loot, kc } = week;
  const kills = kc?.bosses.reduce((sum, boss) => sum + boss.gained, 0) ?? 0;
  const bosses = kc?.bosses.length ?? 0;
  const previous = playtime?.previousWeekPlayedSeconds ?? 0;
  return [
    {
      key: 'played',
      value: (
        <WithDetail
          detail={
            <Lines
              lines={[
                `Active ${formatDuration(playtime?.activeSeconds ?? 0)}`,
                `AFK ${formatDuration(playtime?.afkSeconds ?? 0)}`,
                `Last week: ${formatDuration(previous)}`,
              ]}
            />
          }
        >
          {formatDuration(playtime?.playedSeconds ?? 0)}
        </WithDetail>
      ),
      label:
        playtime === null
          ? 'played'
          : // Against a week without play, a ▲ would look like a jump (as on Weekly).
            previous === 0
            ? 'played · no play time last week'
            : `played · ${formatDelta({
                current: playtime.playedSeconds,
                previous,
                format: formatDuration,
                comparedTo: 'last week',
              })}`,
    },
    {
      key: 'xp',
      value: (
        <WithDetail
          detail={
            <Lines
              lines={[
                `${formatInt(xp?.xpGained ?? 0)} XP`,
                `${plural(xp?.levelsGained ?? 0, 'level')} gained`,
              ]}
            />
          }
        >
          {formatCompact(xp?.xpGained ?? 0)}
        </WithDetail>
      ),
      // The count comes from `gains`; without it the label is just "XP".
      label: skills !== undefined && skills > 0 ? `XP · ${plural(skills, 'skill')}` : 'XP',
      shortLabel: 'XP',
    },
    {
      key: 'loot',
      value: (
        <WithDetail detail={formatGpExact(loot?.geValue ?? 0)}>
          {formatCompact(loot?.geValue ?? 0)}
        </WithDetail>
      ),
      unit: 'gp',
      label: 'loot',
      shortLabel: 'gp loot',
    },
    {
      key: 'kills',
      value:
        kc === null || kc.bosses.length === 0 ? (
          formatInt(kills)
        ) : (
          <WithDetail
            detail={
              <Lines lines={kc.bosses.map((boss) => `${boss.boss} +${formatInt(boss.gained)}`)} />
            }
          >
            {formatInt(kills)}
          </WithDetail>
        ),
      label: bosses > 0 ? `kills · ${plural(bosses, 'boss', 'bosses')}` : 'kills',
      shortLabel: 'kills',
    },
  ];
}

function WeekStrip({
  scope,
  live,
  accounts,
  sessions,
}: {
  scope: AccountScope;
  live: boolean;
  accounts: ReturnType<typeof useAccounts>;
  sessions: readonly Session[] | undefined;
}) {
  const format = useFormat();
  const now = useNow();
  const desktop = useIsDesktop();
  const today = useLocalToday(format.timeZone);
  const weekly = useWeekly(scope, undefined, { live });
  const week = weekly.data;
  // The same week as `weekly` (Monday in the server's time zone), and the XP page's own query.
  const gains = useGains(scope, { period: 'week' }, { live });
  // A week without play has no bars to ask for.
  const screentime = useScreentime(
    scope,
    week ? { from: week.start, to: week.end, bucket: 'day' } : {},
    { enabled: week?.playtime != null, live },
  );

  const all = accounts.data?.accounts;
  const inView =
    all === undefined
      ? undefined
      : scope === 'all'
        ? all
        : all.filter((account) => account.id === scope);

  // A week without play is seven stubs and needs no request. Otherwise the
  // bars wait for this week's own answer: not while it loads (stubs would say
  // "No play time" beside the hours played), not after it failed, and not
  // another account's bars kept while this one loads.
  const buckets =
    week === undefined
      ? undefined
      : week.playtime === null
        ? []
        : screentime.isPlaceholderData
          ? undefined
          : screentime.data?.buckets;
  const bars =
    week === undefined || buckets === undefined
      ? undefined
      : weekDayBars(weekDates(week.week).monday, buckets, today);
  const dayBars =
    bars === undefined ? undefined : desktop ? (
      <WeekDayBars bars={bars} className="max-w-[340px] min-w-60" />
    ) : (
      <WeekDayBars bars={bars} compact />
    );

  return (
    <section
      aria-labelledby="this-week"
      className="flex flex-col gap-3.5 border-b border-border px-0.5 pb-[18px] desk:gap-[18px] desk:px-0 desk:pb-7"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
        <div className="flex items-baseline gap-3.5">
          <h2
            id="this-week"
            className="m-0 font-display text-sm font-semibold tracking-[0.04em] text-accent-text uppercase desk:text-base"
          >
            This week
          </h2>
          {week && (
            <span className="text-table text-text-3 max-desk:hidden">
              {formatIsoWeek(week.week)} · {weekRangeText(week.week, format.localDate)}
            </span>
          )}
        </div>
        {inView !== undefined ? (
          <span className="text-xs text-text-3 desk:text-table">
            {onlineLine({
              accounts: inView,
              all: scope === 'all',
              sessions: sessions ?? [],
              nowMs: now,
              relative: format.relative,
            })}
          </span>
        ) : accounts.isError ? (
          <ErrorState className="min-h-0 flex-row p-0" onRetry={() => void accounts.refetch()} />
        ) : (
          <Skeleton className="h-4 w-48 rounded-md" />
        )}
      </div>
      {scope === 'all' && inView !== undefined && inView.length > 0 && (
        <AccountChips accounts={inView} />
      )}
      <StatStrip
        label="This week’s numbers"
        size="hero"
        className="border-b-0 px-0 pb-0 desk:items-end desk:pb-0"
        items={
          week === undefined ? undefined : weekItems(week, gains.data && skillsTrained(gains.data))
        }
        error={
          week === undefined && weekly.isError ? (
            <ErrorState onRetry={() => void weekly.refetch()} />
          ) : undefined
        }
        {...(desktop
          ? { aside: dayBars && <div className="w-[340px] max-w-full">{dayBars}</div> }
          : { beside: dayBars })}
      />
    </section>
  );
}

// --- Top skills ---------------------------------------------------------------------------

function TopSkillsCard({ scope, live }: { scope: AccountScope; live: boolean }) {
  // The strip's own query (same key), so this is no extra request.
  const query = useWeekly(scope, undefined, { live });
  const week = query.data;

  let body: ReactNode;
  if (week === undefined) {
    body = query.isError ? (
      <ErrorState onRetry={() => void query.refetch()} />
    ) : (
      <CardSkeleton lines={3} />
    );
  } else if (week.xp === null || week.xp.topSkills.length === 0) {
    body = <EmptyState>No XP gained this week yet.</EmptyState>;
  } else {
    body = (
      <HBarList
        label="Top skills this week"
        limit={false}
        className="text-table"
        rows={week.xp.topSkills.map((row) => ({
          key: row.skill,
          label: formatSkill(row.skill),
          value: row.xpGained,
          icon: <SkillIcon skill={row.skill} />,
        }))}
        format={formatCompact}
        formatExact={(value) => `${formatInt(value)} XP`}
      />
    );
  }

  return (
    <Card>
      <CardHeader
        title="Top skills this week"
        action={<Link to={hrefOf('xp', scope)}>XP →</Link>}
      />
      {body}
    </Card>
  );
}

// --- Activity calendar ---------------------------------------------------------------------

function ActivityCard({ scope, live }: { scope: AccountScope; live: boolean }) {
  const format = useFormat();
  const today = useLocalToday(format.timeZone);
  const range = useMemo(() => calendarRange(today, format.timeZone), [today, format.timeZone]);
  const query = useCalendar(scope, range, { live });

  return (
    <Card>
      <CardHeader
        className="mb-4"
        title="Activity"
        {...(query.data === undefined
          ? {}
          : {
              action: (
                <span className="text-table text-text-3">
                  {daysPlayedLabel(query.data.days.length)}
                </span>
              ),
            })}
      />
      {query.data === undefined ? (
        query.isError ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : (
          <CardSkeleton lines={5} />
        )
      ) : (
        <ActivityCalendar today={today} days={query.data.days} />
      )}
    </Card>
  );
}

// --- No accounts yet ------------------------------------------------------------------------

const STEPS: readonly { title: string; text: string; link?: { to: string; label: string } }[] = [
  {
    title: 'Create an API key',
    text: 'The plugin uses it to send your data to this server.',
    link: { to: '/settings/keys', label: 'Create a key →' },
  },
  {
    title: 'Install the plugin and paste the key',
    text: `Find ${BRANDING.displayName} on the RuneLite Plugin Hub, then enter this server’s address and your key.`,
  },
  {
    title: 'Log in to the game',
    text: 'Your first session shows up here as soon as you play.',
  },
];

/** First visit on a new instance: three steps as large numbered cards (`HomeEmpty`). */
function Welcome() {
  return (
    <div className="flex flex-col gap-5 desk:gap-7">
      <section className="flex flex-col gap-2.5 border-b border-border pt-2 pb-5 desk:pt-6 desk:pb-7">
        <h2 className="m-0 font-display text-[30px] leading-tight font-semibold tracking-[-0.02em] desk:text-[44px]">
          Welcome to {BRANDING.displayName}
        </h2>
        <span className="text-[15px] text-text-2">
          Three steps, and your sessions, XP, loot and bank start showing up here.
        </span>
      </section>
      <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-5 p-0">
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            className="flex flex-col gap-2.5 rounded-2xl border border-border bg-card p-[18px] desk:rounded-[14px] desk:px-6 desk:py-[22px]"
          >
            <span
              aria-hidden="true"
              className="font-display text-[40px] leading-none font-semibold text-accent"
            >
              {index + 1}
            </span>
            <h3 className="m-0 font-display text-lg font-semibold">{step.title}</h3>
            <span className="text-table leading-normal text-text-2">{step.text}</span>
            {step.link && (
              <Link
                to={step.link.to}
                className="text-table font-medium no-underline max-desk:flex max-desk:min-h-11 max-desk:items-center"
              >
                {step.link.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// --- Page ------------------------------------------------------------------------------------

export function OverviewPage() {
  const scope = useAccountScope();
  const sessions = useSessions(scope, { limit: OVERVIEW_SESSION_LIMIT }, { pollWhileOpen: true });
  const list = sessions.data?.pages[0]?.items;
  // Live also across a world hop, so the page keeps updating between the parts.
  const live = list !== undefined && hasLiveSession(list);
  // While a session is live, and after it until no account shows as online.
  const accounts = useAccounts({ live: live || anyOnline });
  const all = accounts.data?.accounts;

  if (all?.length === 0) return <Welcome />;

  return (
    // 16 px between the parts on mobile (`MobileHome`), 28 px on PC (`Main`).
    <div className="flex flex-col gap-4 desk:gap-7">
      <WeekStrip scope={scope} live={live} accounts={accounts} sessions={list} />
      <div className="flex flex-wrap items-start gap-5 desk:gap-7">
        <div className="min-w-0 flex-[2_1_560px]">
          <Latest
            scope={scope}
            sessions={list}
            sessionsError={
              list === undefined && sessions.isError ? () => void sessions.refetch() : undefined
            }
            live={live}
            accounts={all ?? []}
          />
        </div>
        <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-5">
          {/* Hidden until an account has a bank snapshot. */}
          <NetWorthCard scope={scope} live={live} />
          <TopSkillsCard scope={scope} live={live} />
        </div>
      </div>
      <ActivityCard scope={scope} live={live} />
    </div>
  );
}
