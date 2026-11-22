import { MAX_INGEST_BYTES, MAX_INGEST_EVENTS, type Event } from '@fireside/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createApiKey } from '../auth/api-keys.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';
import { generateSeed, type SeedData } from './generator/generate.js';
import {
  parseRetryAfter,
  planRequests,
  SeedSendError,
  sendRequests,
  type IngestReply,
  type SeedRequest,
  type Transport,
} from './runner.js';

let cached: SeedData | undefined;
function seed(): SeedData {
  cached ??= generateSeed({
    seed: 3,
    accounts: 3,
    months: 1,
    until: new Date('2026-11-03T20:00:00.000Z'),
    timeZone: 'Europe/Oslo',
  });
  return cached;
}

function requestOf(events: Event[]): SeedRequest {
  const at = new Date('2026-11-01T00:00:00.000Z');
  return { firstSendAt: at, sendAt: at, events };
}

/** Accepts every event. */
const acceptAll = (events: readonly Event[]): IngestReply => ({
  status: 200,
  body: { accepted: events.map((e) => e.eventId), duplicates: [], rejected: [] },
});

/** A transport that plays `replies` in order, then accepts everything. */
function scripted(replies: (IngestReply | Error)[]): Transport & { calls: number } {
  const transport = Object.assign(
    (events: readonly Event[]) => {
      transport.calls += 1;
      const next = replies.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? acceptAll(events));
    },
    { calls: 0 },
  );
  return transport;
}

describe('planRequests', () => {
  it('keeps every event, in delivery order, within the batch limits', () => {
    const { deliveries } = seed();
    const requests = planRequests(deliveries);
    expect(requests.flatMap((r) => r.events)).toEqual(deliveries.flatMap((d) => d.events));
    for (const request of requests) {
      expect(request.events.length).toBeLessThanOrEqual(MAX_INGEST_EVENTS);
      expect(Buffer.byteLength(JSON.stringify({ events: request.events }))).toBeLessThanOrEqual(
        MAX_INGEST_BYTES,
      );
      expect(request.firstSendAt.getTime()).toBeLessThanOrEqual(request.sendAt.getTime());
    }
    // Merging keeps the request count far below the delivery count.
    expect(requests.length).toBeLessThan(deliveries.length / 50);
  });

  it('sends the offline backlog on its own', () => {
    const { deliveries } = seed();
    const backlog = new Set(deliveries.filter((d) => !d.live).flatMap((d) => d.events));
    expect(backlog.size).toBeGreaterThan(0);
    for (const request of planRequests(deliveries)) {
      const late = request.events.filter((e) => backlog.has(e));
      expect(late.length === 0 || late.length === request.events.length).toBe(true);
    }
  });

  it('splits by event count and by size', () => {
    const { deliveries } = seed();
    const total = deliveries.reduce((sum, d) => sum + d.events.length, 0);
    for (const request of planRequests(deliveries, { maxEvents: 7, maxBytes: MAX_INGEST_BYTES })) {
      expect(request.events.length).toBeLessThanOrEqual(7);
    }
    const small = planRequests(deliveries, { maxEvents: 500, maxBytes: 20_000 });
    expect(small.flatMap((r) => r.events)).toHaveLength(total);
    for (const request of small) {
      expect(Buffer.byteLength(JSON.stringify({ events: request.events }))).toBeLessThanOrEqual(
        20_000,
      );
    }
  });

  it('refuses an event that can never fit', () => {
    expect(() => planRequests(seed().deliveries, { maxEvents: 500, maxBytes: 100 })).toThrow(
      SeedSendError,
    );
  });
});

describe('sendRequests', () => {
  const events = () => seed().events.slice(0, 3);
  const noSleep = { sleeps: [] as number[] };
  const sleep = (ms: number) => {
    noSleep.sleeps.push(ms);
    return Promise.resolve();
  };
  afterEach(() => {
    noSleep.sleeps = [];
  });

  it('retries 429 after Retry-After and counts the retry', async () => {
    const transport = scripted([{ status: 429, body: {}, retryAfterSeconds: 7 }]);
    const result = await sendRequests([requestOf(events())], { transport, sleep });
    expect(transport.calls).toBe(2);
    expect(noSleep.sleeps).toContain(7000);
    expect(result).toMatchObject({ requests: 1, retries: 1, accepted: 3, rejected: [] });
  });

  it('retries server and network errors with backoff, then gives up', async () => {
    const transport = scripted([{ status: 503, body: {} }, new Error('ECONNRESET')]);
    const result = await sendRequests([requestOf(events())], { transport, sleep });
    expect(result.retries).toBe(2);
    expect(noSleep.sleeps).toEqual([500, 1000]);

    const failing = scripted(Array.from({ length: 3 }, () => ({ status: 500, body: {} })));
    await expect(
      sendRequests([requestOf(events())], { transport: failing, sleep, maxAttempts: 3 }),
    ).rejects.toThrow(/after 3 attempts: server error \(500\)/);
  });

  it('stops at once on other errors', async () => {
    const transport = scripted([
      {
        status: 401,
        body: {
          error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked API key', details: [] },
        },
      },
    ]);
    await expect(sendRequests([requestOf(events())], { transport, sleep })).rejects.toThrow(
      'Ingest failed with 401: Invalid or revoked API key',
    );
    expect(transport.calls).toBe(1);
  });

  it('stops if the first batch is already on the server', async () => {
    const batch = events();
    const transport = scripted([
      {
        status: 200,
        body: { accepted: [], duplicates: batch.map((e) => e.eventId), rejected: [] },
      },
    ]);
    await expect(sendRequests([requestOf(batch)], { transport, sleep })).rejects.toThrow(
      /already has 3 of the first 3 events/,
    );
  });

  it('collects rejected events with their type', async () => {
    const batch = events();
    const transport = scripted([
      {
        status: 200,
        body: {
          accepted: batch.slice(1).map((e) => e.eventId),
          duplicates: [],
          rejected: [{ index: 0, eventId: batch[0]?.eventId ?? null, error: 'payload: bad' }],
        },
      },
    ]);
    const result = await sendRequests([requestOf(batch)], { transport, sleep });
    expect(result.rejected).toEqual([
      { eventId: batch[0]?.eventId, type: batch[0]?.type, error: 'payload: bad' },
    ]);
  });

  it('paces requests and calls the hooks in order', async () => {
    const calls: string[] = [];
    const requests = [requestOf(events()), requestOf(events().slice(0, 1))];
    await sendRequests(requests, {
      transport: (batch) => {
        calls.push(`send ${String(batch.length)}`);
        return Promise.resolve(acceptAll(batch));
      },
      beforeRequest: (request) => calls.push(`before ${String(request.events.length)}`),
      onProgress: (sent, total) => calls.push(`progress ${String(sent)}/${String(total)}`),
      minIntervalMs: 60_000,
      sleep,
    });
    expect(calls).toEqual([
      'before 3',
      'send 3',
      'progress 3/4',
      'before 1',
      'send 1',
      'progress 4/4',
    ]);
    expect(noSleep.sleeps).toHaveLength(1);
    expect(noSleep.sleeps[0]).toBeGreaterThan(59_000);
  });

  it('gets through the real ingest rate limit by honoring Retry-After', async () => {
    const database = testDatabase();
    const { key } = createApiKey(database.db, TEST_OWNER, 'seed');
    const app = buildApp({
      config: testConfig(),
      db: database,
      ingest: { rateLimit: { max: 2, timeWindowMs: 1000 } },
    });
    try {
      const transport: Transport = async (batch) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/ingest',
          headers: { authorization: `Bearer ${key}` },
          payload: { events: batch },
        });
        const retryAfterSeconds = parseRetryAfter(response.headers['retry-after']);
        return {
          status: response.statusCode,
          body: response.json(),
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        };
      };
      const batches = [0, 1, 2, 3].map((i) => requestOf(seed().events.slice(i * 5, i * 5 + 5)));
      const result = await sendRequests(batches, { transport });
      expect(result).toMatchObject({ requests: 4, accepted: 20, duplicates: 0, rejected: [] });
      expect(result.retries).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and ignores anything else', () => {
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter(['3', '4'])).toBe(3);
    expect(parseRetryAfter(5)).toBe(5);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
  });
});
