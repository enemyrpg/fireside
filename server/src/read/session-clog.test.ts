import { sessionDetailResponseSchema, sessionsResponseSchema, type Event } from '@fireside/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { storeExternalSnapshot } from '../clog/project.js';
import { recordClogRead } from '../clog/reads.js';
import { clogBody, feedBody } from '../clog/testing.js';
import { accounts } from '../db/schema.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  type TestRun,
} from '../projections/testing.js';
import { POST_SESSION_SYNC_WINDOW_MS } from './session-clog.js';
import { listSessions, sessionDetail } from './sessions.js';

// Which session a new collection log item belongs to. One account, one day,
// each session followed by the read the server's job makes about two minutes
// after it ends, unless that read failed.

const HASH = '1111111111';
const NOW = new Date('2026-11-16T22:40:00.000Z');
const f = eventFactory();
const T = (time: string) => `2026-11-16T${time}.000Z`;

const ID = {
  s1: sessionIdOf(1),
  s2: sessionIdOf(2),
  s3: sessionIdOf(3),
  s4: sessionIdOf(4),
  hopFirst: sessionIdOf(5),
  hopLast: sessionIdOf(6),
  s7: sessionIdOf(7),
  s8: sessionIdOf(8),
  open: sessionIdOf(9),
};

function session(
  sessionId: string,
  start: string,
  end: string,
  reason: 'logout' | 'hop' = 'logout',
): Event[] {
  const options = { accountHash: HASH, sessionId };
  return [
    f.sessionStart(T(start), options),
    f.heartbeat(T(end), options),
    f.sessionEnd(T(end), { ...options, reason }),
  ];
}

const EVENTS: Event[] = [
  ...session(ID.s1, '10:00:00', '11:00:00'),
  ...session(ID.s2, '12:00:00', '13:00:00'),
  // Its read failed: nothing read until after s4.
  ...session(ID.s3, '14:00:00', '15:00:00'),
  ...session(ID.s4, '16:00:00', '17:00:00'),
  // A world hop: two parts 20 seconds apart.
  ...session(ID.hopFirst, '18:00:00', '18:30:00', 'hop'),
  ...session(ID.hopLast, '18:30:20', '19:00:00'),
  ...session(ID.s7, '20:00:00', '21:00:00'),
  ...session(ID.s8, '22:00:00', '22:30:00'),
  // Started before the read at 22:33 and still open.
  f.sessionStart(T('22:31:00'), { accountHash: HASH, sessionId: ID.open }),
  f.heartbeat(T('22:38:00'), { accountHash: HASH, sessionId: ID.open }),
];

/** Items: the whip was there at the first read; the rest are new, one per case. */
const ITEM = {
  whip: 4151,
  orphan: 13262,
  jar: 13277,
  visage: 22006,
  vorki: 21992,
  exactInS2: 30001,
  late: 30002,
  beforeOpen: 30003,
};
const EXTRA = [
  { id: ITEM.exactInS2, name: 'Exact item', quantity: 0 },
  { id: ITEM.late, name: 'Late item', quantity: 0 },
  { id: ITEM.beforeOpen, name: 'Open item', quantity: 0 },
];

let hashCounter = 0;

function accountId(run: TestRun): number {
  const row = run.database.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.accountHash, HASH))
    .get();
  if (!row) throw new Error('No account');
  return row.id;
}

/** A successful read at `time` with the items held then, as the sync stores it. */
function read(
  run: TestRun,
  time: string,
  has: readonly number[],
  feed: [number, string][] = [],
  { recordRead = true } = {},
): void {
  const id = accountId(run);
  const fetchedAt = T(time);
  run.database.db.transaction((tx) => {
    if (recordRead) recordClogRead(tx, id, fetchedAt);
    hashCounter += 1;
    storeExternalSnapshot(tx, {
      source: 'RUNEPROFILE',
      kind: 'COLLECTION_LOG',
      accountId: id,
      fetchedAt,
      contentHash: `sha256:${hashCounter.toString(16).padStart(64, '0')}`,
      body: clogBody(Object.fromEntries(has.map((item) => [item, 1])), {
        extraItems: EXTRA.map((extra) => ({ ...extra, quantity: has.includes(extra.id) ? 1 : 0 })),
      }),
    });
    if (feed.length > 0) {
      hashCounter += 1;
      storeExternalSnapshot(tx, {
        source: 'RUNEPROFILE',
        kind: 'ACTIVITIES',
        accountId: id,
        fetchedAt,
        contentHash: `sha256:${hashCounter.toString(16).padStart(64, '0')}`,
        body: feedBody(feed),
      });
    }
  });
}

/** Records a read that found nothing new (not stored, as in the sync). */
function unchangedRead(run: TestRun, time: string): void {
  recordClogRead(run.database.db, accountId(run), T(time));
}

function day({ recordReads = true } = {}): TestRun {
  const run = emptyRun();
  ingestBatch(run, EVENTS, undefined, NOW);
  expect(run.failed).toEqual([]);
  const options = { recordRead: recordReads };
  read(run, '11:02:30', [ITEM.whip], [], options);
  // s2's read: an approximate item and one the feed has the exact time for.
  read(
    run,
    '13:02:30',
    [ITEM.whip, ITEM.orphan, ITEM.exactInS2],
    [[ITEM.exactInS2, T('12:30:00')]],
    options,
  );
  // s3's read failed. s4's read finds the jar, which may be from s3 or s4.
  read(run, '17:02:30', [ITEM.whip, ITEM.orphan, ITEM.exactInS2, ITEM.jar], [], options);
  // After the hop chain: the visage (approximate) and Vorki between the parts.
  read(
    run,
    '19:02:30',
    [ITEM.whip, ITEM.orphan, ITEM.exactInS2, ITEM.jar, ITEM.visage, ITEM.vorki],
    [[ITEM.vorki, T('18:30:10')]],
    options,
  );
  // s7's read comes 30 minutes late: past the window.
  read(
    run,
    '21:30:00',
    [ITEM.whip, ITEM.orphan, ITEM.exactInS2, ITEM.jar, ITEM.visage, ITEM.vorki, ITEM.late],
    [],
    options,
  );
  // s8's read comes after the next session started.
  read(
    run,
    '22:33:00',
    [
      ITEM.whip,
      ITEM.orphan,
      ITEM.exactInS2,
      ITEM.jar,
      ITEM.visage,
      ITEM.vorki,
      ITEM.late,
      ITEM.beforeOpen,
    ],
    [],
    options,
  );
  return run;
}

function itemsOf(run: TestRun, sessionId: string) {
  const detail = sessionDetail(run.database.db, [accountId(run)], sessionId);
  if (!detail) throw new Error(`No session ${sessionId}`);
  sessionDetailResponseSchema.parse(detail);
  return detail.collectionLog.items.map((item) => ({
    itemId: item.itemId,
    at: item.at,
    approximate: item.approximate,
  }));
}

function counts(run: TestRun): Record<string, number> {
  const page = listSessions(run.database.db, { accountIds: [accountId(run)], limit: 50 });
  sessionsResponseSchema.parse(page);
  return Object.fromEntries(page.items.map((s) => [s.id, s.newCollectionLogCount]));
}

describe('new collection log items per session', () => {
  it('a window of 15 minutes: a timed-out session is closed 10 minutes after its last heartbeat', () => {
    expect(POST_SESSION_SYNC_WINDOW_MS).toBe(15 * 60_000);
  });

  it('ties an exact time to the session that contains it, and an approximate one to the session that just ended', () => {
    const run = day();
    expect(itemsOf(run, ID.s2)).toEqual([
      { itemId: ITEM.exactInS2, at: T('12:30:00'), approximate: false },
      { itemId: ITEM.orphan, at: T('13:02:30'), approximate: true },
    ]);
    expect(itemsOf(run, ID.s1)).toEqual([]);
  });

  it('ties nothing when an earlier session’s read failed (the item may be from either)', () => {
    const run = day();
    expect(itemsOf(run, ID.s3)).toEqual([]);
    expect(itemsOf(run, ID.s4)).toEqual([]);
  });

  it('ties an approximate item to the last part of a hop chain, and an exact time between the parts to none', () => {
    const run = day();
    expect(itemsOf(run, ID.hopLast)).toEqual([
      { itemId: ITEM.visage, at: T('19:02:30'), approximate: true },
    ]);
    expect(itemsOf(run, ID.hopFirst)).toEqual([]);
  });

  it('ties nothing past the window, or when a new session started before the read', () => {
    const run = day();
    expect(itemsOf(run, ID.s7)).toEqual([]);
    expect(itemsOf(run, ID.s8)).toEqual([]);
    expect(itemsOf(run, ID.open)).toEqual([]);
  });

  it('gives the list the same counts as the detail', () => {
    const run = day();
    expect(counts(run)).toEqual({
      [ID.s1]: 0,
      [ID.s2]: 2,
      [ID.s3]: 0,
      [ID.s4]: 0,
      [ID.hopFirst]: 0,
      [ID.hopLast]: 1,
      [ID.s7]: 0,
      [ID.s8]: 0,
      [ID.open]: 0,
    });
  });

  it('uses a read that found nothing new: the failed read’s gap closes when a later read is recorded', () => {
    const run = emptyRun();
    ingestBatch(run, EVENTS, undefined, NOW);
    read(run, '11:02:30', [ITEM.whip]);
    // s2 and s3 found nothing new; their reads are recorded but not stored.
    unchangedRead(run, '13:02:30');
    unchangedRead(run, '15:02:30');
    read(run, '17:02:30', [ITEM.whip, ITEM.jar]);
    expect(itemsOf(run, ID.s4)).toEqual([
      { itemId: ITEM.jar, at: T('17:02:30'), approximate: true },
    ]);
  });

  it('without recorded reads (an older database) uses the previous stored collection log', () => {
    const run = day({ recordReads: false });
    // s2: the previous stored log is s1's read, so the orphan is s2's.
    expect(itemsOf(run, ID.s2).map((item) => item.itemId)).toEqual([ITEM.exactInS2, ITEM.orphan]);
    expect(itemsOf(run, ID.s4)).toEqual([]);
  });

  it('counts an exact time in an open session up to its last heartbeat', () => {
    const run = day();
    read(
      run,
      '22:39:00',
      [
        ITEM.whip,
        ITEM.orphan,
        ITEM.exactInS2,
        ITEM.jar,
        ITEM.visage,
        ITEM.vorki,
        ITEM.late,
        ITEM.beforeOpen,
        ITEM.orphan,
      ],
      [[ITEM.beforeOpen, T('22:35:00')]],
    );
    expect(itemsOf(run, ID.open)).toEqual([
      { itemId: ITEM.beforeOpen, at: T('22:35:00'), approximate: false },
    ]);
  });

  it('finds the session before a hop chain whose parts share a start time (review)', () => {
    // Odd data: two parts with the same `started_at`, the first ending with a
    // hop. The session before them ended after the previous read, so the item
    // may be from it: tied to none.
    const run = emptyRun();
    const [old, first, second] = [sessionIdOf(30), sessionIdOf(31), sessionIdOf(32)];
    ingestBatch(
      run,
      [
        ...session(old, '10:00:00', '11:00:00'),
        ...session(first, '12:00:00', '12:30:00', 'hop'),
        f.sessionStart(T('12:00:00'), { accountHash: HASH, sessionId: second }),
        f.heartbeat(T('13:00:00'), { accountHash: HASH, sessionId: second }),
        f.sessionEnd(T('13:00:00'), { accountHash: HASH, sessionId: second }),
      ],
      undefined,
      NOW,
    );
    read(run, '09:00:00', [ITEM.whip]);
    read(run, '13:02:30', [ITEM.whip, ITEM.jar]);
    expect(itemsOf(run, second)).toEqual([]);
    expect(itemsOf(run, first)).toEqual([]);
  });

  it('gives the same answers after a rebuild', () => {
    const run = day();
    const before = {
      list: counts(run),
      detail: itemsOf(run, ID.s2),
      hop: itemsOf(run, ID.hopLast),
    };
    rebuildDerivedTables(run.database.db, { now: () => NOW });
    expect({
      list: counts(run),
      detail: itemsOf(run, ID.s2),
      hop: itemsOf(run, ID.hopLast),
    }).toEqual(before);
  });

  it('the Rondache case: a feed time inside a long session gives one item in the detail and a count of 1', () => {
    // As on the live instance: 18:03–22:15 UTC, feed time 21:39:58.802.
    const run = emptyRun();
    const rondache = sessionIdOf(20);
    const options = { accountHash: HASH, sessionId: rondache };
    ingestBatch(
      run,
      [
        f.sessionStart('2026-11-16T18:03:28.795Z', options),
        f.heartbeat('2026-11-16T22:15:47.000Z', options),
        f.sessionEnd('2026-11-16T22:15:47.000Z', options),
      ],
      undefined,
      NOW,
    );
    read(run, '18:00:00', [ITEM.whip]);
    read(
      run,
      '22:18:00',
      [ITEM.whip, ITEM.exactInS2],
      [[ITEM.exactInS2, '2026-11-16T21:39:58.802Z']],
    );
    expect(itemsOf(run, rondache)).toEqual([
      { itemId: ITEM.exactInS2, at: '2026-11-16T21:39:58.802Z', approximate: false },
    ]);
    expect(counts(run)[rondache]).toBe(1);
  });
});
