import type { AccountSummary, FeedEntry, Session } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  FEED_FILTERS,
  hasOpenSession,
  latestFeed,
  onlineLine,
  parseFeedFilter,
  pickSession,
  showsSessions,
  weekDayBars,
} from './overview';

const NOW = Date.parse('2026-11-11T12:00:00Z');

function account(id: number, name: string, lastSeenAt: string): AccountSummary {
  return {
    id,
    displayName: name,
    accountType: 'NORMAL',
    firstSeenAt: '2026-11-01T18:00:00.000Z',
    lastSeenAt,
    totalLevel: null,
    totalXp: null,
  };
}

const ONLINE = '2026-11-11T11:59:00.000Z';
const OFFLINE = '2026-11-11T09:00:00.000Z';
const relative = (value: string) => (value === OFFLINE ? '3 h ago' : value);

describe('pickSession', () => {
  const closed = (id: string) => ({ id, endedAt: '2026-11-11T10:00:00.000Z' });
  const open = (id: string) => ({ id, endedAt: null });

  it('prefers the newest open session, else the newest session', () => {
    expect(pickSession([closed('a'), open('b'), open('c')])?.id).toBe('b');
    expect(pickSession([closed('a'), closed('b')])?.id).toBe('a');
    expect(pickSession<{ id: string; endedAt: string | null }>([])).toBeUndefined();
  });

  it('knows when a session is open', () => {
    expect(hasOpenSession([closed('a'), open('b')])).toBe(true);
    expect(hasOpenSession([closed('a')])).toBe(false);
    expect(hasOpenSession([])).toBe(false);
  });
});

describe('onlineLine', () => {
  const main = account(1, 'Seed Main', ONLINE);
  const iron = account(2, 'Seed Iron', OFFLINE);
  const openOn = (accountId: number, world: number | null) => ({
    accountId,
    endedAt: null,
    world,
  });

  it('names the online account and its world for all accounts', () => {
    expect(
      onlineLine({
        accounts: [main, iron],
        all: true,
        sessions: [openOn(1, 302)],
        nowMs: NOW,
        relative,
      }),
    ).toBe('Seed Main is online · World 302');
  });

  it('lists several online accounts without a world', () => {
    const alt = account(3, 'Seed Alt', ONLINE);
    expect(
      onlineLine({
        accounts: [main, { ...iron, lastSeenAt: ONLINE }, alt],
        all: true,
        sessions: [openOn(1, 302), openOn(2, 420)],
        nowMs: NOW,
        relative,
      }),
    ).toBe('Seed Main, Seed Iron and Seed Alt are online');
  });

  it('says when you last played when nobody is online', () => {
    expect(onlineLine({ accounts: [iron], all: true, sessions: [], nowMs: NOW, relative })).toBe(
      'No accounts online · last played 3 h ago',
    );
    expect(onlineLine({ accounts: [iron], all: false, sessions: [], nowMs: NOW, relative })).toBe(
      'Offline · last played 3 h ago',
    );
  });

  it('shows one account online, with the world only when known', () => {
    expect(
      onlineLine({
        accounts: [main],
        all: false,
        sessions: [openOn(1, 330)],
        nowMs: NOW,
        relative,
      }),
    ).toBe('Online · World 330');
    expect(
      onlineLine({
        accounts: [main],
        all: false,
        sessions: [openOn(1, null)],
        nowMs: NOW,
        relative,
      }),
    ).toBe('Online');
  });
});

describe('the Latest filter', () => {
  it('reads ?show=, with All for nothing or anything unknown', () => {
    expect(parseFeedFilter(null).value).toBe('all');
    expect(parseFeedFilter('pills').value).toBe('all');
    expect(parseFeedFilter('drops').types).toEqual(['drop']);
    expect(parseFeedFilter('levels').types).toEqual(['level']);
  });

  it('asks for every type for All, and puts pets with the collection log', () => {
    expect(parseFeedFilter('all').types).toBeUndefined();
    expect(parseFeedFilter('clog').types).toEqual(['clog', 'pet']);
    expect(FEED_FILTERS.map((option) => option.label)).toEqual([
      'All',
      'Sessions',
      'Drops',
      'Collection log',
      'Levels',
    ]);
  });

  it('shows the pinned session only where sessions are shown', () => {
    expect(FEED_FILTERS.filter(showsSessions).map((option) => option.value)).toEqual([
      'all',
      'sessions',
    ]);
  });
});

describe('latestFeed', () => {
  const TZ = 'Europe/Oslo';
  const id = (n: number) => `01933c40-0000-7aaa-bbbb-${String(n).padStart(12, '0')}`;

  function session(
    n: number,
    startedAt: string,
    endedAt: string | null,
    endReason: Session['endReason'] = 'logout',
    accountId = 1,
  ): Session {
    const seconds = endedAt === null ? 600 : (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
    return {
      id: id(n),
      accountId,
      startedAt,
      endedAt,
      endReason: endedAt === null ? null : endReason,
      world: 300 + n,
      durationSeconds: seconds,
      activeSeconds: seconds,
      afkSeconds: 0,
      summary:
        endedAt === null
          ? null
          : {
              xpGainedTotal: 1000 * n,
              xpGainedBySkill: { SLAYER: 1000 * n },
              lootGeValue: 10 * n,
              lootCount: 1,
              kcGainedByBoss: { Vorkath: n },
            },
      newCollectionLogCount: 0,
    };
  }

  const sessionEntry = (value: Session, at = value.endedAt ?? value.startedAt): FeedEntry => ({
    type: 'session',
    id: `session:${value.id}`,
    at,
    accountId: value.accountId,
    session: value,
  });

  const level = (value: Session, skill: string): FeedEntry => ({
    type: 'level',
    id: `level:${value.id}.${skill}`,
    at: value.endedAt ?? '',
    accountId: value.accountId,
    sessionId: value.id,
    skill,
    fromLevel: 89,
    toLevel: 90,
  });

  // Three parts joined by hops under 2 minutes, then an unrelated session the day before.
  const part1 = session(1, '2026-11-10T18:00:00.000Z', '2026-11-10T18:30:00.000Z', 'hop');
  const part2 = session(2, '2026-11-10T18:31:00.000Z', '2026-11-10T19:00:00.000Z', 'hop');
  const part3 = session(3, '2026-11-10T19:01:30.000Z', '2026-11-10T20:00:00.000Z');
  const older = session(4, '2026-11-09T18:00:00.000Z', '2026-11-09T19:00:00.000Z');

  it('merges a three-part hop chain into one row at the last part’s end', () => {
    const entries = [
      sessionEntry(part3),
      level(part3, 'SLAYER'),
      sessionEntry(part2),
      sessionEntry(part1),
      level(part1, 'RANGED'),
      sessionEntry(older),
    ];
    const { pinned, days } = latestFeed({ entries, sessions: [], liveId: undefined, timeZone: TZ });
    expect(pinned).toBeUndefined();
    expect(days.map((day) => day.date)).toEqual(['2026-11-10', '2026-11-09']);
    const rows = days[0]?.rows ?? [];
    // One session row, with the level-up of the first part below it at its own time.
    expect(rows.map((row) => row.key)).toEqual([
      `session:${id(3)}`,
      `level:${id(3)}.SLAYER`,
      `level:${id(1)}.RANGED`,
    ]);
    const [chain] = rows;
    if (chain?.kind !== 'session') throw new Error('Expected a session row');
    expect(chain.at).toBe(part3.endedAt);
    expect(chain.group.parts.map((part) => part.id)).toEqual([id(1), id(2), id(3)]);
    expect(chain.group.startedAt).toBe(part1.startedAt);
    expect(chain.group.durationSeconds).toBe(1800 + 1740 + 3510);
    expect(chain.group.xpGained).toBe(6000);
    expect(chain.group.kcByBoss).toEqual({ Vorkath: 6 });
  });

  it('takes in the rest of a chain when the next feed page brings it', () => {
    const firstPage = [sessionEntry(part3), sessionEntry(part2)];
    const before = latestFeed({
      entries: firstPage,
      sessions: [],
      liveId: undefined,
      timeZone: TZ,
    });
    const rowBefore = before.days[0]?.rows[0];
    expect(rowBefore?.kind === 'session' && rowBefore.group.parts.length).toBe(2);

    const after = latestFeed({
      entries: [...firstPage, sessionEntry(part1), sessionEntry(older)],
      sessions: [],
      liveId: undefined,
      timeZone: TZ,
    });
    const rowAfter = after.days[0]?.rows[0];
    expect(rowAfter?.key).toBe(rowBefore?.key);
    expect(rowAfter?.kind === 'session' && rowAfter.group.parts.length).toBe(3);
    expect(after.days[0]?.rows).toHaveLength(1);
  });

  it('does not merge a slow hop, another account, or a logout', () => {
    const slow = session(5, '2026-11-10T20:02:00.000Z', '2026-11-10T21:00:00.000Z');
    const other = session(6, '2026-11-10T18:30:30.000Z', '2026-11-10T18:40:00.000Z', 'logout', 2);
    const entries = [sessionEntry(slow), sessionEntry(part3), sessionEntry(other)];
    const { days } = latestFeed({ entries, sessions: [], liveId: undefined, timeZone: TZ });
    expect(days[0]?.rows.map((row) => row.key)).toEqual(entries.map((entry) => entry.id));
  });

  it('pins the live session with the parts it hopped from, and never repeats them', () => {
    const live = session(7, '2026-11-10T20:01:00.000Z', null);
    const hopped = { ...part3, endReason: 'hop' as const };
    const entries = [
      sessionEntry(live, '2026-11-10T20:10:00.000Z'),
      sessionEntry(hopped),
      level(hopped, 'SLAYER'),
      sessionEntry(older),
    ];
    const { pinned, days } = latestFeed({
      entries,
      sessions: [live, hopped, older],
      liveId: live.id,
      timeZone: TZ,
    });
    expect(pinned?.parts.map((part) => part.id)).toEqual([id(3), id(7)]);
    expect(pinned?.live).toBe(true);
    expect(days.flatMap((day) => day.rows.map((row) => row.key))).toEqual([
      `level:${id(3)}.SLAYER`,
      `session:${id(4)}`,
    ]);
  });

  it('pins from the sessions list alone when the filter has no sessions', () => {
    const live = session(7, '2026-11-10T20:01:00.000Z', null);
    const { pinned, days } = latestFeed({
      entries: [level(older, 'SLAYER')],
      sessions: [live, older],
      liveId: live.id,
      timeZone: TZ,
    });
    expect(pinned?.newest.id).toBe(live.id);
    expect(days).toHaveLength(1);
  });

  it('believes the copy that knows the session has ended, whichever fetch is behind', () => {
    const open = session(7, '2026-11-10T20:01:00.000Z', null);
    const closed = session(7, '2026-11-10T20:01:00.000Z', '2026-11-10T21:00:00.000Z');

    // The list has seen the logout, the feed has not: a closed row, nothing pinned.
    const stale = latestFeed({
      entries: [sessionEntry(open, '2026-11-10T20:59:30.000Z'), sessionEntry(older)],
      sessions: [closed, older],
      liveId: undefined,
      timeZone: TZ,
    });
    expect(stale.pinned).toBeUndefined();
    const [row] = stale.days[0]?.rows ?? [];
    expect(row?.kind === 'session' && row.group.live).toBe(false);
    expect(row?.kind === 'session' && row.group.xpGained).toBe(7000);

    // The feed has seen it, the list has not: not pinned as live, and shown once.
    const ahead = latestFeed({
      entries: [sessionEntry(closed), sessionEntry(older)],
      sessions: [open, older],
      liveId: open.id,
      timeZone: TZ,
    });
    expect(ahead.pinned).toBeUndefined();
    expect(ahead.days.flatMap((day) => day.rows.map((item) => item.key))).toEqual([
      `session:${id(7)}`,
      `session:${id(4)}`,
    ]);
    const [first] = ahead.days[0]?.rows ?? [];
    expect(first?.kind === 'session' && first.group.live).toBe(false);
  });

  it('leaves out empty short sessions, but not short ones with something in them', () => {
    const empty: Session = {
      ...session(5, '2026-11-10T21:00:00.000Z', '2026-11-10T21:05:00.000Z'),
      summary: {
        xpGainedTotal: 0,
        xpGainedBySkill: {},
        lootGeValue: 0,
        lootCount: 0,
        kcGainedByBoss: {},
      },
    };
    const shortWithXp = session(6, '2026-11-10T20:30:00.000Z', '2026-11-10T20:35:00.000Z');
    const shortWithLog: Session = {
      ...empty,
      id: id(9),
      startedAt: '2026-11-10T20:10:00.000Z',
      endedAt: '2026-11-10T20:15:00.000Z',
      newCollectionLogCount: 1,
    };
    const { days, filled } = latestFeed({
      entries: [empty, shortWithXp, shortWithLog, part3].map((value) => sessionEntry(value)),
      sessions: [],
      liveId: undefined,
      timeZone: TZ,
    });
    expect(days.flatMap((day) => day.rows.map((row) => row.key))).toEqual([
      `session:${id(6)}`,
      `session:${id(9)}`,
      `session:${id(3)}`,
    ]);
    // Three rows are not six: the next feed page may have more.
    expect(filled).toBe(false);
  });

  it('gives six rows, the pinned live session counting as one where it is shown', () => {
    const live = session(7, '2026-11-10T22:00:00.000Z', null);
    const closed = Array.from({ length: 8 }, (_, index) =>
      session(
        20 + index,
        `2026-11-0${String(9 - index)}T10:00:00.000Z`,
        `2026-11-0${String(9 - index)}T11:00:00.000Z`,
      ),
    );
    const entries = closed.map((value) => sessionEntry(value));
    const rowsOf = (result: ReturnType<typeof latestFeed>) =>
      result.days.reduce((total, day) => total + day.rows.length, 0);

    const unpinned = latestFeed({ entries, sessions: [], liveId: undefined, timeZone: TZ });
    expect(rowsOf(unpinned)).toBe(6);
    expect(unpinned.filled).toBe(true);

    const pinned = latestFeed({ entries, sessions: [live], liveId: live.id, timeZone: TZ });
    expect(pinned.pinned?.newest.id).toBe(live.id);
    expect(rowsOf(pinned)).toBe(5);

    // Under Drops the pinned session is not shown, so it takes no row.
    const hidden = latestFeed({
      entries,
      sessions: [live],
      liveId: live.id,
      timeZone: TZ,
      pinnedShown: false,
    });
    expect(rowsOf(hidden)).toBe(6);
  });

  it('groups by the local day of the entry, so 23:30 UTC is the next day in Oslo', () => {
    const late = session(8, '2026-11-10T22:00:00.000Z', '2026-11-10T23:30:00.000Z');
    const { days } = latestFeed({
      entries: [sessionEntry(late), sessionEntry(part3)],
      sessions: [],
      liveId: undefined,
      timeZone: TZ,
    });
    expect(days.map((day) => day.date)).toEqual(['2026-11-11', '2026-11-10']);
  });
});

describe('This week', () => {
  it('gives seven days from Monday, 0 for days without a bucket', () => {
    const bars = weekDayBars(
      '2026-11-09',
      [
        { period: '2026-11-09', activeSeconds: 3600, afkSeconds: 600 },
        { period: '2026-11-10', activeSeconds: 0, afkSeconds: 0 },
      ],
      '2026-11-11',
    );
    expect(bars.map((bar) => bar.letter).join('')).toBe('MTWTFSS');
    expect(bars.map((bar) => bar.date).at(-1)).toBe('2026-11-15');
    expect(bars[0]).toMatchObject({ activeSeconds: 3600, afkSeconds: 600, today: false });
    expect(bars[2]).toMatchObject({ today: true, future: false, activeSeconds: 0 });
    expect(bars.filter((bar) => bar.future).map((bar) => bar.date)).toEqual([
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
  });
});
