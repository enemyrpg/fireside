import {
  isKnownSkill,
  type Session,
  type SessionDetailResponse,
  type SessionLoot,
  type SessionXp,
} from '@fireside/shared';
import { HOP_MERGE_MS } from './session-groups';

// Numbers and polling rules for Session detail.

/** At least this long before XP/h and gp/h are shown, so a few seconds don't give silly rates. */
export const MIN_RATE_SECONDS = 5 * 60;

/** `value` per hour over `seconds`, or `null` for less than `MIN_RATE_SECONDS`. */
export function perHour(value: number, seconds: number): number | null {
  return seconds >= MIN_RATE_SECONDS ? (value * 3600) / seconds : null;
}

export interface SessionNumbers {
  /** XP over known skills, like the summary (unknown skills are listed but not counted). */
  xpTotal: number;
  skillCount: number;
  /** Per hour of *active* time: XP only comes while playing. */
  xpPerHour: number | null;
  lootGeValue: number;
  dropCount: number;
  /** Per hour of the whole session (AFK included). */
  gpPerHour: number | null;
  kills: number;
  /** Bosses with kills in the session, in the API's order (by name). */
  bosses: string[];
  /** New collection log items tied to the session. */
  newCollectionLog: number;
}

/** The numbers at the top of Session detail: four, and new collection log items when there are some. */
export function sessionNumbers(detail: SessionDetailResponse): SessionNumbers {
  const { session } = detail;
  const xp = detail.xp.filter((row) => isKnownSkill(row.skill));
  const xpTotal = xp.reduce((total, row) => total + row.xpGained, 0);
  const lootGeValue = detail.loot.reduce((total, drop) => total + drop.geValue, 0);
  return {
    xpTotal,
    skillCount: xp.length,
    xpPerHour: perHour(xpTotal, session.activeSeconds),
    lootGeValue,
    dropCount: detail.loot.length,
    gpPerHour: perHour(lootGeValue, session.durationSeconds),
    kills: detail.kc.reduce((total, row) => total + row.gained, 0),
    bosses: detail.kc.filter((row) => row.gained > 0).map((row) => row.boss),
    newCollectionLog: detail.collectionLog.items.length,
  };
}

/**
 * Whether a session still counts as live: open, or ended by a world hop less
 * than 2 minutes ago (the same window as merging hops), while the next part
 * may not have arrived yet. The one rule behind "Online" (`isOnline`), Home's
 * and the Sessions page's polling (`useSessions`) and Session detail's
 * (`shouldPollSession`), so a hop never shows as offline or stops a page.
 */
export function isSessionLive(
  session: Pick<Session, 'endedAt' | 'endReason'>,
  nowMs = Date.now(),
): boolean {
  if (session.endedAt === null) return true;
  return session.endReason === 'hop' && nowMs - Date.parse(session.endedAt) < HOP_MERGE_MS;
}

/**
 * Whether Session detail should keep fetching: while the session is live
 * (`isSessionLive`), but after a hop only until the next part shows up as
 * `neighbors.newerId`.
 */
export function shouldPollSession(
  detail: SessionDetailResponse | undefined,
  nowMs = Date.now(),
): boolean {
  if (!detail) return false;
  const { session, neighbors } = detail;
  if (session.endedAt === null) return true;
  return neighbors.newerId === null && isSessionLive(session, nowMs);
}

// --- Sections (six-row rule) ------------------------------------------------------

/** Most XP first, then by skill name. */
export function xpRows(detail: SessionDetailResponse): SessionXp[] {
  return [...detail.xp].sort(
    (a, b) => b.xpGained - a.xpGained || (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0),
  );
}

export type LootOrder = 'value' | 'time';

/** Drops in the chosen order: highest value first, or oldest first (as the API gives them). */
export function lootRows(loot: readonly SessionLoot[], order: LootOrder): SessionLoot[] {
  return order === 'time' ? [...loot] : [...loot].sort((a, b) => b.geValue - a.geValue);
}
