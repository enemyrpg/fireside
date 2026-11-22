import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessions } from '../db/schema.js';
import { PROJECTIONS } from '../projections/index.js';
import { emptyRun, eventFactory, ingestBatch, storeOnly, timeOf } from '../projections/testing.js';
import { startBackgroundJobs } from './startup.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('startBackgroundJobs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('projects pending events before the timeout job looks at sessions', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(
      run,
      [f.sessionStart('19:00'), f.heartbeat('19:02')],
      PROJECTIONS,
      new Date(timeOf('19:02')),
    );
    // Stored before a crash, never projected.
    storeOnly(run, [f.heartbeat('19:20')]);

    const log = logger();
    const job = startBackgroundJobs({
      db: run.database.db,
      log,
      now: () => new Date(timeOf('19:25')),
    });
    expect(run.database.db.select().from(sessions).get()).toMatchObject({
      endedAt: null,
      lastHeartbeatAt: timeOf('19:20'),
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ processed: 1, failed: 0 }, 'Projected pending events');
    job.stop();
  });

  it('still starts the timeout job if pending projection fails', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(run, [f.sessionStart('19:00')], PROJECTIONS, new Date(timeOf('19:00')));
    // Loading pending events fails (e.g. a disk error); transactions still work.
    const db = new Proxy(run.database.db, {
      get(target, key, receiver) {
        if (key === 'select') throw new Error('disk error');
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const log = logger();

    const job = startBackgroundJobs({ db, log, now: () => new Date(timeOf('23:00')) });
    expect(log.error).toHaveBeenCalledWith(expect.anything(), 'Could not project pending events');
    expect(run.database.db.select().from(sessions).get()?.endReason).toBe('timeout');
    job.stop();
  });
});
