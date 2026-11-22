import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { sessions } from '../db/schema.js';
import { PROJECTIONS } from '../projections/index.js';
import { SESSION_TIMEOUT_MS } from '../projections/sessions.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  timeOf,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';
import { SESSION_TIMEOUT_INTERVAL_MS, startSessionTimeoutJob } from './session-timeout.js';

const LAST_HEARTBEAT = new Date(timeOf('19:02'));

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A run with one open session whose last heartbeat is at 19:02. */
function openSession(): TestRun {
  const f = eventFactory();
  const run = emptyRun();
  ingestBatch(run, [f.sessionStart('19:00'), f.heartbeat('19:02')], PROJECTIONS, LAST_HEARTBEAT);
  return run;
}

function endReason(run: TestRun) {
  return run.database.db.select().from(sessions).get()?.endReason;
}

describe('session timeout job', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at start and then every minute, with the injected clock', () => {
    const run = openSession();
    const log = logger();
    let now = new Date(LAST_HEARTBEAT.getTime() + SESSION_TIMEOUT_MS - 30_000);
    const job = startSessionTimeoutJob({ db: run.database.db, log, now: () => now });

    // At start: 9:30 without heartbeats, still open.
    expect(endReason(run)).toBeNull();

    now = new Date(now.getTime() + SESSION_TIMEOUT_INTERVAL_MS);
    vi.advanceTimersByTime(SESSION_TIMEOUT_INTERVAL_MS);
    expect(endReason(run)).toBe('timeout');
    expect(log.info).toHaveBeenCalledWith({ closed: 1 }, expect.any(String));
    job.stop();
  });

  it('closes stale sessions right away at start', () => {
    const run = openSession();
    const job = startSessionTimeoutJob({
      db: run.database.db,
      log: logger(),
      now: () => new Date(timeOf('23:00')),
    });
    expect(endReason(run)).toBe('timeout');
    job.stop();
  });

  it('stops running after stop()', () => {
    const run = openSession();
    const now = vi.fn(() => new Date(timeOf('19:03')));
    const job = startSessionTimeoutJob({ db: run.database.db, log: logger(), now });
    job.stop();
    job.stop();
    vi.advanceTimersByTime(10 * SESSION_TIMEOUT_INTERVAL_MS);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('logs an error and tries again on the next run', () => {
    const run = openSession();
    const log = logger();
    let fail = true;
    const job = startSessionTimeoutJob({
      db: run.database.db,
      log,
      now: () => {
        if (fail) throw new Error('clock broke');
        return new Date(timeOf('23:00'));
      },
    });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(endReason(run)).toBeNull();

    fail = false;
    vi.advanceTimersByTime(SESSION_TIMEOUT_INTERVAL_MS);
    expect(endReason(run)).toBe('timeout');
    job.stop();
  });
});

describe('app jobs option', () => {
  it('starts the job when the server listens', async () => {
    const run = openSession();
    const app = buildApp({ db: run.database, config: testConfig(), jobs: true });
    expect(endReason(run)).toBeNull();
    await app.listen({ host: '127.0.0.1', port: 0 });
    // Uses the real clock, which is long past 19:12 on 2026-11-08.
    expect(endReason(run)).toBe('timeout');
    await app.close();
  });

  it('does not run jobs by default', async () => {
    const run = openSession();
    const app = buildApp({ db: run.database, config: testConfig() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    expect(endReason(run)).toBeNull();
    await app.close();
  });
});
