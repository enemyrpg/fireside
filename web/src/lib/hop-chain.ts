import type { Session, SessionsResponse } from '@fireside/shared';
import { continuesHop, groupContaining, mergeHops } from './session-groups';

// The hop chain on Session detail: the parts of a session joined by quick world
// hops, by the same rule as the list (`continuesHop`). Taken from the loaded
// list when it has the whole chain, else found by walking `neighbors` one
// session at a time.

/** Most sessions fetched while walking `neighbors`, both directions together. */
export const HOP_CHAIN_MAX_STEPS = 10;

/** What the walk needs to know about a session: itself and its neighbours. */
export interface KnownSession {
  session: Session;
  neighbors: { olderId: string | null; newerId: string | null };
}

/** `undefined`: not fetched yet. `null`: could not be fetched (stops the walk there). */
export type SessionLookup = (sessionId: string) => KnownSession | null | undefined;

export interface HopWalk {
  /** Oldest first, with the starting session. */
  parts: Session[];
  /** Sessions to fetch before the walk can go on. Empty when it is done. */
  pending: string[];
  /** Stopped at `HOP_CHAIN_MAX_STEPS`, so there may be more parts. */
  capped: boolean;
}

/**
 * Walks from `start` to older sessions while the older one hops into the
 * current, and to newer ones while the current hops into the next. Each
 * neighbour looked at counts as a step. A session that ended without `hop`
 * never needs its newer neighbour; the older one must be fetched to know.
 */
export function walkHopChain(
  start: KnownSession,
  lookup: SessionLookup,
  maxSteps = HOP_CHAIN_MAX_STEPS,
): HopWalk {
  const parts: Session[] = [start.session];
  const pending: string[] = [];
  let steps = 0;
  let capped = false;

  let current = start;
  for (;;) {
    const olderId = current.neighbors.olderId;
    if (olderId === null) break;
    if (steps >= maxSteps) {
      capped = true;
      break;
    }
    const older = lookup(olderId);
    if (older === undefined) {
      pending.push(olderId);
      break;
    }
    steps += 1;
    if (older === null || !continuesHop(older.session, current.session)) break;
    parts.unshift(older.session);
    current = older;
  }

  current = start;
  for (;;) {
    const newerId = current.neighbors.newerId;
    if (newerId === null || current.session.endReason !== 'hop') break;
    if (steps >= maxSteps) {
      capped = true;
      break;
    }
    const newer = lookup(newerId);
    if (newer === undefined) {
      pending.push(newerId);
      break;
    }
    steps += 1;
    if (newer === null || !continuesHop(current.session, newer.session)) break;
    parts.push(newer.session);
    current = newer;
  }

  return { parts, pending, capped };
}

/**
 * The chain from the loaded list, when the list surely has all of it and
 * agrees with `current` (the session as last fetched in detail):
 *
 * - The list's copy of `current` must have the same end (`endedAt`,
 *   `endReason`). The list is not polled while the detail is, so after a hop
 *   in a live session the list still has it as open.
 * - If `current` ended with a hop and the list has no newer session of the
 *   account, the next part may have started after the list loaded.
 * - If more pages exist and the row's oldest part is the account's oldest
 *   loaded session, an older part may be on the next page.
 *
 * The parts are the list's, with `current` as fetched in detail.
 */
export function chainFromList(
  sessions: readonly Session[],
  hasMore: boolean,
  current: Session,
): Session[] | undefined {
  const listed = sessions.find((session) => session.id === current.id);
  if (listed?.endedAt !== current.endedAt || listed.endReason !== current.endReason) {
    return undefined;
  }
  const group = groupContaining(mergeHops(sessions), current.id);
  if (group === undefined) return undefined;
  const ofAccount = sessions.filter((session) => session.accountId === group.accountId);
  if (
    current.endReason === 'hop' &&
    group.parts.at(-1)?.id === current.id &&
    !ofAccount.some((session) => session.startedAt > current.startedAt)
  ) {
    return undefined;
  }
  const oldest = group.parts[0];
  if (hasMore && oldest !== undefined) {
    const oldestLoaded = ofAccount.reduce<Session | undefined>(
      (found, session) =>
        found === undefined || session.startedAt < found.startedAt ? session : found,
      undefined,
    );
    if (oldestLoaded?.id === oldest.id) return undefined;
  }
  return group.parts.map((part) => (part.id === current.id ? current : part));
}

/** The sessions of a loaded list (pages of `sessions`), and whether more pages exist. */
export function listSessions(pages: readonly SessionsResponse[]): {
  sessions: Session[];
  hasMore: boolean;
} {
  return {
    sessions: pages.flatMap((page) => page.items),
    hasMore: pages.at(-1)?.nextCursor != null,
  };
}
