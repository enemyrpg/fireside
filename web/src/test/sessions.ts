import type { Session, SessionDetailResponse } from '@fireside/shared';

// Sessions and session details for page tests (Sessions, Session detail).

export const sessionId = (n: number) => `01933c40-1111-7aaa-bbbb-${String(n).padStart(12, '0')}`;

/** A closed session `n` from `start` to `end`, with XP, loot and kills. */
export function makeSession(
  n: number,
  start: string,
  end: string,
  overrides: Partial<Session> = {},
): Session {
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return {
    id: sessionId(n),
    accountId: 1,
    startedAt: start,
    endedAt: end,
    endReason: 'logout',
    world: 302,
    durationSeconds: seconds,
    activeSeconds: seconds,
    afkSeconds: 0,
    summary: {
      xpGainedTotal: 12_000,
      xpGainedBySkill: { SLAYER: 12_000 },
      lootGeValue: 2_000_000,
      lootCount: 3,
      kcGainedByBoss: { Vorkath: 4 },
    },
    newCollectionLogCount: 0,
    ...overrides,
  };
}

/** No XP, kills or loot. */
export const EMPTY_SUMMARY = {
  xpGainedTotal: 0,
  xpGainedBySkill: {},
  lootGeValue: 0,
  lootCount: 0,
  kcGainedByBoss: {},
};

/** A detail response for `session`, with nothing in its sections unless given. */
export function makeDetail(
  session: Session,
  neighbors: { olderId?: string | null; newerId?: string | null } = {},
  rest: Partial<Omit<SessionDetailResponse, 'session' | 'neighbors'>> = {},
): SessionDetailResponse {
  return {
    session,
    neighbors: { olderId: neighbors.olderId ?? null, newerId: neighbors.newerId ?? null },
    xp: [],
    loot: [],
    kc: [],
    afkPeriods: [],
    collectionLog: { obtained: null, total: null, items: [] },
    ...rest,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
