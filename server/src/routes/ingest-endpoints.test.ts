import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRANDING,
  CONTRACT_VERSION,
  errorResponseSchema,
  ingestResponseSchema,
  ingestVerifyResponseSchema,
  MAX_INGEST_BYTES,
  MAX_INGEST_EVENTS,
} from '@fireside/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../app.js';
import {
  createApiKey,
  encodeBase62,
  hashApiKey,
  listApiKeys,
  ownKey,
  revokeApiKey,
} from '../auth/api-keys.js';
import { rawEventId } from '../ingest/validate.js';
import type { Database } from '../db/index.js';
import { apiKeys, events as eventsTable } from '../db/schema.js';
import { REPO_ROOT } from '../paths.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';
import { SERVER_VERSION } from '../version.js';
import { createUser, FIRST_USER_ID } from '../users/users.js';

// `expect.any` returns `any`; typed as unknown so the matchers can sit in object literals.
const ANY_STRING: unknown = expect.any(String);

const FIXTURES = join(REPO_ROOT, 'shared', 'fixtures');
const NOW = new Date('2026-11-09T12:00:00.000Z');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function fixtureFiles(dir: string): { file: string; data: unknown }[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file, data: readJson(join(dir, file)) }));
}

/** A UUIDv7 that differs by `n`. */
function id(n: number): string {
  return `01933c4e-8a2b-7c3d-9e4f-${n.toString(16).padStart(12, '0')}`;
}

const KC_EVENT = readJson(join(FIXTURES, 'events', 'valid', 'kc.json')) as Record<string, unknown>;

function kcEvent(n: number, killCount = 412): Record<string, unknown> {
  return {
    ...KC_EVENT,
    eventId: id(n),
    payload: { ...(KC_EVENT.payload as object), killCount },
  };
}

interface Harness {
  app: FastifyInstance;
  database: Database;
  key: string;
  keyId: number;
}

let open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.map((app) => app.close()));
  open = [];
});

function setup(
  options: Partial<Pick<BuildAppOptions, 'ingest'>> = {},
  prepare?: (database: Database) => void,
): Harness {
  const database = testDatabase();
  prepare?.(database);
  const { key, id: keyId } = createApiKey(database.db, TEST_OWNER, 'Gaming PC');
  const app = buildApp({
    db: database,
    config: testConfig(),
    ingest: { now: () => NOW, ...options.ingest },
  });
  open.push(app);
  return { app, database, key, keyId };
}

function post(h: Harness, body: unknown, extra: Partial<InjectOptions> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/ingest',
    headers: { authorization: `Bearer ${h.key}`, 'content-type': 'application/json' },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
    ...extra,
  });
}

function storedRows(h: Harness) {
  return h.database.db.select().from(eventsTable).all();
}

function errorCode(response: { json: () => unknown }) {
  return errorResponseSchema.parse(response.json()).error.code;
}

describe('GET /api/v1/ingest/verify', () => {
  it('returns the key name and versions', async () => {
    const h = setup();
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ingest/verify',
      headers: { authorization: `Bearer ${h.key}` },
    });
    expect(response.statusCode).toBe(200);
    expect(ingestVerifyResponseSchema.parse(response.json())).toEqual({
      ok: true,
      keyName: 'Gaming PC',
      serverVersion: SERVER_VERSION,
      contractVersion: CONTRACT_VERSION,
      serverTime: NOW.toISOString(),
    });
  });

  it('reads serverTime from the clock on each request', async () => {
    let now = new Date('2026-11-13T18:04:12.512Z');
    const h = setup({ ingest: { now: () => now } });
    const serverTime = async () => {
      const response = await h.app.inject({
        method: 'GET',
        url: '/api/v1/ingest/verify',
        headers: { authorization: `Bearer ${h.key}` },
      });
      return ingestVerifyResponseSchema.parse(response.json()).serverTime;
    };
    expect(await serverTime()).toBe('2026-11-13T18:04:12.512Z');
    now = new Date('2026-11-13T18:05:00.000Z');
    expect(await serverTime()).toBe('2026-11-13T18:05:00.000Z');
  });

  it('is 401 without a key and with a revoked key', async () => {
    const h = setup();
    const missing = await h.app.inject({ method: 'GET', url: '/api/v1/ingest/verify' });
    expect(missing.statusCode).toBe(401);

    revokeApiKey(h.database.db, h.keyId, { byUserId: FIRST_USER_ID });
    const revoked = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ingest/verify',
      headers: { authorization: `Bearer ${h.key}` },
    });
    expect(revoked.statusCode).toBe(401);
    expect(errorCode(revoked)).toBe('UNAUTHORIZED');
  });
});

describe('keys with an unknown prefix', () => {
  // Only the current prefix is accepted: a key with another prefix gets the
  // same 401 as any malformed key, even if its hash is stored.
  const FOREIGN_PREFIX = 'xyz_';

  function withForeignKey(): Harness {
    const key = `${FOREIGN_PREFIX}${encodeBase62(new Uint8Array(32).fill(42))}`;
    let keyId = 0;
    const h = setup({}, (database) => {
      keyId = database.db
        .insert(apiKeys)
        .values({
          ...TEST_OWNER,
          name: 'Foreign',
          keyHash: hashApiKey(key),
          prefix: key.slice(0, FOREIGN_PREFIX.length + 4),
          createdAt: '2026-11-01T18:00:00.000Z',
        })
        .returning({ id: apiKeys.id })
        .get().id;
    });
    return { ...h, key, keyId };
  }

  it('new keys use the current prefix', () => {
    const h = setup();
    expect(h.key.startsWith(BRANDING.apiKeyPrefix)).toBe(true);
  });

  it('rejects such a key on verify and ingest, stores nothing and records no use', async () => {
    const h = withForeignKey();
    const verify = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ingest/verify',
      headers: { authorization: `Bearer ${h.key}` },
    });
    expect(verify.statusCode).toBe(401);
    expect(errorCode(verify)).toBe('UNAUTHORIZED');

    const ingest = await post(h, { events: [kcEvent(1)] });
    expect(ingest.statusCode).toBe(401);
    expect(errorCode(ingest)).toBe('UNAUTHORIZED');
    expect(storedRows(h)).toHaveLength(0);

    const row = listApiKeys(h.database.db).find((key) => key.id === h.keyId);
    expect(row?.lastUsedAt).toBeNull();
  });
});

describe('POST /api/v1/ingest', () => {
  it('stores valid events unchanged', async () => {
    const h = setup();
    const event = kcEvent(1);
    const response = await post(h, { events: [event] });
    expect(response.statusCode).toBe(200);
    expect(ingestResponseSchema.parse(response.json())).toEqual({
      accepted: [id(1)],
      duplicates: [],
      rejected: [],
    });
    expect(storedRows(h)).toEqual([
      {
        eventId: id(1),
        userId: FIRST_USER_ID,
        type: 'kc',
        accountHash: event.accountHash,
        sessionId: event.sessionId,
        occurredAt: event.occurredAt,
        receivedAt: NOW.toISOString(),
        apiKeyId: h.keyId,
        schemaVersion: 1,
        payload: JSON.stringify(event.payload),
        processedAt: NOW.toISOString(),
        projectionError: null,
      },
    ]);
  });

  it('sorts a mixed batch into accepted, duplicates and rejected', async () => {
    const h = setup();
    await post(h, { events: [kcEvent(1)] });

    const response = await post(h, {
      events: [
        kcEvent(2), // new
        kcEvent(1), // stored before
        { ...kcEvent(3), type: 'nope' }, // invalid
        kcEvent(2, 999), // repeated in this batch
        { type: 'kc' }, // invalid, no eventId
        kcEvent(4), // new
      ],
    });
    expect(response.statusCode).toBe(200);
    const body = ingestResponseSchema.parse(response.json());
    expect(body.accepted).toEqual([id(2), id(4)]);
    expect(body.duplicates).toEqual([id(1), id(2)]);
    expect(body.rejected).toEqual([
      { index: 2, eventId: id(3), error: expect.stringContaining('type: ') as unknown },
      { index: 4, eventId: null, error: ANY_STRING },
    ]);

    // The repeat in the batch didn't overwrite the first occurrence.
    const rows = storedRows(h);
    expect(rows.map((row) => row.eventId).sort()).toEqual([id(1), id(2), id(4)]);
    const second = rows.find((row) => row.eventId === id(2));
    expect(JSON.parse(second?.payload ?? '{}')).toMatchObject({ killCount: 412 });
  });

  it('reports a resent batch as duplicates without overwriting', async () => {
    const h = setup();
    await post(h, { events: [kcEvent(1), kcEvent(2)] });
    const response = await post(h, { events: [kcEvent(1, 1), kcEvent(2, 2)] });
    expect(ingestResponseSchema.parse(response.json())).toEqual({
      accepted: [],
      duplicates: [id(1), id(2)],
      rejected: [],
    });
    for (const row of storedRows(h)) {
      expect(JSON.parse(row.payload)).toMatchObject({ killCount: 412 });
    }
  });

  it.each([
    ['as sent', { ...kcEvent(1), eventId: 'not-a-uuid' }, 'not-a-uuid'],
    ['null when empty', { ...kcEvent(1), eventId: '' }, null],
    ['null when not a string', { ...kcEvent(1), eventId: 7 }, null],
    ['null when the event is not an object', 'event', null],
  ])('reports the rejected eventId %s', async (_label, event, expected) => {
    const h = setup();
    const body = ingestResponseSchema.parse((await post(h, { events: [event] })).json());
    expect(body.rejected).toEqual([{ index: 0, eventId: expected, error: ANY_STRING }]);
  });

  it('rejects PLAYER loot with a name', async () => {
    const h = setup();
    const event = readJson(join(FIXTURES, 'events', 'invalid', 'loot-player-with-name.json'));
    const body = ingestResponseSchema.parse((await post(h, { events: [event] })).json());
    expect(body.accepted).toEqual([]);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]?.error).toContain('payload.source.name');
    expect(storedRows(h)).toEqual([]);
  });

  describe('400', () => {
    it.each([
      ['malformed JSON', '{"events": ['],
      ['an empty body', ''],
      ['a JSON array', '[]'],
      ['missing events', {}],
      ['events not an array', { events: {} }],
      ['no events', { events: [] }],
      ['too many events', { events: Array.from({ length: MAX_INGEST_EVENTS + 1 }, () => ({})) }],
      ['an extra key', { events: [kcEvent(1)], extra: true }],
    ])('for %s', async (_label, body) => {
      const h = setup();
      const response = await post(h, body);
      expect(response.statusCode).toBe(400);
      expect(['BAD_REQUEST', 'VALIDATION_ERROR']).toContain(errorCode(response));
      expect(storedRows(h)).toEqual([]);
    });

    it('lists envelope problems in details', async () => {
      const h = setup();
      const response = await post(h, { events: [] });
      const { error } = errorResponseSchema.parse(response.json());
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details.map((detail) => detail.path)).toEqual(['events']);
    });

    it(`accepts exactly ${String(MAX_INGEST_EVENTS)} events`, async () => {
      const h = setup();
      const events = Array.from({ length: MAX_INGEST_EVENTS }, (_, n) => kcEvent(n));
      const body = ingestResponseSchema.parse((await post(h, { events })).json());
      expect(body.accepted).toHaveLength(MAX_INGEST_EVENTS);
      expect(storedRows(h)).toHaveLength(MAX_INGEST_EVENTS);
    });
  });

  describe('401', () => {
    it('without a key', async () => {
      const h = setup();
      const response = await post(h, { events: [kcEvent(1)] }, { headers: {} });
      expect(response.statusCode).toBe(401);
      expect(storedRows(h)).toEqual([]);
    });

    it('with a revoked key', async () => {
      const h = setup();
      revokeApiKey(h.database.db, h.keyId, { byUserId: FIRST_USER_ID });
      const response = await post(h, { events: [kcEvent(1)] });
      expect(response.statusCode).toBe(401);
      expect(errorCode(response)).toBe('UNAUTHORIZED');
      expect(storedRows(h)).toEqual([]);
    });
  });

  describe('413', () => {
    /** A batch with one padded (invalid) event, exactly `bytes` long. */
    function bodyOfSize(bytes: number): string {
      const empty = JSON.stringify({ events: [{ pad: '' }] });
      return JSON.stringify({ events: [{ pad: 'x'.repeat(bytes - empty.length) }] });
    }

    it('over 1 MB', async () => {
      const h = setup();
      const response = await post(h, bodyOfSize(MAX_INGEST_BYTES + 1));
      expect(response.statusCode).toBe(413);
      expect(errorCode(response)).toBe('PAYLOAD_TOO_LARGE');
    });

    it('not at exactly 1 MB', async () => {
      const h = setup();
      const response = await post(h, bodyOfSize(MAX_INGEST_BYTES));
      expect(response.statusCode).toBe(200);
      expect(ingestResponseSchema.parse(response.json()).rejected).toHaveLength(1);
    });
  });

  describe('429', () => {
    it('limits each key separately', async () => {
      const h = setup({ ingest: { rateLimit: { max: 2, timeWindowMs: 60_000 } } });
      const other = createApiKey(h.database.db, TEST_OWNER, 'Laptop').key;

      for (let n = 0; n < 2; n++) {
        expect((await post(h, { events: [kcEvent(n)] })).statusCode).toBe(200);
      }
      const limited = await post(h, { events: [kcEvent(9)] });
      expect(limited.statusCode).toBe(429);
      expect(errorCode(limited)).toBe('RATE_LIMITED');
      expect(limited.headers['retry-after']).toBeDefined();
      expect(storedRows(h)).toHaveLength(2);

      // verify shares the limit.
      const verify = await h.app.inject({
        method: 'GET',
        url: '/api/v1/ingest/verify',
        headers: { authorization: `Bearer ${h.key}` },
      });
      expect(verify.statusCode).toBe(429);

      const otherKey = await post(
        h,
        { events: [kcEvent(9)] },
        {
          headers: { authorization: `Bearer ${other}`, 'content-type': 'application/json' },
        },
      );
      expect(otherKey.statusCode).toBe(200);
    });

    it('checks the key before the limit', async () => {
      const h = setup({ ingest: { rateLimit: { max: 0, timeWindowMs: 60_000 } } });
      const response = await post(h, { events: [kcEvent(1)] }, { headers: {} });
      expect(response.statusCode).toBe(401);
    });

    it('counts unknown paths against the same limit', async () => {
      const h = setup({ ingest: { rateLimit: { max: 2, timeWindowMs: 60_000 } } });
      const get = (url: string) =>
        h.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${h.key}` } });

      expect((await get('/api/v1/ingest/unknown')).statusCode).toBe(404);
      expect((await get('/api/v1/ingest/verify')).statusCode).toBe(200);
      const limited = await get('/api/v1/ingest/unknown');
      expect(limited.statusCode).toBe(429);
      expect(errorCode(limited)).toBe('RATE_LIMITED');
    });
  });

  describe('content type', () => {
    it.each(['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream'])(
      '%s is 400, not 415',
      async (contentType) => {
        const h = setup();
        const response = await post(
          h,
          { events: [kcEvent(1)] },
          {
            headers: { authorization: `Bearer ${h.key}`, 'content-type': contentType },
          },
        );
        expect(response.statusCode).toBe(400);
        expect(errorResponseSchema.parse(response.json()).error).toEqual({
          code: 'BAD_REQUEST',
          message: 'Content-Type must be application/json',
          details: [],
        });
        expect(storedRows(h)).toEqual([]);
      },
    );

    it('accepts JSON with a charset', async () => {
      const h = setup();
      const response = await post(
        h,
        { events: [kcEvent(1)] },
        {
          headers: {
            authorization: `Bearer ${h.key}`,
            'content-type': 'application/json; charset=utf-8',
          },
        },
      );
      expect(response.statusCode).toBe(200);
    });
  });

  describe('event ID case', () => {
    it('treats the same UUID in another case as a duplicate', async () => {
      const h = setup();
      const lower = kcEvent(0xabc);
      const upper = {
        ...kcEvent(0xabc),
        eventId: id(0xabc).toUpperCase(),
        sessionId: (lower.sessionId as string).toUpperCase(),
      };

      const first = ingestResponseSchema.parse((await post(h, { events: [upper] })).json());
      // Reported as sent, so the plugin can match it against its queue.
      expect(first.accepted).toEqual([id(0xabc).toUpperCase()]);

      const second = ingestResponseSchema.parse((await post(h, { events: [lower] })).json());
      expect(second).toEqual({ accepted: [], duplicates: [id(0xabc)], rejected: [] });

      const rows = storedRows(h);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventId).toBe(id(0xabc));
      expect(rows[0]?.sessionId).toBe(lower.sessionId);
    });

    it('catches mixed case within one batch', async () => {
      const h = setup();
      const body = ingestResponseSchema.parse(
        (
          await post(h, { events: [kcEvent(5), { ...kcEvent(5), eventId: id(5).toUpperCase() }] })
        ).json(),
      );
      expect(body.accepted).toEqual([id(5)]);
      expect(body.duplicates).toEqual([id(5).toUpperCase()]);
      expect(storedRows(h)).toHaveLength(1);
    });
  });

  it('stores nothing from a batch when one insert fails', async () => {
    const h = setup({}, ({ sqlite }) => {
      sqlite.exec(
        `CREATE TRIGGER fail_insert BEFORE INSERT ON events WHEN NEW.event_id = '${id(3)}' ` +
          "BEGIN SELECT RAISE(ABORT, 'test failure'); END",
      );
    });
    const response = await post(h, { events: [kcEvent(1), kcEvent(2), kcEvent(3)] });
    expect(response.statusCode).toBe(500);
    expect(errorCode(response)).toBe('INTERNAL_ERROR');
    expect(storedRows(h)).toEqual([]);
  });
});

describe('contract fixtures through POST /api/v1/ingest', () => {
  const eventsDir = join(FIXTURES, 'events');

  it.each(fixtureFiles(join(eventsDir, 'valid')))(
    'events/valid/$file is accepted',
    async ({ data }) => {
      const h = setup();
      const body = ingestResponseSchema.parse((await post(h, { events: [data] })).json());
      expect(body).toEqual({
        accepted: [(data as { eventId: string }).eventId],
        duplicates: [],
        rejected: [],
      });
      expect(storedRows(h)).toHaveLength(1);
    },
  );

  it.each([
    ...fixtureFiles(join(eventsDir, 'invalid')).map((f) => ({ ...f, file: `invalid/${f.file}` })),
    ...fixtureFiles(join(eventsDir, 'invalid-semantic')).map((f) => ({
      ...f,
      file: `invalid-semantic/${f.file}`,
    })),
  ])('events/$file is rejected', async ({ data }) => {
    const h = setup();
    const response = await post(h, { events: [data] });
    expect(response.statusCode).toBe(200);
    const body = ingestResponseSchema.parse(response.json());
    expect(body.accepted).toEqual([]);
    expect(body.duplicates).toEqual([]);
    expect(body.rejected).toEqual([{ index: 0, eventId: rawEventId(data), error: ANY_STRING }]);
    expect(storedRows(h)).toEqual([]);
  });

  const requestDir = join(FIXTURES, 'api', 'ingest-request');

  it.each(fixtureFiles(join(requestDir, 'valid')))(
    'api/ingest-request/valid/$file is processed',
    async ({ data }) => {
      const h = setup();
      const response = await post(h, data);
      expect(response.statusCode).toBe(200);
      const body = ingestResponseSchema.parse(response.json());
      const sent = (data as { events: unknown[] }).events.length;
      expect(body.accepted.length + body.duplicates.length + body.rejected.length).toBe(sent);
    },
  );

  it('api/ingest-request/valid/batch-with-invalid-event.json gives 1 accepted and 1 rejected', async () => {
    const h = setup();
    const data = readJson(join(requestDir, 'valid', 'batch-with-invalid-event.json'));
    const body = ingestResponseSchema.parse((await post(h, data)).json());
    expect(body.accepted).toHaveLength(1);
    expect(body.rejected).toEqual([{ index: 1, eventId: 'not-a-uuid', error: ANY_STRING }]);
  });

  it.each(fixtureFiles(join(requestDir, 'invalid')))(
    'api/ingest-request/invalid/$file is 400',
    async ({ data }) => {
      const h = setup();
      const response = await post(h, data);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_ERROR');
    },
  );
});

describe('POST /api/v1/ingest with two users', () => {
  /** A second user with its own key, posting to the same app. */
  function secondUser(h: Harness): Harness {
    const userId = createUser(h.database.db, 'friend');
    const { key, id: keyId } = createApiKey(h.database.db, ownKey(userId), 'Friend PC');
    return { ...h, key, keyId };
  }

  it('stores events as owned by the key’s user, with the same hash as another user’s', async () => {
    const h = setup();
    const friend = secondUser(h);
    await post(h, { events: [kcEvent(1)] });
    const response = await post(friend, {
      events: [{ ...kcEvent(2), sessionId: '01933c40-1111-7aaa-bbbb-ccccdddd0002' }],
    });
    expect(response.json()).toEqual({ accepted: [id(2)], duplicates: [], rejected: [] });
    expect(storedRows(h).map((row) => [row.eventId, row.userId, row.accountHash])).toEqual([
      [id(1), FIRST_USER_ID, KC_EVENT.accountHash],
      [id(2), FIRST_USER_ID + 1, KC_EVENT.accountHash],
    ]);
  });

  it('answers a foreign eventId as a duplicate and a foreign sessionId as a rejection, in index order', async () => {
    const h = setup();
    const friend = secondUser(h);
    await post(h, { events: [kcEvent(1)] });
    const before = storedRows(h);

    const response = await post(friend, {
      events: [
        // 0: another user's eventId (and session): a duplicate.
        { ...kcEvent(1), payload: { ...(KC_EVENT.payload as object), killCount: 1 } },
        // 1: invalid.
        { ...kcEvent(3), occurredAt: 'yesterday' },
        // 2: another user's session.
        kcEvent(4),
        // 3: fine.
        { ...kcEvent(5), sessionId: '01933c40-1111-7aaa-bbbb-ccccdddd0002' },
      ],
    });

    expect(response.statusCode).toBe(200);
    const body = ingestResponseSchema.parse(response.json());
    expect(body.accepted).toEqual([id(5)]);
    expect(body.duplicates).toEqual([id(1)]);
    expect(body.rejected.map((rejection) => [rejection.index, rejection.eventId])).toEqual([
      [1, id(3)],
      [2, id(4)],
    ]);
    expect(body.rejected[1]?.error).toBe('sessionId: not allowed');
    // User 1's event is exactly as it was.
    expect(storedRows(h).filter((row) => row.eventId === id(1))).toEqual(before);
  });
});
