import { externalSourcesResponseSchema } from '@fireside/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/index.js';
import { itemPrices } from '../db/schema.js';
import { createExternalClient } from '../external/client.js';
import { externalSourcesStatus } from '../external/state.js';
import { MIN_PRICE_ITEMS, PRICES_INTERVAL_MS } from '../prices/fetch.js';
import { testConfig, testDatabase } from '../test-utils.js';
import { PRICES_CHECK_INTERVAL_MS, startPricesJob, type PricesJob } from './prices.js';

// The job with the real client and a mocked fetch. No real network.

const ON = { PRICES_ENABLED: 'true', USER_AGENT_CONTACT: 'you@example.com' };
const START = '2026-11-16T12:00:00.000Z';
const INTERVALS = { WIKI_PRICES: PRICES_INTERVAL_MS, RUNEPROFILE: 6 * 60 * 60 * 1000 };

function body(): string {
  const data: Record<string, unknown> = {};
  for (let id = 1; id <= MIN_PRICE_ITEMS; id++) {
    data[String(id)] = { high: 10, highTime: 1_794_830_400, low: 8, lowTime: 1_794_830_400 };
  }
  return JSON.stringify({ data });
}

describe('prices job', () => {
  let database: Database | undefined;
  const jobs: PricesJob[] = [];
  afterEach(() => {
    for (const job of jobs.splice(0)) job.stop();
    vi.useRealTimers();
    database?.close();
    database = undefined;
  });

  function setup(env: Record<string, string> = ON) {
    // A second setup in one test is a restart: the clock goes on.
    if (!vi.isFakeTimers()) vi.useFakeTimers({ now: new Date(START) });
    database ??= testDatabase();
    const db = database.db;
    const config = testConfig(env);
    const requests: string[] = [];
    const warnings: string[] = [];
    let status = 200;
    const fetchMock = ((url: string) => {
      requests.push(`${new Date().toISOString()} ${url}`);
      return Promise.resolve(new Response(status === 200 ? body() : '', { status }));
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
    return {
      db,
      requests,
      warnings,
      start,
      setStatus: (next: number) => (status = next),
      status: () =>
        externalSourcesResponseSchema.parse(externalSourcesStatus(db, config, INTERVALS))
          .sources[0],
      count: () => db.select().from(itemPrices).all().length,
    };
  }

  it('fetches at start, then once an hour', async () => {
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

    await vi.advanceTimersByTimeAsync(PRICES_INTERVAL_MS - PRICES_CHECK_INTERVAL_MS);
    expect(t.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PRICES_CHECK_INTERVAL_MS);
    await job.idle();
    expect(t.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3 * PRICES_INTERVAL_MS);
    expect(t.requests).toHaveLength(5);
  });

  it('does not fetch again after a restart within the hour', async () => {
    const t = setup();
    const first = t.start();
    await first.idle();
    first.stop();

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const second = setup();
    const job = second.start();
    await job.idle();
    await vi.advanceTimersByTimeAsync(39 * 60_000);
    expect(second.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await job.idle();
    expect(second.requests).toHaveLength(1);
  });

  it('waits a full hour after a failed fetch too, and keeps the old prices', async () => {
    const t = setup();
    const job = t.start();
    await job.idle();
    t.setStatus(404);
    await vi.advanceTimersByTimeAsync(PRICES_INTERVAL_MS);
    await job.idle();
    expect(t.requests).toHaveLength(2);
    expect(t.count()).toBe(MIN_PRICE_ITEMS);
    expect(t.status()).toMatchObject({
      lastFetchAt: START,
      nextFetchAt: '2026-11-16T14:00:00.000Z',
      lastError: { at: '2026-11-16T13:00:00.000Z', message: 'HTTP 404' },
    });
    await vi.advanceTimersByTimeAsync(PRICES_INTERVAL_MS - PRICES_CHECK_INTERVAL_MS);
    expect(t.requests).toHaveLength(2);

    t.setStatus(200);
    await vi.advanceTimersByTimeAsync(PRICES_CHECK_INTERVAL_MS);
    await job.idle();
    expect(t.requests).toHaveLength(3);
    expect(t.status()).toMatchObject({ lastFetchAt: '2026-11-16T14:00:00.000Z', lastError: null });
  });

  it.each([
    ['nothing is set', {}, 0],
    ['PRICES_ENABLED is off', { PRICES_ENABLED: 'false', USER_AGENT_CONTACT: 'a@b.example' }, 0],
    ['USER_AGENT_CONTACT is missing', { PRICES_ENABLED: 'true' }, 1],
  ])('never fetches when %s', async (_name, env, warnings) => {
    const t = setup(env);
    t.start();
    await vi.advanceTimersByTimeAsync(3 * PRICES_INTERVAL_MS);
    expect(t.requests).toEqual([]);
    expect(t.warnings).toHaveLength(warnings);
    expect(t.status()).toMatchObject({ active: false, lastFetchAt: null, nextFetchAt: null });
  });

  it('stops', async () => {
    const t = setup();
    const job = t.start();
    await job.idle();
    job.stop();
    await vi.advanceTimersByTimeAsync(3 * PRICES_INTERVAL_MS);
    expect(t.requests).toHaveLength(1);
  });
});
