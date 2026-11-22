import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clogSourceRow, setClogSource } from '../clog/sync.js';
import { clogBody, RUNEPROFILE_ON, summaryBody, testSyncer } from '../clog/testing.js';
import { accountClogSources, accounts } from '../db/schema.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  TEST_ACCOUNT_HASH,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';
import { CLOG_CHECK_INTERVAL_MS, isSyncDue, startClogJob, type ClogJob } from './clog.js';

// The job on the real syncer and client, with a scripted RuneProfile.

const START = '2026-11-09T12:00:00.000Z';
const HASH_B = '2222222222';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let run: TestRun | undefined;
const jobs: ClogJob[] = [];
afterEach(() => {
  for (const job of jobs.splice(0)) job.stop();
  vi.useRealTimers();
  run?.database.close();
  run = undefined;
});

function setup(env: Record<string, string> = RUNEPROFILE_ON) {
  vi.useFakeTimers({ now: new Date(START) });
  run = emptyRun();
  const f = eventFactory();
  // Two accounts, both last seen the day before. Only the first has the source on.
  ingestBatch(run, [
    f.sessionStart('19:00', { displayName: 'Seed Main' }),
    f.sessionEnd('19:30'),
    f.sessionStart('20:00', {
      displayName: 'Seed Alt',
      accountHash: HASH_B,
      sessionId: sessionIdOf(2),
    }),
    f.sessionEnd('20:30', { accountHash: HASH_B, sessionId: sessionIdOf(2) }),
  ]);
  const db = run.database.db;
  const idOf = (hash: string) =>
    db.select().from(accounts).where(eq(accounts.accountHash, hash)).get()?.id ?? 0;
  const accountId = idOf(TEST_ACCOUNT_HASH);
  setClogSource(db, accountId, 'RUNEPROFILE', new Date());
  const clock = { now: () => new Date(), advance: () => undefined, set: () => undefined };
  const harness = testSyncer(db, testConfig(env), clock);
  harness.replies.summary = summaryBody(START);
  harness.replies.collectionLog = clogBody({ 13262: 1 });
  const start = () => {
    const job = startClogJob({
      db,
      syncer: harness.syncer,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    jobs.push(job);
    return job;
  };
  /** Moves the clock and lets the round that starts finish. */
  const advance = async (ms: number, job: ClogJob) => {
    await vi.advanceTimersByTimeAsync(ms);
    await job.idle();
    await harness.syncer.idle();
  };
  const syncs = () =>
    harness.requests.filter((request) => request.path.endsWith('/collection-log'));
  const testRun = run;
  const ingest = (events: Parameters<typeof ingestBatch>[1]) => {
    ingestBatch(testRun, events);
  };
  return { ...harness, db, f, accountId, otherId: idOf(HASH_B), start, advance, syncs, ingest };
}

describe('collection log job', () => {
  it('syncs an account that has never been tried, then every six hours', async () => {
    const t = setup();
    const job = t.start();
    await t.advance(0, job);
    expect(t.syncs().map((request) => request.at)).toEqual([START]);

    await t.advance(6 * HOUR - CLOG_CHECK_INTERVAL_MS, job);
    expect(t.syncs()).toHaveLength(1);
    await t.advance(CLOG_CHECK_INTERVAL_MS, job);
    expect(t.syncs().map((request) => request.at)).toEqual([START, '2026-11-09T18:00:00.000Z']);
  });

  it('only ever looks up accounts with the source turned on', async () => {
    const t = setup();
    const job = t.start();
    await t.advance(13 * HOUR, job);
    expect(t.requests.length).toBeGreaterThan(0);
    for (const request of t.requests)
      expect(request.path).toMatch(/^\/v1\/accounts\/Seed%20Main(\/|$)/);
    expect(clogSourceRow(t.db, t.otherId)).toBeNull();
  });

  it('syncs two minutes after a session ends, not after a world hop', async () => {
    const t = setup();
    const job = t.start();
    await t.advance(0, job);
    expect(t.syncs()).toHaveLength(1);

    // A session from 12:10 that hops at 12:20 and ends at 12:30.
    const a = { sessionId: sessionIdOf(3) };
    const b = { sessionId: sessionIdOf(4) };
    await t.advance(20 * MINUTE, job);
    t.ingest([
      t.f.sessionStart('2026-11-09T12:10:00.000Z', { displayName: 'Seed Main', ...a }),
      t.f.sessionEnd('2026-11-09T12:20:00.000Z', { reason: 'hop', ...a }),
      t.f.sessionStart('2026-11-09T12:20:01.000Z', { displayName: 'Seed Main', ...b }),
    ]);
    await t.advance(9 * MINUTE, job);
    expect(t.syncs()).toHaveLength(1);

    t.ingest([t.f.sessionEnd('2026-11-09T12:30:00.000Z', b)]);
    await t.advance(2 * MINUTE, job); // 12:31: one minute after the end
    expect(t.syncs()).toHaveLength(1);
    await t.advance(MINUTE, job); // 12:32
    expect(t.syncs().map((request) => request.at)).toEqual([START, '2026-11-09T12:32:00.000Z']);
    // Once per ended session.
    await t.advance(30 * MINUTE, job);
    expect(t.syncs()).toHaveLength(2);
  });

  it('makes no extra request after a restart, also when the last attempt failed', async () => {
    const t = setup();
    t.replies.collectionLog = 404;
    const first = t.start();
    await t.advance(0, first);
    expect(t.syncs()).toHaveLength(1);
    first.stop();

    const second = t.start();
    await t.advance(5 * HOUR, second);
    expect(t.syncs()).toHaveLength(1);
    await t.advance(HOUR, second);
    expect(t.syncs()).toHaveLength(2);
  });

  it.each([
    ['the flag is off', { USER_AGENT_CONTACT: 'you@example.com' }],
    ['there is no contact', { RUNEPROFILE_ENABLED: 'true' }],
  ])('does nothing when %s', async (_name, env) => {
    const t = setup(env);
    const job = t.start();
    await t.advance(13 * HOUR, job);
    expect(t.requests).toEqual([]);
    expect(clogSourceRow(t.db, t.accountId)?.lastAttemptAt).toBeNull();
  });

  it('stops asking when the source is turned off for the account', async () => {
    const t = setup();
    const job = t.start();
    await t.advance(0, job);
    setClogSource(t.db, t.accountId, null, new Date());
    await t.advance(13 * HOUR, job);
    expect(t.syncs()).toHaveLength(1);
  });
});

describe('isSyncDue', () => {
  it('is due when the last attempt is in the future (the clock was changed)', () => {
    const t = setup();
    t.db.update(accountClogSources).set({ lastAttemptAt: '2027-01-01T00:00:00.000Z' }).run();
    const row = clogSourceRow(t.db, t.accountId);
    expect(row && isSyncDue(t.db, row, Date.parse(START))).toBe(true);
  });

  it('is not due for a session that ended before the last attempt', () => {
    const t = setup();
    t.db.update(accountClogSources).set({ lastAttemptAt: '2026-11-09T12:30:00.000Z' }).run();
    const row = clogSourceRow(t.db, t.accountId);
    expect(row && isSyncDue(t.db, row, Date.parse('2026-11-09T13:00:00.000Z'))).toBe(false);
  });

  it('is due when nothing has been tried since the source was last turned on', () => {
    const t = setup();
    // Turned on at 12:00 (setup); the last attempt is from an earlier opt-in.
    t.db.update(accountClogSources).set({ lastAttemptAt: '2026-11-09T11:59:00.000Z' }).run();
    const row = clogSourceRow(t.db, t.accountId);
    expect(row && isSyncDue(t.db, row, Date.parse(START))).toBe(true);
  });
});
