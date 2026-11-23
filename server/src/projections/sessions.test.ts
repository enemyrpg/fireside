import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sessions } from '../db/schema.js';
import { PROJECTIONS } from './index.js';
import {
  afkSecondsWithin,
  closeTimedOutSessions,
  deriveSession,
  estimateAfkPeriods,
  SESSION_TIMEOUT_MS,
  type SessionFacts,
} from './sessions.js';
import {
  emptyRun,
  eventFactory,
  expectOrderIndependent,
  ingestBatch,
  runRebuild,
  sessionIdOf,
  TEST_ACCOUNT_HASH,
  TEST_NOW,
  timeOf,
  type TestRun,
} from './testing.js';
import { FIRST_USER_ID } from '../users/users.js';

const S1 = sessionIdOf(1);
const S2 = sessionIdOf(2);

/** `TEST_NOW` minus `minutes`, as an event time. */
function minutesAgo(minutes: number): string {
  return new Date(TEST_NOW.getTime() - minutes * 60_000).toISOString();
}

function plus(time: string, ms: number): Date {
  return new Date(Date.parse(timeOf(time)) + ms);
}

function sessionRow(run: TestRun, id = S1) {
  return run.database.db.select().from(sessions).where(eq(sessions.id, id)).get();
}

interface SnapshotSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  world: number | null;
  lastHeartbeatAt: string;
  durationSeconds: number;
  afkSeconds: number;
  activeSeconds: number;
}

function sessionsOf(snapshot: Record<string, unknown>): SnapshotSession[] {
  return (snapshot.sessions as { sessions: SnapshotSession[] }).sessions;
}

describe('afkSecondsWithin', () => {
  const period = (from: string, to: string) => ({ startedAt: timeOf(from), endedAt: timeOf(to) });

  it('clips periods to the session', () => {
    expect(afkSecondsWithin([period('18:50', '19:10')], timeOf('19:00'), timeOf('20:00'))).toBe(
      600,
    );
    expect(afkSecondsWithin([period('19:50', '20:30')], timeOf('19:00'), timeOf('20:00'))).toBe(
      600,
    );
    expect(afkSecondsWithin([period('17:00', '18:00')], timeOf('19:00'), timeOf('20:00'))).toBe(0);
  });

  it('counts overlapping and duplicate periods once', () => {
    expect(
      afkSecondsWithin(
        [period('19:10', '19:20'), period('19:15', '19:30'), period('19:10', '19:20')],
        timeOf('19:00'),
        timeOf('20:00'),
      ),
    ).toBe(1200);
    expect(
      afkSecondsWithin(
        [period('19:40', '19:50'), period('19:10', '19:20')],
        timeOf('19:00'),
        timeOf('20:00'),
      ),
    ).toBe(1200);
  });
});

describe('deriveSession', () => {
  const facts: SessionFacts = {
    startedAt: timeOf('19:00'),
    world: 420,
    lastHeartbeatAt: timeOf('20:00'),
    afkPeriods: [{ startedAt: timeOf('19:30'), endedAt: timeOf('19:45') }],
  };

  it('stays open until the timeout, counting up to the last heartbeat', () => {
    expect(deriveSession(facts, plus('20:00', SESSION_TIMEOUT_MS - 1))).toEqual({
      endedAt: null,
      endReason: null,
      durationSeconds: 3600,
      afkSeconds: 900,
      activeSeconds: 2700,
    });
  });

  it('closes at the last heartbeat with timeout after 10 minutes', () => {
    expect(deriveSession(facts, plus('20:00', SESSION_TIMEOUT_MS))).toMatchObject({
      endedAt: timeOf('20:00'),
      endReason: 'timeout',
      durationSeconds: 3600,
    });
  });

  it('uses a real end even if the session would have timed out', () => {
    const end = { at: timeOf('20:05'), reason: 'client_closed' } as const;
    expect(deriveSession({ ...facts, end }, plus('23:00', 0))).toEqual({
      endedAt: timeOf('20:05'),
      endReason: 'client_closed',
      durationSeconds: 3900,
      afkSeconds: 900,
      activeSeconds: 3000,
    });
  });

  it('never gives a negative duration', () => {
    const end = { at: timeOf('18:00'), reason: 'logout' } as const;
    expect(deriveSession({ ...facts, end }, plus('20:00', 0))).toMatchObject({
      durationSeconds: 0,
      afkSeconds: 0,
      activeSeconds: 0,
    });
  });
});

describe('sessions projection', () => {
  it('builds a session with heartbeats, AFK and end, in any order', () => {
    const f = eventFactory();
    const events = [
      f.sessionStart('19:00'),
      f.heartbeat('19:01'),
      f.heartbeat('19:02', {
        payload: { worldTypes: [], worldLocation: null, worldActivity: null, idle: true },
      }),
      f.afk('19:10', '19:25'),
      // Starts before the session: only the part inside counts.
      f.afk('18:50', '19:05'),
      f.sessionEnd('20:00'),
    ];
    const snapshot = expectOrderIndependent(events).sessions as {
      sessions: SnapshotSession[];
      heartbeats: unknown[];
      afkPeriods: unknown[];
    };
    expect(snapshot.sessions).toEqual([
      {
        id: S1,
        userId: FIRST_USER_ID,
        accountHash: TEST_ACCOUNT_HASH,
        startedAt: timeOf('19:00'),
        endedAt: timeOf('20:00'),
        endReason: 'logout',
        world: 420,
        lastHeartbeatAt: timeOf('19:02'),
        durationSeconds: 3600,
        afkSeconds: 20 * 60,
        activeSeconds: 40 * 60,
      },
    ]);
    expect(snapshot.heartbeats).toEqual([
      {
        eventId: events[1]?.eventId,
        sessionId: S1,
        at: timeOf('19:01'),
        regionId: 12342,
        world: 420,
        worldTypes: '["MEMBERS"]',
        worldLocation: 'GERMANY',
        worldActivity: '',
        idle: false,
      },
      {
        eventId: events[2]?.eventId,
        sessionId: S1,
        at: timeOf('19:02'),
        regionId: 12342,
        world: 420,
        worldTypes: '[]',
        worldLocation: null,
        worldActivity: null,
        idle: true,
      },
    ]);
    // Stored as sent, clipped only when counting.
    expect(snapshot.afkPeriods).toEqual([
      expect.objectContaining({ startedAt: timeOf('19:10'), endedAt: timeOf('19:25') }),
      expect.objectContaining({ startedAt: timeOf('18:50'), endedAt: timeOf('19:05') }),
    ]);
  });

  it('stores heartbeats from the fixtures', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('19:00'),
      f.fromFixture('session-heartbeat.json', '19:01'),
    ]).sessions as { heartbeats: unknown[] };
    expect(snapshot.heartbeats).toHaveLength(1);
  });

  it('ends a session on hop and starts a new one', () => {
    const f = eventFactory();
    const s2 = { sessionId: S2 };
    const result = sessionsOf(
      expectOrderIndependent([
        f.sessionStart('19:00'),
        f.heartbeat('19:01'),
        f.sessionEnd('19:02', { reason: 'hop' }),
        f.sessionStart('19:02', s2),
        f.heartbeat('19:03', s2),
        f.sessionEnd('19:30', { ...s2, reason: 'logout' }),
      ]),
    );
    expect(result.map(({ id, endedAt, endReason }) => ({ id, endedAt, endReason }))).toEqual([
      { id: S1, endedAt: timeOf('19:02'), endReason: 'hop' },
      { id: S2, endedAt: timeOf('19:30'), endReason: 'logout' },
    ]);
  });

  it('uses the first session.end if more than one arrives', () => {
    const f = eventFactory();
    const [row] = sessionsOf(
      expectOrderIndependent([
        f.sessionStart('19:00'),
        f.sessionEnd('19:40', { reason: 'client_closed' }),
        f.sessionEnd('19:30', { reason: 'logout' }),
      ]),
    );
    expect(row).toMatchObject({ endedAt: timeOf('19:30'), endReason: 'logout' });
  });

  it('keeps ended_at at session.end when heartbeats come after it', () => {
    const f = eventFactory();
    const [row] = sessionsOf(
      expectOrderIndependent([
        f.sessionStart('19:00'),
        f.sessionEnd('19:30'),
        f.heartbeat('19:31'),
      ]),
    );
    expect(row).toMatchObject({
      endedAt: timeOf('19:30'),
      endReason: 'logout',
      lastHeartbeatAt: timeOf('19:31'),
      durationSeconds: 1800,
    });
  });

  it('times out a session without session.end (crash) and keeps a recent one open', () => {
    const f = eventFactory();
    const s2 = { sessionId: S2 };
    const result = sessionsOf(
      expectOrderIndependent([
        // Crashed yesterday.
        f.sessionStart('19:00'),
        f.heartbeat('19:01'),
        f.heartbeat('19:02'),
        f.afk('19:01', '19:02'),
        // Still playing: last heartbeat 5 minutes before the clock.
        f.sessionStart(minutesAgo(30), s2),
        f.heartbeat(minutesAgo(5), s2),
      ]),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: S1,
        endedAt: timeOf('19:02'),
        endReason: 'timeout',
        durationSeconds: 120,
        afkSeconds: 60,
        activeSeconds: 60,
      }),
      expect.objectContaining({
        id: S2,
        endedAt: null,
        endReason: null,
        lastHeartbeatAt: minutesAgo(5),
        durationSeconds: 25 * 60,
      }),
    ]);
  });

  it('creates the session from a heartbeat or AFK event that comes before session.start', () => {
    const f = eventFactory();
    const start = f.sessionStart('19:00', { displayName: 'Test Main' });
    const heartbeat = f.heartbeat('19:05', { payload: { world: 301 } });
    const afk = f.afk('18:59', '19:03');
    const end = f.sessionEnd('19:10');

    // Before the start arrives: the AFK period's start and the heartbeat's world.
    const run = emptyRun();
    ingestBatch(run, [afk]);
    expect(sessionRow(run)).toMatchObject({
      startedAt: timeOf('18:59'),
      world: null,
      endReason: 'timeout',
    });
    ingestBatch(run, [heartbeat, end]);
    expect(sessionRow(run)).toMatchObject({
      startedAt: timeOf('18:59'),
      world: 301,
      endedAt: timeOf('19:10'),
      afkSeconds: 240,
    });
    // The start fixes the start time and world.
    ingestBatch(run, [start]);
    expect(sessionRow(run)).toMatchObject({
      startedAt: timeOf('19:00'),
      world: 420,
      endedAt: timeOf('19:10'),
      durationSeconds: 600,
      afkSeconds: 180,
    });

    expectOrderIndependent([start, heartbeat, afk, end]);
  });

  it('counts AFK time before the first heartbeat when session.start is missing', () => {
    const f = eventFactory();
    const [row] = sessionsOf(
      expectOrderIndependent([
        f.afk('19:00', '19:20'),
        f.heartbeat('19:21'),
        f.sessionEnd('19:30'),
      ]),
    );
    expect(row).toMatchObject({
      startedAt: timeOf('19:00'),
      durationSeconds: 30 * 60,
      afkSeconds: 20 * 60,
      activeSeconds: 10 * 60,
    });
  });

  it('gives the same result for several accounts and sessions however they arrive', () => {
    const f = eventFactory();
    const other = { accountHash: '987654321', sessionId: sessionIdOf(3) };
    const s2 = { sessionId: S2 };
    expectOrderIndependent(
      [
        f.sessionStart('19:00'),
        f.heartbeat('19:01'),
        f.afk('19:01', '19:20'),
        f.heartbeat('19:21'),
        f.kc('19:22'),
        f.sessionEnd('19:30', { reason: 'hop' }),
        f.sessionStart('19:30', s2),
        f.heartbeat('19:31', s2),
        f.heartbeat('19:32', s2),
        f.sessionStart(minutesAgo(20), other),
        f.heartbeat(minutesAgo(11), other),
        f.afk(minutesAgo(15), minutesAgo(12), other),
        f.heartbeat(minutesAgo(9), other),
      ],
      { shuffles: 40, seed: 7 },
    );
  });
});

describe('session timeout', () => {
  it('closes a crashed session after 10 minutes without heartbeats', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(
      run,
      [f.sessionStart('19:00'), f.heartbeat('19:01'), f.heartbeat('19:02')],
      PROJECTIONS,
      plus('19:02', 0),
    );
    expect(sessionRow(run)).toMatchObject({ endedAt: null, endReason: null });

    expect(closeTimedOutSessions(run.database.db, plus('19:02', SESSION_TIMEOUT_MS - 1))).toBe(0);
    expect(sessionRow(run)).toMatchObject({ endedAt: null });

    expect(closeTimedOutSessions(run.database.db, plus('19:02', SESSION_TIMEOUT_MS))).toBe(1);
    expect(sessionRow(run)).toMatchObject({
      endedAt: timeOf('19:02'),
      endReason: 'timeout',
      durationSeconds: 120,
    });
    // Closed sessions are not looked at again.
    expect(closeTimedOutSessions(run.database.db, plus('23:00', 0))).toBe(0);
  });

  it('counts only sessions it actually closed', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(
      run,
      [f.sessionStart('19:00'), f.heartbeat('19:20')],
      PROJECTIONS,
      plus('19:20', 0),
    );
    // A stale row (e.g. edited by hand) whose heartbeats say it is still open.
    run.database.db
      .update(sessions)
      .set({ lastHeartbeatAt: timeOf('19:00') })
      .run();

    expect(closeTimedOutSessions(run.database.db, plus('19:25', 0))).toBe(0);
    expect(sessionRow(run)).toMatchObject({ endedAt: null, lastHeartbeatAt: timeOf('19:20') });
  });

  it('replaces a timeout with a session.end that arrives later', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(
      run,
      [f.sessionStart('19:00'), f.heartbeat('19:02')],
      PROJECTIONS,
      plus('19:02', 0),
    );
    closeTimedOutSessions(run.database.db, plus('19:30', 0));
    expect(sessionRow(run)).toMatchObject({ endReason: 'timeout' });

    ingestBatch(
      run,
      [f.sessionEnd('19:03', { reason: 'client_closed' })],
      PROJECTIONS,
      plus('19:31', 0),
    );
    expect(sessionRow(run)).toMatchObject({
      endedAt: timeOf('19:03'),
      endReason: 'client_closed',
      durationSeconds: 180,
    });
  });

  it('extends a timed-out session with old backlog heartbeats', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(
      run,
      [f.sessionStart('19:00'), f.heartbeat('19:02')],
      PROJECTIONS,
      plus('19:02', 0),
    );
    closeTimedOutSessions(run.database.db, plus('19:20', 0));

    // Queued heartbeats from before a network outage arrive at 20:00.
    ingestBatch(run, [f.heartbeat('19:03'), f.heartbeat('19:04')], PROJECTIONS, plus('20:00', 0));
    expect(sessionRow(run)).toMatchObject({
      endedAt: timeOf('19:04'),
      endReason: 'timeout',
      lastHeartbeatAt: timeOf('19:04'),
      durationSeconds: 240,
    });
  });

  it('reopens a timed-out session when recent heartbeats arrive', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(
      run,
      [f.sessionStart('19:00'), f.heartbeat('19:02')],
      PROJECTIONS,
      plus('19:02', 0),
    );
    closeTimedOutSessions(run.database.db, plus('19:20', 0));
    expect(sessionRow(run)).toMatchObject({ endReason: 'timeout' });

    // Network came back: the backlog includes a heartbeat from a minute ago.
    ingestBatch(run, [f.heartbeat('19:10'), f.heartbeat('19:20')], PROJECTIONS, plus('19:21', 0));
    expect(sessionRow(run)).toMatchObject({
      endedAt: null,
      endReason: null,
      lastHeartbeatAt: timeOf('19:20'),
      durationSeconds: 20 * 60,
    });
  });

  it('gives the same rows from a rebuild as from ingest plus the timeout job', () => {
    const f = eventFactory();
    const events = [
      f.sessionStart('19:00'),
      f.heartbeat('19:02'),
      f.sessionStart('19:00', { sessionId: S2 }),
      f.heartbeat('19:15', { sessionId: S2 }),
    ];
    const now = plus('19:20', 0);
    const run = emptyRun();
    ingestBatch(run, events, PROJECTIONS, plus('19:15', 0));
    closeTimedOutSessions(run.database.db, now);

    const rebuilt = runRebuild(events, PROJECTIONS, now);

    const rows = (r: TestRun) => r.database.db.select().from(sessions).all();
    expect(rows(run)).toEqual(rows(rebuilt));
    expect(rows(run).map((row) => row.endReason)).toEqual(['timeout', null]);
  });
});

describe('estimateAfkPeriods', () => {
  const range = (from: string, to: string) => ({ startedAt: timeOf(from), endedAt: timeOf(to) });

  it('keeps a run no real period touches', () => {
    expect(estimateAfkPeriods([range('19:02', '19:06')], [])).toEqual([range('19:02', '19:06')]);
  });

  it('removes only the parts real periods cover', () => {
    expect(
      estimateAfkPeriods(
        [range('19:00', '19:30')],
        [range('18:50', '19:05'), range('19:10', '19:12'), range('19:11', '19:15')],
      ),
    ).toEqual([range('19:05', '19:10'), range('19:15', '19:30')]);
  });

  it('leaves nothing when a real period covers the whole run', () => {
    expect(estimateAfkPeriods([range('19:02', '19:06')], [range('19:00', '19:06')])).toEqual([]);
  });

  it('counts a real period as [start, end): one ending at the run start takes nothing', () => {
    expect(estimateAfkPeriods([range('19:02', '19:06')], [range('18:00', '19:02')])).toEqual([
      range('19:02', '19:06'),
    ]);
  });
});

describe('AFK estimate from idle heartbeats', () => {
  interface WithEstimates {
    sessions: SnapshotSession[];
    afkEstimates: { sessionId: string; startedAt: string; endedAt: string }[];
  }
  const idle = { payload: { idle: true } };
  const estimate = (from: string, to: string, sessionId = S1) => ({
    sessionId,
    startedAt: timeOf(from),
    endedAt: timeOf(to),
  });

  it('counts an ongoing idle run in an open session as AFK', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart(minutesAgo(10)),
      f.heartbeat(minutesAgo(9)),
      f.heartbeat(minutesAgo(4), idle),
      f.heartbeat(minutesAgo(3), idle),
      f.heartbeat(minutesAgo(2), idle),
      f.heartbeat(minutesAgo(1), idle),
    ]).sessions as WithEstimates;
    expect(snapshot.afkEstimates).toEqual([estimate(minutesAgo(4), minutesAgo(1))]);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        endedAt: null,
        durationSeconds: 9 * 60,
        afkSeconds: 3 * 60,
        activeSeconds: 6 * 60,
      }),
    ]);
  });

  it('replaces the estimate with the real session.afk, whichever arrives first', () => {
    const f = eventFactory();
    const start = f.sessionStart('19:00');
    const beats = [
      f.heartbeat('19:01'),
      f.heartbeat('19:07', idle),
      f.heartbeat('19:08', idle),
      f.heartbeat('19:09', idle),
    ];
    const afk = f.afk('19:02', '2026-11-08T19:09:30.000Z');
    const end = f.sessionEnd('19:10');
    const now = plus('19:10', 60_000);

    // Heartbeats first: the estimate, then the real period replaces it.
    const late = emptyRun();
    ingestBatch(late, [start, ...beats], undefined, now);
    expect(sessionRow(late)?.afkSeconds).toBe(120);
    ingestBatch(late, [afk, end], undefined, now);
    // The real period: 19:02 to 19:09:30.
    expect(sessionRow(late)?.afkSeconds).toBe(7 * 60 + 30);

    // The real period first: never an estimate.
    const early = emptyRun();
    ingestBatch(early, [start, afk, end], undefined, now);
    ingestBatch(early, beats, undefined, now);
    expect(sessionRow(early)?.afkSeconds).toBe(7 * 60 + 30);

    const snapshot = expectOrderIndependent([start, ...beats, afk, end]).sessions as WithEstimates;
    expect(snapshot.afkEstimates).toEqual([]);
    expect(snapshot.sessions[0]?.afkSeconds).toBe(7 * 60 + 30);
  });

  it('keeps a trailing idle run as AFK when the session times out', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('19:00'),
      f.heartbeat('19:01'),
      f.heartbeat('19:02', idle),
      f.heartbeat('19:03', idle),
      f.heartbeat('19:04', idle),
      f.heartbeat('19:05', idle),
      f.heartbeat('19:06', idle),
    ]).sessions as WithEstimates;
    expect(snapshot.afkEstimates).toEqual([estimate('19:02', '19:06')]);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        endedAt: timeOf('19:06'),
        endReason: 'timeout',
        durationSeconds: 6 * 60,
        afkSeconds: 4 * 60,
        activeSeconds: 2 * 60,
      }),
    ]);
  });

  it('estimates idle runs in the middle only where no real period covers them', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('19:00'),
      // A run with its real period.
      f.heartbeat('19:05', idle),
      f.heartbeat('19:06', idle),
      f.heartbeat('19:07', idle),
      f.afk('19:00', '2026-11-08T19:07:30.000Z'),
      f.heartbeat('19:08'),
      // A run without one (the plugin never sent it).
      f.heartbeat('19:20', idle),
      f.heartbeat('19:21', idle),
      f.heartbeat('19:22', idle),
      f.heartbeat('19:23'),
      f.sessionEnd('19:30'),
    ]).sessions as WithEstimates;
    expect(snapshot.afkEstimates).toEqual([estimate('19:20', '19:22')]);
    // 7.5 minutes real, 2 minutes estimated.
    expect(snapshot.sessions[0]?.afkSeconds).toBe(7 * 60 + 30 + 2 * 60);
  });

  it('keeps the part of a run after a real period as a new estimate', () => {
    // Short AFK threshold: one period ended and the next began between two
    // heartbeats, so they share one run with no active heartbeat between.
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('19:00'),
      f.heartbeat('19:01'),
      f.heartbeat('19:02', idle),
      f.heartbeat('19:03', idle),
      f.heartbeat('19:04', idle),
      f.heartbeat('19:05', idle),
      f.heartbeat('19:06', idle),
      f.afk('19:01', '2026-11-08T19:03:30.000Z'),
      f.sessionEnd('19:07'),
    ]).sessions as WithEstimates;
    expect(snapshot.afkEstimates).toEqual([estimate('2026-11-08T19:03:30.000Z', '19:06')]);
    // 2.5 minutes real, 2.5 minutes estimated.
    expect(snapshot.sessions[0]?.afkSeconds).toBe(5 * 60);
  });

  it('stores nothing for a run of one idle heartbeat', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('19:00'),
      f.heartbeat('19:01'),
      f.heartbeat('19:02', idle),
      f.heartbeat('19:03'),
      f.sessionEnd('19:04'),
    ]).sessions as WithEstimates;
    expect(snapshot.afkEstimates).toEqual([]);
    expect(snapshot.sessions[0]?.afkSeconds).toBe(0);
  });

  it('gives the same rows after a rebuild as from ingest plus the timeout job', () => {
    const f = eventFactory();
    const events = [
      f.sessionStart('19:00'),
      f.heartbeat('19:01', idle),
      f.heartbeat('19:02', idle),
      f.heartbeat('19:03', idle),
    ];
    const live = emptyRun();
    ingestBatch(live, events, undefined, plus('19:03', 60_000));
    expect(closeTimedOutSessions(live.database.db, TEST_NOW)).toBe(1);
    const rebuilt = runRebuild(events, PROJECTIONS, TEST_NOW);
    const sessionsSnapshot = (run: TestRun) =>
      PROJECTIONS.find((p) => p.name === 'sessions')?.snapshot(run.database.db);
    expect(sessionsSnapshot(live)).toEqual(sessionsSnapshot(rebuilt));
    expect((sessionsSnapshot(rebuilt) as WithEstimates).afkEstimates).toEqual([
      estimate('19:01', '19:03'),
    ]);
  });
});
