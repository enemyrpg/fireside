import { createKeyResponseSchema, errorResponseSchema, keysResponseSchema } from '@fireside/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createApiKey, hashApiKey, listApiKeys, ownKey, revokeApiKey } from '../auth/api-keys.js';
import type { Database } from '../db/index.js';
import { apiKeys } from '../db/schema.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';
import { createUser, FIRST_USER_ID } from '../users/users.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const KEYS = '/api/v1/keys';

describe('/api/v1/keys', () => {
  let app: FastifyInstance;
  let database: Database;

  beforeEach(() => {
    database = testDatabase();
    app = buildApp({ db: database, config: testConfig(), dashboard: { now: () => NOW } });
  });
  afterEach(() => app.close());

  const create = (name: unknown, options: InjectOptions = {}) =>
    app.inject({ method: 'POST', url: KEYS, payload: { name }, ...options });
  const revoke = (id: number | string, options: InjectOptions = {}) =>
    app.inject({ method: 'DELETE', url: `${KEYS}/${String(id)}`, ...options });
  const verify = (key: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/ingest/verify',
      headers: { authorization: `Bearer ${key}` },
    });
  const hashes = () => database.db.select({ hash: apiKeys.keyHash }).from(apiKeys).all();

  describe('with another user’s keys (local mode acts as user 1)', () => {
    it('lists only the local user’s keys and can’t revoke another user’s', async () => {
      const friend = createUser(database.db, 'friend');
      const mine = createApiKey(database.db, TEST_OWNER, 'Mine', NOW);
      const theirs = createApiKey(database.db, ownKey(friend), 'Theirs', NOW);

      const listed = keysResponseSchema.parse(
        (await app.inject({ method: 'GET', url: KEYS })).json(),
      );
      expect(listed.keys.map((key) => key.id)).toEqual([mine.id]);

      const response = await revoke(theirs.id);
      expect(response.statusCode).toBe(404);
      expect((await verify(theirs.key)).statusCode).toBe(200);
    });

    it('creates keys for the local user', async () => {
      createUser(database.db, 'friend');
      const response = await create('New');
      const { apiKey } = createKeyResponseSchema.parse(response.json());
      expect(listApiKeys(database.db, FIRST_USER_ID).map((key) => key.id)).toEqual([apiKey.id]);
      expect(listApiKeys(database.db)[0]).toMatchObject({
        userId: FIRST_USER_ID,
        createdByUserId: FIRST_USER_ID,
      });
    });

    it('records the local user as the one who revoked', async () => {
      const { id } = createApiKey(database.db, TEST_OWNER, 'Mine', NOW);
      expect((await revoke(id)).statusCode).toBe(204);
      expect(listApiKeys(database.db)[0]?.revokedByUserId).toBe(FIRST_USER_ID);
    });
  });

  describe('GET', () => {
    it('lists every key with its metadata, oldest first', async () => {
      const earlier = new Date('2026-11-01T18:00:00.000Z');
      const a = createApiKey(database.db, TEST_OWNER, 'Gaming PC', earlier);
      const b = createApiKey(database.db, TEST_OWNER, 'Laptop', earlier);
      revokeApiKey(database.db, b.id, { byUserId: FIRST_USER_ID, now: NOW });

      const response = await app.inject({ method: 'GET', url: KEYS });
      expect(response.statusCode).toBe(200);
      expect(keysResponseSchema.parse(response.json())).toEqual({
        keys: [
          {
            id: a.id,
            name: 'Gaming PC',
            prefix: a.prefix,
            createdAt: earlier.toISOString(),
            lastUsedAt: null,
            revokedAt: null,
            revokedBy: null,
            createdByAdmin: false,
          },
          {
            id: b.id,
            name: 'Laptop',
            prefix: b.prefix,
            createdAt: earlier.toISOString(),
            lastUsedAt: null,
            revokedAt: NOW.toISOString(),
            revokedBy: 'owner',
            createdByAdmin: false,
          },
        ],
      });
    });

    it('shows when a key was last used', async () => {
      const { key, id } = createApiKey(database.db, TEST_OWNER, 'PC', NOW);
      expect((await verify(key)).statusCode).toBe(200);
      const body = keysResponseSchema.parse((await app.inject({ url: KEYS })).json());
      expect(body.keys.find((row) => row.id === id)?.lastUsedAt).not.toBeNull();
    });

    it('returns an empty list without keys', async () => {
      expect((await app.inject({ url: KEYS })).json()).toEqual({ keys: [] });
    });

    it('never contains a full key or a hash', async () => {
      const keys = [
        createApiKey(database.db, TEST_OWNER, 'A', NOW),
        createApiKey(database.db, TEST_OWNER, 'B', NOW),
      ];
      const text = (await app.inject({ url: KEYS })).body;
      for (const { key } of keys) {
        expect(text).not.toContain(key);
        expect(text).not.toContain(hashApiKey(key));
      }
      for (const { hash } of hashes()) expect(text).not.toContain(hash);
    });
  });

  describe('POST', () => {
    it('creates a key and shows the full key only in this response', async () => {
      const response = await create('  Gaming PC  ');
      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = createKeyResponseSchema.parse(response.json());
      expect(body.apiKey).toEqual({
        id: expect.any(Number) as number,
        name: 'Gaming PC',
        prefix: body.key.slice(0, body.apiKey.prefix.length),
        createdAt: NOW.toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        revokedBy: null,
        createdByAdmin: false,
      });
      // Stored as a hash only.
      expect(hashes()).toEqual([{ hash: hashApiKey(body.key) }]);
      expect(response.body).not.toContain(hashApiKey(body.key));

      const list = await app.inject({ url: KEYS });
      expect(list.body).not.toContain(body.key);
      expect(keysResponseSchema.parse(list.json()).keys).toEqual([body.apiKey]);
    });

    it('creates a key that works for ingest', async () => {
      const body = createKeyResponseSchema.parse((await create('PC')).json());
      expect((await verify(body.key)).statusCode).toBe(200);
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
      ['too long', 'x'.repeat(101)],
      ['a line break', 'PC\nfake row'],
      ['a control character', 'PC\u001b[31m'],
      ['a bidi mark', 'PC‮'],
    ])('rejects a name with %s, with details on body.name', async (_name, name) => {
      const response = await create(name);
      expect(response.statusCode).toBe(400);
      const { error } = errorResponseSchema.parse(response.json());
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details).toHaveLength(1);
      expect(error.details[0]?.path).toBe('body.name');
      expect(error.details[0]?.message).not.toBe('');
      expect(listApiKeys(database.db)).toEqual([]);
    });

    it('accepts 100 characters, counting an emoji as one', async () => {
      expect((await create('🙂'.repeat(100))).statusCode).toBe(201);
    });

    it.each([
      ['a missing name', {}],
      ['a number as name', { name: 5 }],
      ['an unknown field', { name: 'PC', prefix: 'x' }],
    ])('rejects %s', async (_name, payload) => {
      const response = await app.inject({ method: 'POST', url: KEYS, payload });
      expect(response.statusCode).toBe(400);
      const { error } = errorResponseSchema.parse(response.json());
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details[0]?.path).toMatch(/^body/);
      expect(listApiKeys(database.db)).toEqual([]);
    });

    it('rejects a request without a body', async () => {
      const response = await app.inject({ method: 'POST', url: KEYS });
      expect(response.statusCode).toBe(400);
      expect(listApiKeys(database.db)).toEqual([]);
    });

    it('only accepts JSON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: KEYS,
        headers: { 'content-type': 'text/plain' },
        payload: '{"name":"PC"}',
      });
      expect(response.statusCode).toBe(415);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('BAD_REQUEST');
      expect(listApiKeys(database.db)).toEqual([]);
    });

    it('gives 400 BAD_REQUEST for broken JSON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: KEYS,
        headers: { 'content-type': 'application/json' },
        payload: '{"name":',
      });
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('BAD_REQUEST');
      expect(listApiKeys(database.db)).toEqual([]);
    });

    it('gives VALIDATION_ERROR for an empty JSON body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: KEYS,
        headers: { 'content-type': 'application/json' },
      });
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses prototype poisoning in the body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: KEYS,
        headers: { 'content-type': 'application/json' },
        payload: '{"name":"PC","__proto__":{"x":1}}',
      });
      expect(response.statusCode).toBe(400);
      expect(listApiKeys(database.db)).toEqual([]);
    });
  });

  describe('DELETE', () => {
    async function createViaApi(name = 'PC') {
      return createKeyResponseSchema.parse((await create(name)).json());
    }

    it('revokes a key, keeps the row, and the key stops working for ingest', async () => {
      const { key, apiKey } = await createViaApi();
      expect((await verify(key)).statusCode).toBe(200);

      const response = await revoke(apiKey.id);
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');

      expect((await verify(key)).statusCode).toBe(401);
      expect(listApiKeys(database.db)).toEqual([
        expect.objectContaining({ id: apiKey.id, revokedAt: NOW.toISOString() }),
      ]);
    });

    it('is idempotent and keeps the first revocation time', async () => {
      const { id } = createApiKey(database.db, TEST_OWNER, 'PC', NOW);
      const first = new Date('2026-11-05T10:00:00.000Z');
      revokeApiKey(database.db, id, { byUserId: FIRST_USER_ID, now: first });

      expect((await revoke(id)).statusCode).toBe(204);
      expect(listApiKeys(database.db)[0]?.revokedAt).toBe(first.toISOString());
    });

    it('only revokes the given key', async () => {
      const a = await createViaApi('A');
      const b = await createViaApi('B');
      await revoke(a.apiKey.id);
      expect((await verify(b.key)).statusCode).toBe(200);
    });

    it('accepts a JSON content type without a body', async () => {
      const { id } = createApiKey(database.db, TEST_OWNER, 'PC', NOW);
      const response = await revoke(id, { headers: { 'content-type': 'application/json' } });
      expect(response.statusCode).toBe(204);
      expect(listApiKeys(database.db)[0]?.revokedAt).toBe(NOW.toISOString());
    });

    it('gives 404 for an unknown key', async () => {
      const response = await revoke(999);
      expect(response.statusCode).toBe(404);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    });

    it.each(['abc', '0', '01', '-1', '1.5'])('rejects id %j on params.id', async (id) => {
      const response = await revoke(id);
      expect(response.statusCode).toBe(400);
      const { error } = errorResponseSchema.parse(response.json());
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details[0]?.path).toBe('params.id');
    });
  });

  describe('local only', () => {
    async function expectForbidden(response: Promise<{ statusCode: number; json: () => unknown }>) {
      const result = await response;
      expect(result.statusCode).toBe(403);
      expect(errorResponseSchema.parse(result.json()).error.code).toBe('FORBIDDEN');
    }

    it.each(['https://evil.example', 'http://localhost:5555', 'null'])(
      'refuses POST and DELETE from Origin %s (CSRF)',
      async (origin) => {
        const { id, key } = createApiKey(database.db, TEST_OWNER, 'PC', NOW);
        const headers = { host: 'localhost:4000', origin };
        await expectForbidden(create('Evil', { headers }));
        await expectForbidden(revoke(id, { headers }));
        expect(listApiKeys(database.db)).toHaveLength(1);
        expect((await verify(key)).statusCode).toBe(200);
      },
    );

    it('accepts POST and DELETE with a matching Origin', async () => {
      const headers = { host: 'localhost:4000', origin: 'http://localhost:4000' };
      const response = await create('PC', { headers });
      expect(response.statusCode).toBe(201);
      const { apiKey } = createKeyResponseSchema.parse(response.json());
      expect((await revoke(apiKey.id, { headers })).statusCode).toBe(204);
    });

    it.each([
      ['a remote address', { remoteAddress: '192.168.1.20' }],
      ['a foreign Host', { headers: { host: 'evil.example' } }],
      ['a proxy header', { headers: { 'x-forwarded-for': '1.2.3.4' } }],
    ])('refuses requests with %s', async (_name, options: InjectOptions) => {
      await expectForbidden(app.inject({ url: KEYS, ...options }));
      await expectForbidden(create('PC', options));
      expect(listApiKeys(database.db)).toEqual([]);
    });
  });
});
