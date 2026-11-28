import { externalSourcesResponseSchema } from '@fireside/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { priceHourFetches } from '../db/schema.js';
import { createExternalClient } from '../external/client.js';
import { externalSourcesStatus } from '../external/state.js';
import {
  latestSettledHour,
  PRICE_CATCHUP_MAX,
  PRICE_HOUR_SETTLE_MS,
  PRICES_INTERVAL_MS,
} from '../prices/fetch.js';
import { currentWindow, priceBaselines } from '../prices/history.js';
import { hourResponse, storeHours } from '../prices/testing.js';
import { PROJECTIONS } from '../projections/index.js';
import { emptyRun, eventFactory, ingestBatch, type TestRun } from '../projections/testing.js';
import { testConfig } from '../test-utils.js';
import { PRICES_BACKGROUND_AFTER_MS, startPricesJob, type PricesJob } from './prices.js';

// The job with the real client (and its 10 s spacing) and a mocked fetch that
// answers `/1h` with a small synthetic hour. No real network.

const ON = { PRICES_ENABLED: 'true', USER_AGENT_CONTACT: 'you@example.com' };
/** 20 minutes past: the hour before is settled. */
const START = '2026-11-16T12:20:00.000Z';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVALS = { WIKI_PRICES: PRICES_INTERVAL_MS, RUNEPROFILE: 6 * HOUR };
const ms = (iso: string) => Date.parse(iso);
/** The longer simulations run days of minute checks: slower than the default 5 s on a busy machine. */
const SIMULATION_TIMEOUT_MS = 30_000;
const URL_START = 'https://prices.runescape.wiki/api/v2/osrs/1h?timestamp=';

describe('prices job', () => {
  let run: TestRun | undefined;
  const jobs: PricesJob[] = [];
  afterEach(() => {
    for (const job of jobs.splice(0)) job.stop();
    vi.useRealTimers();
    run?.database.close();
    run = undefined;
  });

  function setup(env: Record<string, string> = ON, start = START) {
    // A second setup in one test is a restart: the clock goes on.
    if (!vi.isFakeTimers()) vi.useFakeTimers({ now: new Date(start) });
    run ??= emptyRun();
    const testRun = run;
    const db = testRun.database.db;
    const config = testConfig(env);
    /** Each request: when it was made and the hour it asked for (epoch ms). */
    const requests: { at: number; hour: number }[] = [];
    const warnings: string[] = [];
    let status = 200;
    /** Hours whose next request answers 404, once. */
    const failOnce = new Set<number>();
    /** While set, responses wait until `release()` is called. */
    let held: (() => void)[] | undefined;
    const fetchMock = ((url: string) => {
      expect(url.startsWith(URL_START)).toBe(true);
      const hour = Number(url.slice(URL_START.length)) * SECOND;
      requests.push({ at: Date.now(), hour });
      const code = failOnce.delete(hour) ? 404 : status;
      const respond = () =>
        new Response(code === 200 ? JSON.stringify(hourResponse(hour)) : '', { status: code });
      if (held === undefined) return Promise.resolve(respond());
      const waiting = held;
      return new Promise<Response>((resolve) => {
        waiting.push(() => {
          resolve(respond());
        });
      });
    }) as unknown as typeof fetch;
    const log = {
      info: () => undefined,
      warn: (_obj: object, msg: string) => void warnings.push(msg),
      error: () => undefined,
    };
    const startJob = () => {
      const job = startPricesJob({
        db,
        config,
        client: createExternalClient({ config, log, fetch: fetchMock }),
        log,
      });
      jobs.push(job);
      return job;
    };
    const events = eventFactory();
    return {
      db,
      requests,
      warnings,
      start: startJob,
      setStatus: (next: number) => (status = next),
      failOnce: (hourMs: number) => failOnce.add(hourMs),
      hold: () => (held = []),
      release: () => {
        const waiting = held ?? [];
        held = undefined;
        for (const resolve of waiting) resolve();
      },
      /** Every settled hour of the last 48 is stored, as after a catch-up just now. */
      filled: () => {
        const latest = latestSettledHour(Date.now());
        storeHours(db, latest - (PRICE_CATCHUP_MAX - 1) * HOUR, PRICE_CATCHUP_MAX);
      },
      openSession: () => {
        ingestBatch(testRun, [events.sessionStart(new Date().toISOString())], PROJECTIONS);
      },
      endSession: () => {
        ingestBatch(testRun, [events.sessionEnd(new Date().toISOString())], PROJECTIONS);
      },
      status: () =>
        externalSourcesResponseSchema.parse(externalSourcesStatus(db, config, INTERVALS))
          .sources[0],
      stored: () => db.select().from(priceHourFetches).all().length,
    };
  }

  it('fills the last 48 hours at the first start, oldest first, 10 s apart', async () => {
    const t = setup();
    t.start();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    const latest = ms('2026-11-16T11:00:00.000Z');
    expect(t.requests).toHaveLength(PRICE_CATCHUP_MAX);
    expect(t.requests.map((r) => r.hour)).toEqual(
      Array.from({ length: PRICE_CATCHUP_MAX }, (_, i) => latest - (47 - i) * HOUR),
    );
    expect(t.requests[0]?.at).toBe(ms(START));
    // The source's minimum interval in the client spaces them: about 8 minutes.
    expect(t.requests.at(-1)?.at).toBe(ms(START) + 47 * 10 * SECOND);
    expect(t.stored()).toBe(PRICE_CATCHUP_MAX);
    expect(t.status()).toMatchObject({ enabled: true, active: true, lastError: null });
  });

  it('fetches nothing more while nobody reads prices and no session is open, until a day is missing', async () => {
    const t = setup();
    t.filled();
    t.start();
    // 12:10 the next day the 24th hour since the fill settles.
    expect(PRICES_BACKGROUND_AFTER_MS).toBe(DAY);
    await vi.advanceTimersByTimeAsync(ms('2026-11-17T12:09:00.000Z') - Date.now());
    expect(t.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    // One batch of the 24 missing hours, oldest first.
    expect(t.requests).toHaveLength(24);
    expect(t.requests[0]?.hour).toBe(ms('2026-11-16T12:00:00.000Z'));
    expect(t.requests.at(-1)?.hour).toBe(ms('2026-11-17T11:00:00.000Z'));
  });

  it('finishes a daily batch an hour after a failed request, not a day later', async () => {
    const t = setup();
    t.filled();
    t.start();
    // The third hour of the next daily batch fails once.
    t.failOnce(ms('2026-11-16T14:00:00.000Z'));
    await vi.advanceTimersByTimeAsync(ms('2026-11-17T12:20:00.000Z') - Date.now());
    expect(t.requests).toHaveLength(3);
    expect(t.status()?.lastError?.message).toContain('404');
    await vi.advanceTimersByTimeAsync(HOUR - 11 * MINUTE);
    expect(t.requests).toHaveLength(3);
    // An hour after the failure: the rest of the batch, from the hour that failed.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(t.requests[3]?.hour).toBe(ms('2026-11-16T14:00:00.000Z'));
    expect(t.requests).toHaveLength(3 + 23);
    expect(t.status()?.lastError).toBeNull();
  });

  it(
    'makes about 24 calls a day when idle, in one batch, and leaves no hour out',
    async () => {
      const t = setup();
      t.start();
      await vi.advanceTimersByTimeAsync(10 * DAY);
      const first = t.requests.length;
      const counts = Array.from(
        { length: 9 },
        (_, d) =>
          t.requests.filter(
            (r) => r.at >= ms(START) + (d + 1) * DAY && r.at < ms(START) + (d + 2) * DAY,
          ).length,
      );
      // The first catch-up, then one batch of 24 at 12:10 every day.
      expect(first).toBe(PRICE_CATCHUP_MAX + 10 * 24);
      expect(counts).toEqual(Array.from({ length: 9 }, () => 24));
      // Every hour asked for once.
      expect(new Set(t.requests.map((r) => r.hour)).size).toBe(t.requests.length);
      // Every day kept is complete: 7 d and 30 d are never left out for a gap.
      const window = currentWindow(t.db);
      expect(window?.complete).toBe(true);
    },
    SIMULATION_TIMEOUT_MS,
  );

  it('starts one catch-up for a read when an hour is missing, and none when nothing is', async () => {
    const t = setup();
    t.filled();
    const job = t.start();
    job.requested();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.requests).toEqual([]);
    // 13:10: the 12:00 hour settles.
    await vi.advanceTimersByTimeAsync(ms('2026-11-16T13:10:00.000Z') - Date.now());
    for (let i = 0; i < 20; i++) job.requested();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.requests.map((r) => r.hour)).toEqual([ms('2026-11-16T12:00:00.000Z')]);
    for (let i = 0; i < 20; i++) job.requested();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.requests).toHaveLength(1);
  });

  it('runs one catch-up at a time, however long a request takes', async () => {
    const t = setup();
    t.hold();
    const job = t.start();
    for (let i = 0; i < 10; i++) {
      job.requested();
      await vi.advanceTimersByTimeAsync(2 * HOUR);
    }
    t.openSession();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    // The first request of the catch-up is still waiting: nothing else was sent.
    expect(t.requests).toHaveLength(1);
    t.release();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    // Then the catch-up went on, one request after the other.
    expect(t.requests.length).toBeGreaterThan(1);
    const gaps = t.requests.slice(2).map((r, i) => r.at - (t.requests[i + 1]?.at ?? 0));
    expect(gaps.every((gap) => gap >= 10 * SECOND)).toBe(true);
  });

  it('fetches each new hour once it settles while a session is open, then stops', async () => {
    const t = setup();
    t.filled();
    t.openSession();
    t.start();
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(t.requests.map((r) => new Date(r.at).toISOString())).toEqual([
      '2026-11-16T13:10:00.000Z',
      '2026-11-16T14:10:00.000Z',
      '2026-11-16T15:10:00.000Z',
      '2026-11-16T16:10:00.000Z',
      '2026-11-16T17:10:00.000Z',
    ]);
    expect(PRICE_HOUR_SETTLE_MS).toBe(10 * MINUTE);
    t.endSession();
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(t.requests).toHaveLength(5);
  });

  it('stores a failure as lastError, keeps what it has and tries again no sooner than an hour', async () => {
    const t = setup();
    t.filled();
    t.openSession();
    t.setStatus(404);
    t.start();
    await vi.advanceTimersByTimeAsync(ms('2026-11-16T13:10:00.000Z') - Date.now());
    expect(t.requests).toHaveLength(1);
    expect(t.status()?.lastError?.message).toContain('404');
    expect(t.warnings).toContain('Price update failed, keeping the prices stored so far');
    expect(t.stored()).toBe(PRICE_CATCHUP_MAX);
    await vi.advanceTimersByTimeAsync(HOUR - MINUTE);
    expect(t.requests).toHaveLength(1);
    t.setStatus(200);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    // The hour that failed, then the one that settled since.
    expect(t.requests.map((r) => r.hour)).toEqual([
      ms('2026-11-16T12:00:00.000Z'),
      ms('2026-11-16T12:00:00.000Z'),
      ms('2026-11-16T13:00:00.000Z'),
    ]);
    expect(t.status()?.lastError).toBeNull();
  });

  it('fetches nothing twice after a restart', async () => {
    const t = setup();
    const job = t.start();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    job.stop();
    const second = setup();
    const again = second.start();
    again.requested();
    await vi.advanceTimersByTimeAsync(MINUTE);
    // Every hour is stored: nothing to ask for.
    expect(t.requests).toHaveLength(PRICE_CATCHUP_MAX);
    expect(second.requests).toEqual([]);
  });

  it('a stop ends the catch-up between requests and keeps what was stored', async () => {
    const t = setup();
    const job = t.start();
    await vi.advanceTimersByTimeAsync(25 * SECOND);
    job.stop();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    // Requests at 0, 10 and 20 s; the one waiting for its turn at 30 s still goes out.
    expect(t.requests).toHaveLength(4);
    expect(t.stored()).toBe(4);
    t.openSession();
    job.requested();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(t.requests).toHaveLength(4);
  });

  it.each([
    ['nothing is set', {}, 0],
    ['PRICES_ENABLED is off', { PRICES_ENABLED: 'false', USER_AGENT_CONTACT: 'a@b.example' }, 0],
    ['USER_AGENT_CONTACT is missing', { PRICES_ENABLED: 'true' }, 1],
  ])('never fetches when %s', async (_name, env, warnings) => {
    const t = setup(env);
    t.openSession();
    const job = t.start();
    for (let i = 0; i < 3; i++) {
      job.requested();
      await vi.advanceTimersByTimeAsync(DAY);
    }
    expect(t.requests).toEqual([]);
    expect(t.warnings).toHaveLength(warnings);
    expect(t.status()).toMatchObject({ active: false, lastFetchAt: null, nextFetchAt: null });
  });

  // The measurements in docs/decisions/0021-prices-from-hourly-volume-weighted-averages.md.
  describe('calls a day', () => {
    /** Requests per day from day `from` (0 = the day of START) for `days` days. */
    const perDay = (requests: readonly { at: number }[], from: number, days: number) =>
      Array.from(
        { length: days },
        (_, d) =>
          requests.filter(
            (r) => r.at >= ms(START) + (from + d) * DAY && r.at < ms(START) + (from + d + 1) * DAY,
          ).length,
      );

    it(
      'regular use: a visit and a 2 hour session every day',
      async () => {
        const t = setup();
        const job = t.start();
        // A fixed pseudo-random hour each day.
        let seed = 7;
        const next = () => (seed = (seed * 48_271) % 2_147_483_647);
        for (let d = 0; d < 14; d++) {
          const visit = next() % 24;
          await vi.advanceTimersByTimeAsync(visit * HOUR);
          job.requested();
          t.openSession();
          await vi.advanceTimersByTimeAsync(2 * HOUR);
          t.endSession();
          await vi.advanceTimersByTimeAsync((22 - visit) * HOUR);
        }
        // After the first catch-up, one request per hour that passed: 24 a day
        // on average, whenever the visit is.
        const days = perDay(t.requests, 1, 13);
        const average = (t.requests.length - PRICE_CATCHUP_MAX) / 14;
        expect(average).toBeGreaterThan(23);
        expect(average).toBeLessThanOrEqual(24);
        expect(Math.max(...days)).toBeLessThanOrEqual(PRICE_CATCHUP_MAX);
        expect(new Set(t.requests.map((r) => r.hour)).size).toBe(t.requests.length);
      },
      SIMULATION_TIMEOUT_MS,
    );

    it('after 3 days off: one catch-up of 48, and the hours before it are lost', async () => {
      const t = setup();
      const job = t.start();
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      job.stop();
      await vi.advanceTimersByTimeAsync(3 * DAY);
      const before = t.requests.length;
      const again = setup();
      again.start();
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(t.requests.length - before).toBe(0);
      expect(again.requests).toHaveLength(PRICE_CATCHUP_MAX);
      const window = currentWindow(again.db);
      expect(window?.complete).toBe(true);
      // Two full windows again: 24 h is back at once.
      expect(priceBaselines(again.db, window!).map((b) => b.period)).toEqual(['24h']); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- checked just above
    });

    it('never asks for an hour within an hour of a failed request', async () => {
      const t = setup();
      t.setStatus(404);
      const job = t.start();
      for (let i = 0; i < 5; i++) {
        job.requested();
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
      }
      expect(t.requests).toHaveLength(1);
      // The attempt is stored, so a restart waits as well.
      job.stop();
      const again = setup(ON);
      again.start().requested();
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      expect(again.requests).toEqual([]);
    });
  });
});

// The whole app: reads of bank data start the catch-up. Real clock, mocked fetch.
describe('app prices on read', () => {
  const READS = ['bank', 'bank/summary', 'bank/price-movers', 'potion-storage'];

  function setup(jobs: boolean) {
    const run = emptyRun();
    const db = run.database.db;
    // Three hours behind, so the job's own check (a day behind) does not fetch.
    const latest = latestSettledHour(Date.now());
    storeHours(db, latest - (PRICE_CATCHUP_MAX + 1) * HOUR, PRICE_CATCHUP_MAX - 1);
    const fetchedAt = db.select().from(priceHourFetches).all().at(-1)?.fetchedAt;
    const config = testConfig(ON);
    const requests: string[] = [];
    const fetchMock = ((url: string) => {
      requests.push(url);
      // Never answers: reads must not wait for it.
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const app = buildApp({
      db: run.database,
      config,
      jobs,
      externalClient: createExternalClient({ config, log, fetch: fetchMock }),
    });
    const read = (path: string) =>
      app.inject({ method: 'GET', url: `/api/v1/accounts/all/${path}` });
    return { app, requests, read, fetchedAt, latest };
  }

  it('answers every read at once with the stored prices, and starts one catch-up', async () => {
    const t = setup(true);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    expect(t.requests).toEqual([]);
    // History never asks for current prices.
    expect((await t.read('bank/history')).statusCode).toBe(200);
    expect(t.requests).toEqual([]);

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => t.read(READS[i % READS.length] ?? 'bank')),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json<{ prices: unknown }>().prices).toEqual({
        source: 'CURRENT',
        fetchedAt: t.fetchedAt,
      });
    }
    // The oldest missing hour, and nothing else while it waits.
    expect(t.requests).toEqual([`${URL_START}${String((t.latest - 2 * HOUR) / SECOND)}`]);
    await t.app.close();
  });

  it('does not fetch on reads without jobs', async () => {
    const t = setup(false);
    for (const path of READS) expect((await t.read(path)).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.requests).toEqual([]);
    await t.app.close();
  });
});
