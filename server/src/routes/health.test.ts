import { readFileSync } from 'node:fs';
import { CONTRACT_VERSION, healthResponseSchema } from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { testConfig, testDatabase } from '../test-utils.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('GET /api/v1/health', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildApp({ db: testDatabase(), config: testConfig() });
  });
  afterEach(() => app.close());

  it('reports status, versions and time zone without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    const body = healthResponseSchema.parse(response.json());
    expect(body).toEqual({
      status: 'ok',
      serverVersion: pkg.version,
      contractVersion: CONTRACT_VERSION,
      timeZone: testConfig().timeZone,
    });
  });
});
