import { continuesHop, HOP_MERGE_MS, type Session } from '@fireside/shared';
import { localDateIn } from '@/format';

// The Sessions list: world hops under 2 minutes are merged into one row that
// can be unfolded, and rows are grouped by local day in the server's time zone.

/** Sessions per "Load more" page. */
export const SESSIONS_PAGE_SIZE = 20;

/** The shared hop rule (`shared/src/sessions.ts`), re-exported for the dashboard. */
export { continuesHop, HOP_MERGE_MS };

/** One row in the list: a session, or a chain of sessions joined by quick world hops. */
export interface SessionGroup {
  /**
   * ID of the newest part. Stays the same when "Load more" adds older parts
   * to a chain split across pages, so the row keeps its state.
   */
  key: string;
  accountId: number;
  /** Oldest first. Always at least one. */
  parts: readonly Session[];
  /** The newest part, which the row links to. */
  newest: Session;
  startedAt: string;
  /** `null` while the newest part is still open. */
  endedAt: string | null;
  live: boolean;
  /** World of each part, oldest first (`null` when a part has none). */
  worlds: readonly (number | null)[];
  /** Summed over the parts, so the time between a hop and the next part is not counted. */
  durationSeconds: number;
  activeSeconds: number;
  afkSeconds: number;
  /** Sums over the parts that have a summary (closed parts). `null` if none has one. */
  xpGained: number | null;
  lootGeValue: number | null;
  /** Drops over the parts that have a summary. `null` if none has one. */
  lootCount: number | null;
  xpBySkill: Readonly<Record<string, number>>;
  kcByBoss: Readonly<Record<string, number>>;
  /** New collection log items, summed over the parts, open ones too. */
  newCollectionLogCount: number;
}

export interface SessionDay {
  /** Local date (`2026-11-09`) of the groups' start. */
  date: string;
  /** Newest first. */
  groups: readonly SessionGroup[];
  /** Sum of the groups' durations. */
  durationSeconds: number;
}

function addAll(target: Record<string, number>, source: Readonly<Record<string, number>>) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function toGroup(parts: readonly Session[]): SessionGroup {
  const first = parts[0];
  const newest = parts.at(-1);
  if (!first || !newest) throw new Error('A session group needs at least one session');
  // No prototype, so a boss called `constructor` is counted like any other.
  const xpBySkill = Object.create(null) as Record<string, number>;
  const kcByBoss = Object.create(null) as Record<string, number>;
  let xpGained: number | null = null;
  let lootGeValue: number | null = null;
  let lootCount: number | null = null;
  for (const part of parts) {
    if (part.summary === null) continue;
    xpGained = (xpGained ?? 0) + part.summary.xpGainedTotal;
    lootGeValue = (lootGeValue ?? 0) + part.summary.lootGeValue;
    lootCount = (lootCount ?? 0) + part.summary.lootCount;
    addAll(xpBySkill, part.summary.xpGainedBySkill);
    addAll(kcByBoss, part.summary.kcGainedByBoss);
  }
  const sum = (field: 'durationSeconds' | 'activeSeconds' | 'afkSeconds') =>
    parts.reduce((total, part) => total + part[field], 0);
  return {
    key: newest.id,
    accountId: first.accountId,
    parts,
    newest,
    startedAt: first.startedAt,
    endedAt: newest.endedAt,
    live: newest.endedAt === null,
    worlds: parts.map((part) => part.world),
    durationSeconds: sum('durationSeconds'),
    activeSeconds: sum('activeSeconds'),
    afkSeconds: sum('afkSeconds'),
    xpGained,
    lootGeValue,
    lootCount,
    xpBySkill,
    kcByBoss,
    newCollectionLogCount: parts.reduce((total, part) => total + part.newCollectionLogCount, 0),
  };
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Merges world hops: a session that ended with `hop` and the same account's
 * next session, starting less than 2 minutes later, become one group (chains
 * of hops too). Accounts are merged separately, so this works for `all`,
 * where other accounts' sessions sit in between. `sessions` is the list as the
 * API gives it (newest first); the groups come back newest first by start.
 */
export function mergeHops(sessions: readonly Session[]): SessionGroup[] {
  const oldestFirst = [...sessions].sort(
    (a, b) => compareText(a.startedAt, b.startedAt) || compareText(a.id, b.id),
  );
  const chains: Session[][] = [];
  const lastChain = new Map<number, Session[]>();
  for (const session of oldestFirst) {
    const chain = lastChain.get(session.accountId);
    const previous = chain?.at(-1);
    if (chain && previous && continuesHop(previous, session)) {
      chain.push(session);
    } else {
      const next = [session];
      chains.push(next);
      lastChain.set(session.accountId, next);
    }
  }
  return chains
    .map(toGroup)
    .sort(
      (a, b) =>
        compareText(b.startedAt, a.startedAt) ||
        compareText(b.parts[0]?.id ?? '', a.parts[0]?.id ?? ''),
    );
}

/**
 * Groups rows by the local day (server time zone) they started on, newest day
 * first. A session over midnight belongs to the day it started. `groups` must
 * be newest first by start, as `mergeHops` gives them.
 */
export function groupByDay(groups: readonly SessionGroup[], timeZone: string): SessionDay[] {
  const days: { date: string; groups: SessionGroup[]; durationSeconds: number }[] = [];
  for (const group of groups) {
    const date = localDateIn(group.startedAt, timeZone);
    let day = days.at(-1);
    if (day?.date !== date) {
      day = { date, groups: [], durationSeconds: 0 };
      days.push(day);
    }
    day.groups.push(group);
    day.durationSeconds += group.durationSeconds;
  }
  return days;
}

/** Path of a session's detail page (the mobile screen, and direct links). */
export function sessionPath(sessionId: string): string {
  return `/sessions/${sessionId}`;
}

/** Query parameter of the session selected in the list on PC. */
export const SESSION_PARAM = 'session';

/**
 * Link to a session: on PC the list with the session selected
 * (`/:acc/activity/sessions?session=<id>`), on mobile its own screen.
 * `listPath` is the Sessions path of the scope (`hrefOf('sessions', scope)`).
 */
export function sessionHref(sessionId: string, desktop: boolean, listPath: string): string {
  return desktop
    ? `${listPath}?${SESSION_PARAM}=${encodeURIComponent(sessionId)}`
    : sessionPath(sessionId);
}

/** The row (group) that holds a session, if it is in the list. */
export function groupContaining(
  groups: readonly SessionGroup[],
  sessionId: string,
): SessionGroup | undefined {
  return groups.find((group) => group.parts.some((part) => part.id === sessionId));
}

/** Whether most of a closed row was AFK. */
export function mostlyAfk(group: Pick<SessionGroup, 'live' | 'activeSeconds' | 'afkSeconds'>) {
  return !group.live && group.afkSeconds > group.activeSeconds;
}

// --- Short sessions -------------------------------------------------------------------

/** A row shorter than this, with nothing in it, is a short session. */
export const SHORT_SESSION_MAX_SECONDS = 10 * 60;

/**
 * Whether a row is a short session: closed, under `SHORT_SESSION_MAX_SECONDS`,
 * and without XP, kills, loot (a drop worth 0 gp is still loot) or new
 * collection log items.
 */
export function isShortGroup(group: SessionGroup): boolean {
  if (group.live || group.durationSeconds >= SHORT_SESSION_MAX_SECONDS) return false;
  // Closed parts always have a summary; one without counts as "not known to be empty".
  if (group.parts.some((part) => part.summary === null)) return false;
  const kills = Object.values(group.kcByBoss).reduce((total, value) => total + value, 0);
  return (
    (group.xpGained ?? 0) === 0 &&
    kills === 0 &&
    (group.lootCount ?? 0) === 0 &&
    group.newCollectionLogCount === 0
  );
}

/** Consecutive short rows folded into one row of the list. */
export interface ShortRun {
  /** Key of its newest row, so it keeps its state when "Load more" adds rows. */
  key: string;
  /** Newest first, as in the list. Always at least two. */
  groups: readonly SessionGroup[];
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  /** Accounts in the run, in order of first appearance (one dot each for `all`). */
  accountIds: readonly number[];
}

export type DayItem = { kind: 'group'; group: SessionGroup } | { kind: 'short'; run: ShortRun };

function toRun(groups: readonly SessionGroup[]): ShortRun {
  const newest = groups[0];
  const oldest = groups.at(-1);
  if (!newest || !oldest) throw new Error('A short run needs at least one row');
  return {
    key: `short:${newest.key}`,
    groups,
    startedAt: oldest.startedAt,
    // The latest end, not the newest start's: for `all` an earlier row of
    // another account can end later. Closed rows only, so `endedAt` is set.
    endedAt: groups.reduce(
      (latest, group) =>
        group.endedAt !== null && group.endedAt > latest ? group.endedAt : latest,
      newest.endedAt ?? newest.startedAt,
    ),
    durationSeconds: groups.reduce((total, group) => total + group.durationSeconds, 0),
    accountIds: [...new Set(groups.map((group) => group.accountId))],
  };
}

/**
 * Folds two or more consecutive short rows of one day into one item (after
 * the hop rule). "Consecutive" is the order on screen, so for `all` a run can
 * hold several accounts. A single short row stays a row.
 */
export function foldShortSessions(groups: readonly SessionGroup[]): DayItem[] {
  const items: DayItem[] = [];
  let run: SessionGroup[] = [];
  const flush = () => {
    if (run.length >= 2) items.push({ kind: 'short', run: toRun(run) });
    else for (const group of run) items.push({ kind: 'group', group });
    run = [];
  };
  for (const group of groups) {
    if (isShortGroup(group)) {
      run.push(group);
    } else {
      flush();
      items.push({ kind: 'group', group });
    }
  }
  flush();
  return items;
}

const worldText = (world: number | null) => (world === null ? '?' : String(world));

export function worldsLabel(worlds: readonly (number | null)[]): string {
  if (worlds.length === 1)
    return worlds[0] == null ? 'World unknown' : `World ${String(worlds[0])}`;
  return `Worlds ${worlds.map(worldText).join(' → ')}`;
}
