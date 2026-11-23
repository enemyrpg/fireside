import {
  addDays,
  type AccountSummary,
  type FeedEntry,
  type FeedSessionEntry,
  type FeedType,
  type ScreentimeBucket,
  type Session,
} from '@fireside/shared';
import { localDateIn, parseLocalDate } from '@/format';
import { accountName, isOnline } from './accounts';
import { isSessionLive } from './session-stats';
import { isShortGroup, mergeHops, type SessionGroup } from './session-groups';
import { dateKey } from './time';

// Small rules for Home. The file keeps the page's old name, Overview.

/**
 * Sessions asked for. Enough that an open session stays in the list even when
 * other accounts have played (or hopped) many short sessions since it started
 * (raised from 4 in review).
 */
export const OVERVIEW_SESSION_LIMIT = 20;

/** Whether a session is still in progress. */
export function isOpenSession(session: Pick<Session, 'endedAt'>): boolean {
  return session.endedAt === null;
}

/** Whether any session in the list is still open. */
export function hasOpenSession(sessions: readonly Pick<Session, 'endedAt'>[]): boolean {
  return sessions.some(isOpenSession);
}

/**
 * Whether any session in the list is live (`isSessionLive`): open, or ended by
 * a hop under 2 minutes ago. What Home and the Sessions page poll on.
 */
export function hasLiveSession(
  sessions: readonly Pick<Session, 'endedAt' | 'endReason'>[],
  nowMs = Date.now(),
): boolean {
  return sessions.some((session) => isSessionLive(session, nowMs));
}

/**
 * The newest open session, otherwise the newest one. Home pins it on top of
 * "Latest" when it is open. The list is newest first. `undefined` without sessions.
 */
export function pickSession<S extends Pick<Session, 'endedAt'>>(
  sessions: readonly S[],
): S | undefined {
  return sessions.find(isOpenSession) ?? sessions[0];
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

export interface OnlineLineInput {
  /** The accounts in view: one account, or every account for `all`. */
  accounts: readonly AccountSummary[];
  /** One account (`false`) or all accounts (`true`). */
  all: boolean;
  /** Recent sessions, newest first, for the world of an online account. */
  sessions: readonly Pick<Session, 'accountId' | 'endedAt' | 'world'>[];
  nowMs: number;
  /** "3 h ago" for a timestamp. */
  relative: (value: string) => string;
}

/**
 * The line beside "This week": who is online, else when you last played.
 * Online is the account switcher's rule (`isOnline`: a recent heartbeat and
 * a live newest session), so the page and the shell agree.
 */
export function onlineLine({ accounts, all, sessions, nowMs, relative }: OnlineLineInput): string {
  const online = accounts.filter((account) => isOnline(account, nowMs));
  const worldOf = (accountId: number) =>
    sessions.find((session) => session.accountId === accountId && isOpenSession(session))?.world ??
    null;

  if (online.length > 0) {
    const world = online.length === 1 && online[0] ? worldOf(online[0].id) : null;
    const where = world === null ? '' : ` · World ${String(world)}`;
    if (!all) return `Online${where}`;
    const names = online.map((account) => accountName(account));
    return `${joinNames(names)} ${online.length === 1 ? 'is' : 'are'} online${where}`;
  }

  const last = accounts.reduce<string | null>(
    (latest, account) =>
      latest === null || account.lastSeenAt > latest ? account.lastSeenAt : latest,
    null,
  );
  const lastPlayed = last === null ? '' : ` · last played ${relative(last)}`;
  return `${all ? 'No accounts online' : 'Offline'}${lastPlayed}`;
}

// --- "Latest" ---------------------------------------------------------------------------

export type FeedFilter = 'all' | 'sessions' | 'drops' | 'clog' | 'levels';

/** Query parameter of the filter (`?show=drops`). Absent: All. */
export const FEED_FILTER_PARAM = 'show';

export interface FeedFilterOption {
  value: FeedFilter;
  label: string;
  /** Types asked for. `undefined`: every type. */
  types?: readonly FeedType[];
  /** What the list says when the filter finds nothing. */
  empty: string;
}

/** Pets have no filter of their own and go with the collection log. */
export const FEED_FILTERS: readonly FeedFilterOption[] = [
  { value: 'all', label: 'All', empty: 'Your last session shows up here after you play.' },
  {
    value: 'sessions',
    label: 'Sessions',
    types: ['session'],
    empty: 'Your sessions show up here after you play.',
  },
  { value: 'drops', label: 'Drops', types: ['drop'], empty: 'Drops worth 1M+ gp show up here.' },
  {
    value: 'clog',
    label: 'Collection log',
    types: ['clog', 'pet'],
    empty: 'New collection log items and pets show up here.',
  },
  { value: 'levels', label: 'Levels', types: ['level'], empty: 'Level-ups show up here.' },
];

/** The filter of `?show=`. Anything unknown is All. */
export function parseFeedFilter(param: string | null): FeedFilterOption {
  const all = FEED_FILTERS[0];
  if (!all) throw new Error('No feed filters');
  return FEED_FILTERS.find((option) => option.value === param) ?? all;
}

/** Whether a filter shows sessions, and so the pinned live session. */
export function showsSessions(filter: FeedFilterOption): boolean {
  return filter.types === undefined || filter.types.includes('session');
}

export type LatestRow =
  | { kind: 'session'; key: string; at: string; group: SessionGroup }
  | { kind: 'entry'; key: string; at: string; entry: Exclude<FeedEntry, FeedSessionEntry> };

export interface LatestDay {
  /** Local date (`2026-11-16`) of the rows' `at`. */
  date: string;
  rows: LatestRow[];
}

/** Rows of "Latest" on Home, the pinned live session included. */
export const LATEST_ROWS = 6;

/**
 * Feed pages Home asks for at most to fill its rows. One is nearly always
 * enough; more only when a page is mostly empty short sessions.
 */
export const LATEST_MAX_PAGES = 5;

export interface Latest {
  /** The live session (with the parts it hopped from), drawn above the days. */
  pinned: SessionGroup | undefined;
  /** At most `limit` rows with the pinned one. */
  days: LatestDay[];
  /** The entries gave `limit` rows. `false`: the next feed page may have more. */
  filled: boolean;
}

/**
 * The rows of "Latest": the feed in its own order, grouped by local day.
 *
 * World hops are merged with the rule and code of the Sessions list
 * (`mergeHops`): a chain is one row where its newest part stands (the chain's
 * end), and the older parts' entries are left out. Level-ups of earlier parts
 * keep their own time, so they sort below it. A chain cut by the end of a feed
 * page shows the parts loaded so far and takes in the rest when "Load more"
 * brings them (the row keeps its key, the newest part's id).
 *
 * Empty short sessions are left out (`isShortGroup`, the rule the Sessions
 * list folds by: closed, under 10 minutes, no XP, kills, loot or new
 * collection log items). They are on the Sessions page.
 *
 * Only the first `limit` rows are given, counting the pinned session when
 * `pinnedShown`. Home is a glance, and the pages behind it have the rest.
 *
 * `sessions` is the sessions list Home already has; its newest open session
 * (`liveId`) is pinned, and that session, with the parts it hopped from, never
 * also stands among the days. When the list and the feed disagree about a
 * session, the newer copy counts (`newerCopy`), so a session that has ended is
 * neither pinned nor shown as live.
 */
/**
 * The newer of two copies of one session. The sessions list and the feed are
 * fetched separately, so either can be behind: a closed copy wins over an open
 * one (a session never reopens), else the one that has lasted longer.
 */
function newerCopy(a: Session, b: Session): Session {
  if ((a.endedAt === null) !== (b.endedAt === null)) return a.endedAt === null ? b : a;
  return b.durationSeconds >= a.durationSeconds ? b : a;
}

export function latestFeed({
  entries,
  sessions,
  liveId,
  timeZone,
  limit = LATEST_ROWS,
  pinnedShown = true,
}: {
  entries: readonly FeedEntry[];
  sessions: readonly Session[];
  liveId: string | undefined;
  timeZone: string;
  limit?: number;
  /** Whether the filter shows the pinned session, which then takes one of the rows. */
  pinnedShown?: boolean;
}): Latest {
  const byId = new Map<string, Session>();
  for (const session of sessions) byId.set(session.id, session);
  for (const entry of entries) {
    if (entry.type !== 'session') continue;
    const known = byId.get(entry.session.id);
    byId.set(entry.session.id, known ? newerCopy(known, entry.session) : entry.session);
  }
  const groups = mergeHops([...byId.values()]);
  const byNewest = new Map(groups.map((group) => [group.newest.id, group]));
  const candidate = liveId === undefined ? undefined : byNewest.get(liveId);
  // The feed may already know that the list's open session has ended: then nothing is pinned.
  const pinned = candidate?.live === true ? candidate : undefined;

  const room = limit - (pinned !== undefined && pinnedShown ? 1 : 0);
  let count = 0;
  const days: LatestDay[] = [];
  const push = (row: LatestRow) => {
    count += 1;
    if (count > room) return;
    const date = localDateIn(row.at, timeZone);
    let day = days.at(-1);
    if (day?.date !== date) {
      day = { date, rows: [] };
      days.push(day);
    }
    day.rows.push(row);
  };
  for (const entry of entries) {
    if (entry.type !== 'session') {
      push({ kind: 'entry', key: entry.id, at: entry.at, entry });
      continue;
    }
    const group = byNewest.get(entry.session.id);
    // An older part of a chain: its row is the newest part's.
    if (group === undefined || group === pinned) continue;
    if (isShortGroup(group)) continue;
    push({ kind: 'session', key: entry.id, at: entry.at, group });
  }
  return { pinned, days, filled: count >= room };
}

// --- This week ----------------------------------------------------------------------------

export interface WeekDayBar {
  /** Local date (`2026-11-16`). */
  date: string;
  /** "M", "T", … */
  letter: string;
  activeSeconds: number;
  afkSeconds: number;
  today: boolean;
  /** After today: nothing can have been played yet. */
  future: boolean;
}

const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

/**
 * Seven days from `monday`, with the play time of the day buckets that match
 * (`screentime?bucket=day`). A day without a bucket is 0.
 */
export function weekDayBars(
  monday: string,
  buckets: readonly Pick<ScreentimeBucket, 'period' | 'activeSeconds' | 'afkSeconds'>[],
  today: string,
): WeekDayBar[] {
  const byDate = new Map(buckets.map((bucket) => [bucket.period, bucket]));
  const first = parseLocalDate(monday);
  return WEEKDAY_LETTERS.map((letter, index) => {
    const date = dateKey(addDays(first, index));
    const bucket = byDate.get(date);
    return {
      date,
      letter,
      activeSeconds: bucket?.activeSeconds ?? 0,
      afkSeconds: bucket?.afkSeconds ?? 0,
      today: date === today,
      future: date > today,
    };
  });
}
