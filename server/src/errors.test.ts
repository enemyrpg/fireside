import { errorResponseSchema, type ErrorResponse } from '@fireside/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app.js';
import { ApiError } from './errors.js';
import { testConfig, testDatabase } from './test-utils.js';

/** Parses the body as the shared error format and fails if it doesn't match. */
function errorBody(response: LightMyRequestResponse): ErrorResponse['error'] {
  expect(response.headers['content-type']).toMatch(/^application\/json/);
  return errorResponseSchema.parse(response.json()).error;
}

describe('error format', () => {
  const app = buildApp({ db: testDatabase(), config: testConfig() });

  beforeAll(async () => {
    // Test-only routes that fail in different ways.
    app.get('/test/crash', () => {
      throw new Error('database password is hunter2');
    });
    app.get('/test/async-crash', async () => {
      await Promise.resolve();
      throw new TypeError('secret internals');
    });
    app.get('/test/api-error', () => {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid API key');
    });
    app.get('/test/zod', (request) => {
      z.strictObject({ limit: z.coerce.number().int().max(100) }).parse(request.query);
      return { ok: true };
    });
    app.get(
      '/test/schema',
      { schema: { querystring: { type: 'object', properties: { n: { type: 'integer' } } } } },
      () => ({ ok: true }),
    );
    app.get('/test/library-error', () => {
      // Like http-errors or an HTTP client error: a status, and a message with internals.
      throw Object.assign(new Error('ENOENT /home/user/data/secret.db'), { statusCode: 404 });
    });
    app.post(
      '/test/slash-field',
      {
        schema: {
          body: {
            type: 'object',
            properties: { 'a/b': { type: 'integer' }, 'c~d': { type: 'integer' } },
          },
        },
      },
      () => ({ ok: true }),
    );
    app.post('/test/echo', (request) => request.body);
    await app.ready();
  });
  afterAll(() => app.close());

  it('returns NOT_FOUND for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/nope?key=abc' });
    expect(response.statusCode).toBe(404);
    const error = errorBody(response);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('GET /api/v1/nope');
    expect(error.message).not.toContain('key=abc');
    expect(error.details).toEqual([]);
  });

  it('returns NOT_FOUND for a known path with the wrong method', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/health' });
    expect(response.statusCode).toBe(404);
    expect(errorBody(response).code).toBe('NOT_FOUND');
  });

  it.each(['/test/crash', '/test/async-crash'])(
    'hides unexpected errors behind INTERNAL_ERROR (%s)',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(500);
      expect(errorBody(response)).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
      });
      expect(response.body).not.toMatch(/hunter2|secret internals|stack/);
    },
  );

  it('passes an ApiError through', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/api-error' });
    expect(response.statusCode).toBe(401);
    expect(errorBody(response)).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Invalid API key',
      details: [],
    });
  });

  it('turns a ZodError into VALIDATION_ERROR with details', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/zod?limit=500&extra=1' });
    expect(response.statusCode).toBe(400);
    const error = errorBody(response);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.map((detail) => detail.path)).toEqual(
      expect.arrayContaining(['limit', '']),
    );
  });

  it('turns Fastify schema validation into VALIDATION_ERROR with details', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/schema?n=abc' });
    expect(response.statusCode).toBe(400);
    const error = errorBody(response);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.map((detail) => detail.path)).toEqual(['querystring.n']);
  });

  it('decodes ~1 and ~0 in validation detail paths', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/slash-field',
      payload: { 'a/b': 'x', 'c~d': 'y' },
    });
    expect(response.statusCode).toBe(400);
    const paths = errorBody(response).details.map((detail) => detail.path);
    expect(paths).toContain('body.a/b');
    // Fastify stops at the first error unless allErrors is on; check the other one alone.
    const second = await app.inject({
      method: 'POST',
      url: '/test/slash-field',
      payload: { 'c~d': 'y' },
    });
    expect(errorBody(second).details.map((detail) => detail.path)).toEqual(['body.c~d']);
  });

  it('hides the message of 4xx errors that are not from Fastify', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/library-error' });
    expect(response.statusCode).toBe(404);
    expect(errorBody(response)).toEqual({ code: 'NOT_FOUND', message: 'Not found', details: [] });
    expect(response.body).not.toContain('secret.db');
  });

  it('keeps the message of Fastify errors', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(errorBody(response).message).toMatch(/JSON/);
  });

  it('returns BAD_REQUEST for invalid JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"events": [',
    });
    expect(response.statusCode).toBe(400);
    expect(errorBody(response).code).toBe('BAD_REQUEST');
  });

  it('returns BAD_REQUEST for an unsupported content type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'text/xml' },
      payload: '<events/>',
    });
    expect(response.statusCode).toBe(415);
    expect(errorBody(response).code).toBe('BAD_REQUEST');
  });

  it('returns PAYLOAD_TOO_LARGE for bodies over 1 MB', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(errorBody(response).code).toBe('PAYLOAD_TOO_LARGE');
  });
});
