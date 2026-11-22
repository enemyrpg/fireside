import { BRANDING, errorResponseSchema } from '@fireside/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { apiKeys, users } from '../db/schema.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';
import {
  createApiKey,
  encodeBase62,
  generateApiKey,
  hashApiKey,
  LAST_USED_THROTTLE_MS,
  listApiKeys,
  revokeApiKey,
} from './api-keys.js';
import { addIngestAuth, INGEST_PREFIX, type IngestAuthOptions } from './ingest-auth.js';
import { IP_RULE } from './login-limiter.js';
import { FIRST_USER_ID } from '../users/users.js';

const start = new Date('2026-11-09T12:00:00.000Z');

describe('API key auth on ingest routes', () => {
  let database: Database;
  let app: FastifyInstance;
  let clock: Date;

  /** The real app plus a probe route inside an ingest scope and one outside it. */
  function build(options: IngestAuthOptions = {}) {
    app = buildApp({ db: database, config: testConfig() });
    void app.register(
      (scope, _options, done) => {
        addIngestAuth(scope, { now: () => clock, ...options });
        scope.get('/probe', (request) => ({ apiKey: request.apiKey ?? null }));
        done();
      },
      { prefix: INGEST_PREFIX },
    );
    app.get('/api/v1/elsewhere', (request) => ({ apiKey: request.apiKey ?? null }));
  }

  beforeEach(() => {
    database = testDatabase();
    clock = start;
    build();
  });
  afterEach(() => app.close());

  const probe = (authorization?: string) =>
    app.inject({
      method: 'GET',
      url: `${INGEST_PREFIX}/probe`,
      headers: authorization === undefined ? {} : { authorization },
    });

  async function expect401(authorization: string | undefined, message: string) {
    const response = await probe(authorization);
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toEqual({ code: 'UNAUTHORIZED', message, details: [] });
  }

  describe('limit per client IP for requests without a valid key', () => {
    const fromIp = (authorization: string | undefined, remoteAddress: string) =>
      app.inject({
        method: 'GET',
        url: `${INGEST_PREFIX}/probe`,
        remoteAddress,
        headers: authorization === undefined ? {} : { authorization },
      });

    it.each([
      ['no key', undefined],
      ['a malformed key', 'Bearer nope'],
      ['an unknown key', `Bearer ${generateApiKey().key}`],
    ])('gives 429 with Retry-After after the free failures (%s)', async (_label, authorization) => {
      for (let i = 0; i < IP_RULE.free; i += 1) {
        expect((await fromIp(authorization, '192.0.2.1')).statusCode).toBe(401);
      }
      const blocked = await fromIp(authorization, '192.0.2.1');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('2');
      expect(blocked.headers['www-authenticate']).toBeUndefined();
      expect(errorResponseSchema.parse(blocked.json()).error.code).toBe('RATE_LIMITED');
      // Another IP is not blocked.
      expect((await fromIp(authorization, '192.0.2.2')).statusCode).toBe(401);
    });

    it.each([
      ['a revoked key', 'revoked'],
      ['the key of a disabled user', 'disabled'],
    ])('counts %s, but always answers it with 401 so the plugin stops', async (_label, kind) => {
      const created = createApiKey(database.db, TEST_OWNER, 'Old PC', start);
      if (kind === 'revoked') {
        revokeApiKey(database.db, created.id, { byUserId: FIRST_USER_ID, now: start });
      } else {
        database.db.update(users).set({ disabledAt: start.toISOString() }).run();
      }
      for (let i = 0; i < IP_RULE.free + 5; i += 1) {
        const response = await fromIp(`Bearer ${created.key}`, '192.0.2.1');
        expect(response.statusCode).toBe(401);
        expect(response.headers['www-authenticate']).toBe('Bearer');
      }
      // It counted: other requests without a valid key from that IP are blocked.
      expect((await fromIp(undefined, '192.0.2.1')).statusCode).toBe(429);
      expect((await fromIp(`Bearer ${generateApiKey().key}`, '192.0.2.1')).statusCode).toBe(429);
    });

    it('answers a missing or malformed key from a blocked IP with 429 before any lookup', async () => {
      for (let i = 0; i < IP_RULE.free; i += 1) await fromIp(undefined, '192.0.2.1');
      for (const authorization of [undefined, 'Bearer nope', 'Basic abc']) {
        const response = await fromIp(authorization, '192.0.2.1');
        expect(response.statusCode).toBe(429);
        expect(response.headers['retry-after']).toBe('2');
      }
      // Blocked requests are not recorded, so the wait doesn't grow.
      clock = new Date(start.getTime() + 2000);
      expect((await fromIp('Bearer nope', '192.0.2.1')).statusCode).toBe(401);
    });

    it('never limits a valid key, even from a blocked IP', async () => {
      const created = createApiKey(database.db, TEST_OWNER, 'Gaming PC', start);
      for (let i = 0; i <= IP_RULE.free; i += 1) await fromIp(undefined, '192.0.2.1');
      expect((await fromIp(undefined, '192.0.2.1')).statusCode).toBe(429);
      for (let i = 0; i < 5; i += 1) {
        expect((await fromIp(`Bearer ${created.key}`, '192.0.2.1')).statusCode).toBe(200);
      }
    });

    it('lets a blocked IP try again after Retry-After', async () => {
      for (let i = 0; i <= IP_RULE.free; i += 1) await fromIp(undefined, '192.0.2.1');
      clock = new Date(start.getTime() + 2000);
      expect((await fromIp(undefined, '192.0.2.1')).statusCode).toBe(401);
    });
  });

  it('accepts a valid key and exposes its id and name', async () => {
    const created = createApiKey(database.db, TEST_OWNER, 'Gaming PC', start);
    const response = await probe(`Bearer ${created.key}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(response.json()).toEqual({
      apiKey: { id: created.id, name: 'Gaming PC', userId: FIRST_USER_ID },
    });
  });

  it('accepts any case of the scheme and extra spaces', async () => {
    const created = createApiKey(database.db, TEST_OWNER, 'PC', start);
    expect((await probe(`bearer   ${created.key}`)).statusCode).toBe(200);
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['other scheme', 'Basic dXNlcjpwYXNz'],
    ['scheme only', 'Bearer'],
    ['two tokens', 'Bearer a b'],
    ['malformed key', `Bearer ${BRANDING.apiKeyPrefix}short`],
  ])('rejects %s', async (_label, authorization) => {
    await expect401(authorization, 'Missing or malformed API key');
  });

  it('rejects an unknown key', async () => {
    createApiKey(database.db, TEST_OWNER, 'PC', start);
    await expect401(`Bearer ${generateApiKey().key}`, 'Invalid or revoked API key');
  });

  it('rejects a revoked key', async () => {
    const created = createApiKey(database.db, TEST_OWNER, 'PC', start);
    expect((await probe(`Bearer ${created.key}`)).statusCode).toBe(200);
    revokeApiKey(database.db, created.id, { byUserId: FIRST_USER_ID, now: start });
    await expect401(`Bearer ${created.key}`, 'Invalid or revoked API key');
  });

  it('accepts extra prefixes only when they are passed in', async () => {
    await app.close();
    database = testDatabase();
    build({ prefixes: ['new_', 'old_'] });

    const oldKey = `old_${encodeBase62(new Uint8Array(32).fill(7))}`;
    const { id } = database.db
      .insert(apiKeys)
      .values({
        ...TEST_OWNER,
        name: 'Old PC',
        keyHash: hashApiKey(oldKey),
        prefix: 'old_abcd',
        createdAt: start.toISOString(),
      })
      .returning({ id: apiKeys.id })
      .get();

    const response = await probe(`Bearer ${oldKey}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ apiKey: { id, name: 'Old PC', userId: FIRST_USER_ID } });
    await expect401(`Bearer zzz_${oldKey.slice(4)}`, 'Missing or malformed API key');
  });

  it('rejects a key with an unknown prefix like any malformed key, even when its hash is stored', async () => {
    const foreignKey = `xyz_${encodeBase62(new Uint8Array(32).fill(7))}`;
    database.db
      .insert(apiKeys)
      .values({
        ...TEST_OWNER,
        name: 'Foreign',
        keyHash: hashApiKey(foreignKey),
        prefix: 'xyz_abcd',
        createdAt: start.toISOString(),
      })
      .run();
    await expect401(`Bearer ${foreignKey}`, 'Missing or malformed API key');
  });

  it('updates last_used_at at most once per throttle window', async () => {
    const created = createApiKey(database.db, TEST_OWNER, 'PC', start);
    const lastUsed = () => listApiKeys(database.db)[0]?.lastUsedAt;
    expect(lastUsed()).toBeNull();

    await probe(`Bearer ${created.key}`);
    expect(lastUsed()).toBe(start.toISOString());

    clock = new Date(start.getTime() + LAST_USED_THROTTLE_MS / 2);
    await probe(`Bearer ${created.key}`);
    expect(lastUsed()).toBe(start.toISOString());

    clock = new Date(start.getTime() + LAST_USED_THROTTLE_MS + 1000);
    await probe(`Bearer ${created.key}`);
    expect(lastUsed()).toBe(clock.toISOString());
  });

  it('lets a valid key through when last_used_at cannot be written', async () => {
    const created = createApiKey(database.db, TEST_OWNER, 'PC', start);
    database.sqlite.exec(
      'CREATE TRIGGER fail_touch BEFORE UPDATE OF last_used_at ON api_keys ' +
        "BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
    );
    const response = await probe(`Bearer ${created.key}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      apiKey: { id: created.id, name: 'PC', userId: FIRST_USER_ID },
    });
    expect(listApiKeys(database.db)[0]?.lastUsedAt).toBeNull();
  });

  it('does not touch last_used_at for rejected keys', async () => {
    const created = createApiKey(database.db, TEST_OWNER, 'PC', start);
    revokeApiKey(database.db, created.id, { byUserId: FIRST_USER_ID, now: start });
    await probe(`Bearer ${created.key}`);
    expect(listApiKeys(database.db)[0]?.lastUsedAt).toBeNull();
  });

  it('gives a valid key no meaning outside the ingest scope', async () => {
    const created = createApiKey(database.db, TEST_OWNER, 'PC', start);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/elsewhere',
      headers: { authorization: `Bearer ${created.key}` },
    });
    expect(response.json()).toEqual({ apiKey: null });
    expect(listApiKeys(database.db)[0]?.lastUsedAt).toBeNull();
  });

  it('never logs the key', async () => {
    const lines: string[] = [];
    await app.close();
    database = testDatabase();
    app = buildApp({
      db: database,
      config: testConfig({ LOG_LEVEL: 'trace' }),
      logStream: { write: (line: string) => lines.push(line) } as unknown as NodeJS.WritableStream,
    });
    void app.register(
      (scope, _options, done) => {
        addIngestAuth(scope);
        scope.get('/probe', () => ({}));
        done();
      },
      { prefix: INGEST_PREFIX },
    );
    const created = createApiKey(database.db, TEST_OWNER, 'PC', start);
    revokeApiKey(database.db, created.id, { byUserId: FIRST_USER_ID, now: start });
    await probe(`Bearer ${created.key}`);
    await probe(`Bearer ${generateApiKey().key}`);

    const log = lines.join('');
    expect(log).toContain('API key rejected');
    expect(log).not.toContain(created.key);
    expect(log).not.toContain(created.key.slice(8));
  });
});

describe('addIngestAuth', () => {
  it.each(['', '/api/v1', '/api/v1/ingestion', '/api/v2/ingest', `${INGEST_PREFIX}/v2`])(
    'refuses to run under the prefix "%s"',
    async (prefix) => {
      const app = Fastify();
      void app.register(
        (scope, _options, done) => {
          try {
            addIngestAuth(scope);
            done();
          } catch (error) {
            done(error as Error);
          }
        },
        { prefix },
      );
      await expect(app.ready()).rejects.toThrow(/may only be added at \/api\/v1\/ingest,/);
    },
  );

  it('covers plugins nested inside the ingest scope', async () => {
    const database = testDatabase();
    const app = buildApp({ db: database, config: testConfig() });
    void app.register(
      (scope, _options, done) => {
        addIngestAuth(scope);
        void scope.register(
          (child, _childOptions, childDone) => {
            child.get('/probe', (request) => ({ apiKey: request.apiKey ?? null }));
            childDone();
          },
          { prefix: '/nested' },
        );
        done();
      },
      { prefix: INGEST_PREFIX },
    );
    const created = createApiKey(database.db, TEST_OWNER, 'PC', start);
    const url = `${INGEST_PREFIX}/nested/probe`;

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${created.key}` },
    });
    expect(response.json()).toEqual({
      apiKey: { id: created.id, name: 'PC', userId: FIRST_USER_ID },
    });
    await app.close();
  });
});
