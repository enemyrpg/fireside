import { errorResponseSchema } from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createApiKey } from '../auth/api-keys.js';
import type { Database } from '../db/index.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';

describe('/api/v1/ingest scope', () => {
  let database: Database;
  let app: FastifyInstance;
  beforeEach(() => {
    database = testDatabase();
    app = buildApp({ db: database, config: testConfig() });
  });
  afterEach(() => app.close());

  it.each([
    ['GET', '/api/v1/ingest'],
    ['POST', '/api/v1/ingest'],
    ['GET', '/api/v1/ingest/unknown'],
    ['GET', '/api/v1/ingest/unknown?x=1'],
  ] as const)('%s %s without a key is 401, not 404', async (method, url) => {
    const response = await app.inject({ method, url });
    expect(response.statusCode).toBe(401);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('unknown paths are 404 with a valid key', async () => {
    const { key } = createApiKey(database.db, TEST_OWNER, 'PC');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ingest/unknown?secret=1',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error).toEqual({
      code: 'NOT_FOUND',
      message: 'Route GET /api/v1/ingest/unknown not found',
      details: [],
    });
  });

  it('unknown paths outside the scope are still a plain 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/ingestion' });
    expect(response.statusCode).toBe(404);
  });
});
