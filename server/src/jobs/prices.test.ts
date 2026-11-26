import { externalSourcesResponseSchema } from '@fireside/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { itemPrices } from '../db/schema.js';
import { createExternalClient } from '../external/client.js';
import { externalSourcesStatus, recordAttempt, recordSuccess } from '../external/state.js';
import { MIN_PRICE_ITEMS, PRICES_INTERVAL_MS, storePrices } from '../prices/fetch.js';
import { PROJECTIONS } from '../projections/index.js';
import { emptyRun, eventFactory, ingestBatch, type TestRun } from '../projections/testing.js';
import { testConfig } from '../test-utils.js';
import { PRICES_HISTORY_INTERVAL_MS, startPricesJob, type PricesJob } from './prices.js';

// The job with the real client and a mocked fetch. No real network.

const ON = { PRICES_ENABLED: 'true', USER_AGENT_CONTACT: 'you@example.com' };
const START = '2026-11-16T12:00:00.000Z';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVALS = { WIKI_PRICES: PRICES_INTERVAL_MS, RUNEPROFILE: 6 * HOUR };

function body(): string {
  const data: Record<string, unknown> = {};
  for (let id = 1; id <= MIN_PRICE_ITEMS; id++) {
    data[String(id)] = { high: 10, highTime: 1_794_830_400, low: 8, lowTime: 1_794_830_400 };
  }
  return JSON.stringify({ data });
}

const ms = (iso: string) => Date.parse(iso);

describe('prices job', () => {
  let run: TestRun | undefined;
  const jobs: PricesJob[] = [];
  afterEach(() => {
    for (const job of jobs.splice(0)) job.stop();
    vi.useRealTimers();
    run?.database.close();
    run = undefined;
  });

  function setup(env: Record<string, string> = ON) {
    // A second setup in one test is a restart: the clock goes on.
    if (!vi.isFakeTimers()) vi.useFakeTimers({ now: new Date(START) });
    run ??= emptyRun();
    const testRun = run;
    const db = testRun.database.db;
    const config = testConfig(env);
    const requests: string[] = [];
    const warnings: string[] = [];
    let status = 200;
    /** While set, responses wait until `release()` is called. */
    let held: (() => void)[] | undefined;
    const fetchMock = ((url: string) => {
      requests.push(`${new Date().toISOString()} ${url}`);
      const respond = () => new Response(status === 200 ? body() : '', { status });
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
    const start = () => {
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
      start,
      setStatus: (next: number) => (status = next),
      hold: () => (held = []),
      release: () => {
        const waiting = held ?? [];
        held = undefined;
        for (const resolve of waiting) resolve();
      },
      /** As if prices had last been tried (and fetched) at `at`. */
      triedAt: (at: string) => {
        recordAttempt(db, 'WIKI_PRICES', new Date(at));
        recordSuccess(db, 'WIKI_PRICES', new Date(at));
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
      count: () => db.select().from(itemPrices).all().length,
    };
  }

  /** The time of each request, as epoch milliseconds. */
  const times = (requests: readonly string[]) =>
    requests.map((line) => ms(line.slice(0, line.indexOf(' '))));

  it('fetches at start when prices were never fetched', async () => {
    const t = setup();
    const job = t.start();
    await job.idle();
    expect(t.requests).toEqual([`${START} https://prices.runescape.wiki/api/v2/osrs/latest`]);
    expect(t.count()).toBe(MIN_PRICE_ITEMS);
    expect(t.status()).toMatchObject({
      enabled: true,
      active: true,
      lastFetchAt: START,
      nextFetchAt: '2026-11-16T13:00:00.000Z',
      lastError: null,
    });
  });

  it('does not fetch while nobody reads bank data and no session is open, except for history', async () => {
    const t = setup();
    t.triedAt(START);
    const job = t.start();
    await vi.advanceTimersByTimeAsync(PRICES_HISTORY_INTERVAL_MS - MINUTE);
    expect(t.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await job.idle();
    expect(times(t.requests)).toEqual([ms(START) + PRICES_HISTORY_INTERVAL_MS]);
  });

  // Runs every one-minute tick of many days: slow on a busy machine.
  it('makes about 6 calls a day when idle', async () => {
    const t = setup();
    t.triedAt(START);
    t.start();
    await vi.advanceTimersByTimeAsync(10 * DAY);
    // 24 h ÷ 3 h 55 min ≈ 6.13 a day.
    expect(t.requests).toHaveLength(Math.floor((10 * DAY) / PRICES_HISTORY_INTERVAL_MS));
    expect(t.requests).toHaveLength(61);
  }, 60_000);

  // Runs every one-minute tick of many days: slow on a busy machine.
  it('never leaves 4 hours between fetches over 40 idle days', async () => {
    const t = setup();
    t.start();
    await vi.advanceTimersByTimeAsync(40 * DAY);
    const at = times(t.requests);
    expect(at.length).toBeGreaterThan(240);
    // From the start to the first fetch, between fetches, and from the last one to the end.
    const edges = [ms(START), ...at, ms(START) + 40 * DAY];
    const gaps = edges.slice(1).map((time, i) => time - (edges[i] ?? time));
    expect(Math.max(...gaps)).toBeLessThan(4 * HOUR);
  }, 60_000);

  it('starts one fetch for a read of stale prices, and does not wait for it', async () => {
    const t = setup();
    t.triedAt('2026-11-16T10:30:00.000Z');
    const job = t.start();
    expect(t.requests).toEqual([]);
    t.hold();
    job.requested();
    expect(t.requests).toEqual([]); // The request goes out on the next turn…
    await vi.advanceTimersByTimeAsync(0);
    expect(t.requests).toHaveLength(1); // …while `requested` returned at once.
    expect(t.status()).toMatchObject({ lastFetchAt: '2026-11-16T10:30:00.000Z' });
    t.release();
    await job.idle();
    expect(t.status()).toMatchObject({ lastFetchAt: START, lastError: null });
    expect(t.count()).toBe(MIN_PRICE_ITEMS);
  });

  it('starts one fetch for many reads at once, and none while it runs', async () => {
    const t = setup();
    t.triedAt('2026-11-16T09:00:00.000Z');
    const job = t.start();
    t.hold();
    for (let i = 0; i < 50; i++) job.requested();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    for (let i = 0; i < 50; i++) job.requested();
    expect(t.requests).toHaveLength(1);
    t.release();
    await job.idle();
    for (let i = 0; i < 50; i++) job.requested();
    await job.idle();
    expect(t.requests).toHaveLength(1);
  });

  it('starts no second fetch while one is still running, however long it takes', async () => {
    const t = setup();
    // A client whose call never ends (the real one gives up after its timeouts).
    let calls = 0;
    const job = startPricesJob({
      db: t.db,
      config: testConfig(ON),
      client: {
        getJson: () => {
          calls++;
          return new Promise(() => undefined);
        },
        getText: () => Promise.reject(new Error('not used')),
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    jobs.push(job);
    expect(calls).toBe(1);
    t.openSession();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(PRICES_HISTORY_INTERVAL_MS);
      job.requested();
    }
    expect(calls).toBe(1);
  });

  it('fetches at most once an hour on reads', async () => {
    const t = setup();
    t.triedAt(START);
    const job = t.start();
    await vi.advanceTimersByTimeAsync(PRICES_INTERVAL_MS - MINUTE);
    job.requested();
    await job.idle();
    expect(t.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    job.requested();
    await job.idle();
    expect(times(t.requests)).toEqual([ms(START) + PRICES_INTERVAL_MS]);
    // Reads every minute for three hours: one fetch an hour.
    for (let i = 0; i < 180; i++) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      job.requested();
    }
    await job.idle();
    expect(t.requests).toHaveLength(4);
  });

  it('fetches once an hour while a session is open, then only for history', async () => {
    const t = setup();
    t.triedAt(START);
    t.openSession();
    const job = t.start();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    await job.idle();
    expect(times(t.requests)).toEqual([1, 2, 3].map((h) => ms(START) + h * HOUR));
    t.endSession();
    await vi.advanceTimersByTimeAsync(PRICES_HISTORY_INTERVAL_MS - MINUTE);
    expect(t.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await job.idle();
    expect(t.requests).toHaveLength(4);
  });

  it('stores a failed fetch as lastError, keeps the old prices and retries no sooner than an hour', async () => {
    const t = setup();
    const job = t.start();
    await job.idle();
    t.setStatus(404);
    await vi.advanceTimersByTimeAsync(PRICES_INTERVAL_MS);
    job.requested();
    await job.idle();
    expect(t.requests).toHaveLength(2);
    expect(t.count()).toBe(MIN_PRICE_ITEMS);
    expect(t.status()).toMatchObject({
      lastFetchAt: START,
      nextFetchAt: '2026-11-16T14:00:00.000Z',
      lastError: { at: '2026-11-16T13:00:00.000Z', message: 'HTTP 404' },
    });
    for (let i = 0; i < 59; i++) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      job.requested();
    }
    expect(t.requests).toHaveLength(2);

    t.setStatus(200);
    await vi.advanceTimersByTimeAsync(MINUTE);
    job.requested();
    await job.idle();
    expect(t.requests).toHaveLength(3);
    expect(t.status()).toMatchObject({ lastFetchAt: '2026-11-16T14:00:00.000Z', lastError: null });
  });

  it('retries a failed history fetch after an hour on an idle server, then waits for history again', async () => {
    const t = setup();
    t.triedAt(START);
    const job = t.start();
    // 404: not retried by the client, so one attempt is one request.
    t.setStatus(404);
    await vi.advanceTimersByTimeAsync(PRICES_HISTORY_INTERVAL_MS);
    await job.idle();
    const attempts = t.requests.length;
    expect(attempts).toBe(1);
    expect(t.status()).toMatchObject({ lastError: { message: 'HTTP 404' } });

    t.setStatus(200);
    await vi.advanceTimersByTimeAsync(PRICES_INTERVAL_MS - 2 * MINUTE);
    expect(t.requests).toHaveLength(attempts);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await job.idle();
    expect(t.requests).toHaveLength(attempts + 1);
    expect(t.status()).toMatchObject({ lastError: null });

    // Back to the history interval once a fetch succeeded.
    await vi.advanceTimersByTimeAsync(PRICES_HISTORY_INTERVAL_MS - 2 * MINUTE);
    expect(t.requests).toHaveLength(attempts + 1);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await job.idle();
    expect(t.requests).toHaveLength(attempts + 2);
  });

  it('does not fetch again after a restart within the hour', async () => {
    const t = setup();
    const first = t.start();
    await first.idle();
    first.stop();

    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    const second = setup();
    const job = second.start();
    job.requested();
    await vi.advanceTimersByTimeAsync(39 * MINUTE);
    job.requested();
    expect(second.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    job.requested();
    await job.idle();
    expect(second.requests).toHaveLength(1);
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
      await vi.advanceTimersByTimeAsync(PRICES_HISTORY_INTERVAL_MS);
    }
    expect(t.requests).toEqual([]);
    expect(t.warnings).toHaveLength(warnings);
    expect(t.status()).toMatchObject({ active: false, lastFetchAt: null, nextFetchAt: null });
  });

  it('stops', async () => {
    const t = setup();
    const job = t.start();
    await job.idle();
    job.stop();
    t.openSession();
    job.requested();
    await vi.advanceTimersByTimeAsync(3 * PRICES_HISTORY_INTERVAL_MS);
    job.requested();
    expect(t.requests).toHaveLength(1);
  });
});

// The whole app: reads of bank data start the fetch. Real clock, mocked fetch.
describe('app prices on read', () => {
  const STORED_AT = '2026-11-01T12:00:00.000Z';
  const READS = ['bank', 'bank/summary', 'bank/price-movers', 'potion-storage'];

  function setup(jobs: boolean) {
    const run = emptyRun();
    const db = run.database.db;
    storePrices(
      db,
      [{ itemId: 4151, high: 110, highTime: STORED_AT, low: 90, lowTime: STORED_AT }],
      new Date(STORED_AT),
    );
    // Tried less than four hours ago, so the job itself does not fetch at start.
    const recent = new Date(Date.now() - 2 * HOUR);
    recordAttempt(db, 'WIKI_PRICES', recent);
    recordSuccess(db, 'WIKI_PRICES', new Date(STORED_AT));
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
    const tried = (at: Date) => {
      recordAttempt(db, 'WIKI_PRICES', at);
    };
    return { app, requests, read, tried };
  }

  it('answers every read at once with the stored prices, and starts one fetch', async () => {
    const t = setup(true);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    expect(t.requests).toEqual([]);
    // History never asks for current prices.
    t.tried(new Date(Date.now() - 2 * HOUR));
    expect((await t.read('bank/history')).statusCode).toBe(200);
    expect(t.requests).toEqual([]);

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => t.read(READS[i % READS.length] ?? 'bank')),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json<{ prices: unknown }>().prices).toEqual({
        source: 'CURRENT',
        fetchedAt: STORED_AT,
      });
    }
    expect(t.requests).toEqual(['https://prices.runescape.wiki/api/v2/osrs/latest']);
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
