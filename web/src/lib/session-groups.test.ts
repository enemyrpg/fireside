import type { Session } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  continuesHop,
  foldShortSessions,
  groupByDay,
  HOP_MERGE_MS,
  isShortGroup,
  mergeHops,
  sessionHref,
  SHORT_SESSION_MAX_SECONDS,
  worldsLabel,
} from './session-groups';

let counter = 0;

/** A closed session from `start` lasting `minutes`, with a small summary. */
function session(start: string, minutes: number, overrides: Partial<Session> = {}): Session {
  counter += 1;
  const startedAt = new Date(start).toISOString();
  const endedAt = new Date(Date.parse(start) + minutes * 60_000).toISOString();
  return {
    id: `01930000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    accountId: 1,
    startedAt,
    endedAt,
    endReason: 'logout',
    world: 302,
    durationSeconds: minutes * 60,
    activeSeconds: minutes * 60,
    afkSeconds: 0,
    summary: {
      xpGainedTotal: 100,
      xpGainedBySkill: { ATTACK: 100 },
      lootGeValue: 1000,
      lootCount: 1,
      kcGainedByBoss: { Vorkath: 1 },
    },
    newCollectionLogCount: 0,
    ...overrides,
  };
}

/** The session that follows `previous` `gapMs` after it ends. */
function after(
  previous: Session,
  gapMs: number,
  minutes: number,
  overrides: Partial<Session> = {},
) {
  const start = new Date(Date.parse(previous.endedAt ?? previous.startedAt) + gapMs).toISOString();
  return session(start, minutes, { accountId: previous.accountId, ...overrides });
}

/** Newest first, as the API lists them. */
const newestFirst = (...sessions: Session[]) =>
  [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

const partIds = (groups: ReturnType<typeof mergeHops>) =>
  groups.map((group) => group.parts.map((part) => part.id));

describe('mergeHops', () => {
  it('merges a hop with the next session starting under 2 minutes later', () => {
    const a = session('2026-11-09T18:00:00Z', 30, { endReason: 'hop', world: 302 });
    const b = after(a, 20_000, 40, { world: 330 });
    const groups = mergeHops(newestFirst(a, b));
    expect(partIds(groups)).toEqual([[a.id, b.id]]);
    expect(groups[0]).toMatchObject({
      key: b.id,
      newest: b,
      startedAt: a.startedAt,
      endedAt: b.endedAt,
      live: false,
      worlds: [302, 330],
      durationSeconds: 70 * 60,
      xpGained: 200,
      lootGeValue: 2000,
      xpBySkill: { ATTACK: 200 },
      kcByBoss: { Vorkath: 2 },
    });
  });

  it('keeps sessions apart at 2 minutes or more, or after a logout', () => {
    const hop = session('2026-11-09T18:00:00Z', 30, { endReason: 'hop' });
    const late = after(hop, HOP_MERGE_MS, 10);
    const logout = after(late, 1_000, 10);
    const closed = after(logout, 1_000, 10, { endReason: 'client_closed' });
    const next = after(closed, 1_000, 10);
    expect(partIds(mergeHops(newestFirst(hop, late, logout, closed, next)))).toEqual([
      [next.id],
      [closed.id],
      [logout.id],
      [late.id],
      [hop.id],
    ]);
  });

  it('does not merge different accounts', () => {
    const a = session('2026-11-09T18:00:00Z', 30, { endReason: 'hop' });
    const b = after(a, 5_000, 10, { accountId: 2 });
    expect(partIds(mergeHops(newestFirst(a, b)))).toEqual([[b.id], [a.id]]);
  });

  it('merges each account separately when other accounts sit in between', () => {
    const a1 = session('2026-11-09T18:00:00Z', 30, { endReason: 'hop' });
    // Account 2 starts between account 1's hop and its next session.
    const b1 = session('2026-11-09T18:30:05Z', 60, { accountId: 2, endReason: 'hop' });
    const a2 = after(a1, 10_000, 30);
    const b2 = after(b1, 30_000, 20, { accountId: 2 });
    expect(partIds(mergeHops(newestFirst(a1, b1, a2, b2)))).toEqual([
      [b1.id, b2.id],
      [a1.id, a2.id],
    ]);
  });

  it('merges a chain of hops', () => {
    const a = session('2026-11-09T18:00:00Z', 30, { endReason: 'hop', world: 1 });
    const b = after(a, 10_000, 5, { endReason: 'hop', world: 2 });
    const c = after(b, 10_000, 15, { world: null });
    const [group] = mergeHops(newestFirst(a, b, c));
    expect(group?.parts.map((part) => part.id)).toEqual([a.id, b.id, c.id]);
    expect(group?.worlds).toEqual([1, 2, null]);
  });

  it('is live while the newest part is open, summing only closed parts', () => {
    const a = session('2026-11-09T18:00:00Z', 30, { endReason: 'hop' });
    const b = after(a, 10_000, 5, { endedAt: null, endReason: null, summary: null });
    const [group] = mergeHops(newestFirst(a, b));
    expect(group).toMatchObject({ live: true, endedAt: null, xpGained: 100, lootGeValue: 1000 });
  });

  it('has no XP or loot for a lone open session', () => {
    const open = session('2026-11-09T18:00:00Z', 5, {
      endedAt: null,
      endReason: null,
      summary: null,
    });
    expect(mergeHops([open])[0]).toMatchObject({ live: true, xpGained: null, lootGeValue: null });
  });

  it('keeps the row key when older parts of a chain load later', () => {
    const a = session('2026-11-09T18:00:00Z', 30, { endReason: 'hop' });
    const b = after(a, 10_000, 5);
    // First page ends with b; a comes with "Load more".
    expect(mergeHops([b])[0]?.key).toBe(b.id);
    expect(mergeHops(newestFirst(a, b))[0]?.key).toBe(b.id);
  });

  it('gives nothing for no sessions', () => {
    expect(mergeHops([])).toEqual([]);
  });
});

describe('groupByDay', () => {
  const TZ = 'Europe/Oslo';
  const days = (sessions: Session[]) =>
    groupByDay(mergeHops(newestFirst(...sessions)), TZ).map((day) => ({
      date: day.date,
      // The oldest part of each row.
      ids: day.groups.map((group) => group.parts[0]?.id),
      durationSeconds: day.durationSeconds,
    }));

  it('groups by local day around midnight, with a total per day', () => {
    // Oslo is UTC+1 in November: 22:30 UTC is 23:30 local, 23:10 UTC is 00:10 the next day.
    const late = session('2026-11-09T22:30:00Z', 60);
    const afterMidnight = session('2026-11-09T23:40:00Z', 20);
    const earlier = session('2026-11-09T10:00:00Z', 45);
    expect(days([late, afterMidnight, earlier])).toEqual([
      { date: '2026-11-10', ids: [afterMidnight.id], durationSeconds: 20 * 60 },
      { date: '2026-11-09', ids: [late.id, earlier.id], durationSeconds: 105 * 60 },
    ]);
  });

  it('puts a session over midnight on the day it started', () => {
    const overMidnight = session('2026-11-09T22:00:00Z', 180);
    expect(days([overMidnight])).toEqual([
      { date: '2026-11-09', ids: [overMidnight.id], durationSeconds: 180 * 60 },
    ]);
  });

  it('uses the start of a hop group for its day', () => {
    const hop = session('2026-11-09T22:30:00Z', 29, { endReason: 'hop' });
    const next = after(hop, 30_000, 60);
    expect(days([hop, next])).toEqual([
      { date: '2026-11-09', ids: [hop.id], durationSeconds: 89 * 60 },
    ]);
  });

  it('follows the local day across the DST change', () => {
    // Summer time ends 25 Oct 2026: 22:30 UTC on the 24th is 00:30 local (UTC+2) on the 25th,
    // 23:30 UTC on the 25th is 00:30 local (UTC+1) on the 26th.
    const a = session('2026-10-24T21:30:00Z', 10);
    const b = session('2026-10-24T22:30:00Z', 10);
    const c = session('2026-10-25T22:30:00Z', 10);
    const d = session('2026-10-25T23:30:00Z', 10);
    expect(days([a, b, c, d]).map((day) => [day.date, day.ids])).toEqual([
      ['2026-10-26', [d.id]],
      ['2026-10-25', [c.id, b.id]],
      ['2026-10-24', [a.id]],
    ]);
  });
});

describe('worldsLabel', () => {
  it('names one world, a missing world and a hop chain', () => {
    expect(worldsLabel([302])).toBe('World 302');
    expect(worldsLabel([null])).toBe('World unknown');
    expect(worldsLabel([302, null, 330])).toBe('Worlds 302 → ? → 330');
  });
});

/** A closed session with nothing in it: no XP, kills or loot. */
const EMPTY = {
  xpGainedTotal: 0,
  xpGainedBySkill: {},
  lootGeValue: 0,
  lootCount: 0,
  kcGainedByBoss: {},
};
const quiet = (start: string, minutes: number, overrides: Partial<Session> = {}) =>
  session(start, minutes, { summary: EMPTY, ...overrides });

const kinds = (items: ReturnType<typeof foldShortSessions>) =>
  items.map((item) => (item.kind === 'short' ? `short×${String(item.run.groups.length)}` : 'row'));

describe('isShortGroup', () => {
  const one = (s: Session) => {
    const [group] = mergeHops([s]);
    if (!group) throw new Error('no group');
    return group;
  };

  it('is under 10 minutes with no XP, kills or loot', () => {
    expect(SHORT_SESSION_MAX_SECONDS).toBe(600);
    expect(isShortGroup(one(quiet('2026-11-08T10:00:00Z', 9)))).toBe(true);
    // The limit itself is not short.
    expect(isShortGroup(one(quiet('2026-11-08T10:00:00Z', 10)))).toBe(false);
  });

  it('is not short with XP, kills or loot, even a drop worth 0 gp', () => {
    const start = '2026-11-08T10:00:00Z';
    expect(
      isShortGroup(
        one(
          quiet(start, 5, {
            summary: { ...EMPTY, xpGainedTotal: 1, xpGainedBySkill: { ATTACK: 1 } },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isShortGroup(one(quiet(start, 5, { summary: { ...EMPTY, kcGainedByBoss: { Vorkath: 1 } } }))),
    ).toBe(false);
    expect(isShortGroup(one(quiet(start, 5, { summary: { ...EMPTY, lootCount: 1 } })))).toBe(false);
  });

  it('is not short with a new collection log item, also in one part of a hop chain', () => {
    const start = '2026-11-08T10:00:00Z';
    expect(isShortGroup(one(quiet(start, 5, { newCollectionLogCount: 1 })))).toBe(false);
    const first = quiet(start, 2, { endReason: 'hop' });
    const second = after(first, 20_000, 2, { summary: EMPTY, newCollectionLogCount: 1 });
    const [chain] = mergeHops(newestFirst(first, second));
    expect(chain?.parts).toHaveLength(2);
    expect(chain?.newCollectionLogCount).toBe(1);
    if (chain) expect(isShortGroup(chain)).toBe(false);
  });

  it('is never an open session', () => {
    const open = quiet('2026-11-08T10:00:00Z', 2, {
      endedAt: null,
      endReason: null,
      summary: null,
    });
    expect(isShortGroup(one(open))).toBe(false);
  });
});

describe('foldShortSessions', () => {
  it('folds two or more consecutive short rows, and keeps a single one as a row', () => {
    const a = quiet('2026-11-08T10:00:00Z', 3);
    const b = after(a, 10 * 60_000, 2, { summary: EMPTY });
    const c = after(b, 10 * 60_000, 4, { summary: EMPTY });
    const busy = after(c, 10 * 60_000, 60);
    const d = after(busy, 10 * 60_000, 5, { summary: EMPTY });
    const items = foldShortSessions(mergeHops(newestFirst(a, b, c, busy, d)));
    expect(kinds(items)).toEqual(['row', 'row', 'short×3']);
    const run = items[2];
    if (run?.kind !== 'short') throw new Error('expected a run');
    // Newest first inside, the span and the summed duration.
    expect(run.run.groups.map((group) => group.key)).toEqual([c.id, b.id, a.id]);
    expect(run.run.startedAt).toBe(a.startedAt);
    expect(run.run.endedAt).toBe(c.endedAt);
    expect(run.run.durationSeconds).toBe(9 * 60);
    expect(run.run.key).toBe(`short:${c.id}`);
  });

  it('works on one day: groupByDay splits runs at midnight', () => {
    const late = quiet('2026-11-08T22:50:00Z', 3);
    const later = after(late, 60_000, 3, { summary: EMPTY });
    const early = quiet('2026-11-09T00:30:00Z', 3);
    const earlier = after(early, 60_000, 3, { summary: EMPTY });
    const days = groupByDay(mergeHops(newestFirst(late, later, early, earlier)), 'Europe/Oslo');
    expect(days.map((day) => kinds(foldShortSessions(day.groups)))).toEqual([
      ['short×2'],
      ['short×2'],
    ]);
    const single = groupByDay(mergeHops(newestFirst(later, early)), 'Europe/Oslo');
    expect(single.map((day) => kinds(foldShortSessions(day.groups)))).toEqual([['row'], ['row']]);
  });

  it('ends at the latest end, also when an earlier row of another account ends later', () => {
    // Account 1: 10:00–10:08. Account 2 starts later (10:01) but ends first (10:03).
    const a = quiet('2026-11-08T10:00:00Z', 8);
    const b = quiet('2026-11-08T10:01:00Z', 2, { accountId: 2 });
    const [item] = foldShortSessions(mergeHops(newestFirst(a, b)));
    if (item?.kind !== 'short') throw new Error('expected a run');
    expect(item.run.startedAt).toBe(a.startedAt);
    expect(item.run.endedAt).toBe(a.endedAt);
  });

  it('mixes accounts for all: consecutive is the order on screen', () => {
    const a = quiet('2026-11-08T10:00:00Z', 3);
    const b = quiet('2026-11-08T10:05:00Z', 3, { accountId: 2 });
    const items = foldShortSessions(mergeHops(newestFirst(a, b)));
    expect(kinds(items)).toEqual(['short×2']);
    if (items[0]?.kind !== 'short') throw new Error('expected a run');
    expect(items[0].run.accountIds).toEqual([2, 1]);
  });

  it('treats a hop group as one row: short only when the whole group is', () => {
    const hop = quiet('2026-11-08T10:00:00Z', 3, { endReason: 'hop' });
    const next = after(hop, 20_000, 3, { summary: EMPTY });
    const other = quiet('2026-11-08T11:00:00Z', 2);
    expect(kinds(foldShortSessions(mergeHops(newestFirst(hop, next, other))))).toEqual(['short×2']);
    const long = after(hop, 20_000, 8, { summary: EMPTY });
    expect(kinds(foldShortSessions(mergeHops(newestFirst(hop, long, other))))).toEqual([
      'row',
      'row',
    ]);
  });

  it('never folds the live session', () => {
    const a = quiet('2026-11-08T10:00:00Z', 3);
    const live = quiet('2026-11-08T10:10:00Z', 2, {
      endedAt: null,
      endReason: null,
      summary: null,
    });
    expect(kinds(foldShortSessions(mergeHops(newestFirst(a, live))))).toEqual(['row', 'row']);
  });
});

describe('continuesHop', () => {
  const hop = session('2026-11-08T10:00:00Z', 30, { endReason: 'hop' });

  it('joins the same account within 2 minutes after a hop', () => {
    expect(continuesHop(hop, after(hop, HOP_MERGE_MS - 1, 10))).toBe(true);
    expect(continuesHop(hop, after(hop, HOP_MERGE_MS, 10))).toBe(false);
  });

  it('never joins another account or a session that did not end with a hop', () => {
    expect(continuesHop(hop, after(hop, 1000, 10, { accountId: 2 }))).toBe(false);
    const logout = session('2026-11-08T10:00:00Z', 30);
    expect(continuesHop(logout, after(logout, 1000, 10))).toBe(false);
  });
});

describe('hop group link', () => {
  it('has its parts oldest first, so the row links to the first part', () => {
    const hop = session('2026-11-08T10:00:00Z', 30, { endReason: 'hop' });
    const next = after(hop, 20_000, 10);
    const [group] = mergeHops(newestFirst(hop, next));
    expect(group?.parts[0]?.id).toBe(hop.id);
  });
});

describe('sessionHref', () => {
  it('selects the session in the list on PC and opens its screen on mobile', () => {
    expect(sessionHref('abc', true, '/all/activity/sessions')).toBe(
      '/all/activity/sessions?session=abc',
    );
    expect(sessionHref('abc', false, '/all/activity/sessions')).toBe('/sessions/abc');
  });
});
