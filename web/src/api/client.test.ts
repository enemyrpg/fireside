import { ERROR_CODES } from '@fireside/shared';
import { describe, expect, it, vi } from 'vitest';
import invalidAccounts from '../../../shared/fixtures/api/accounts-response/invalid/with-account-hash.json';
import validationFixture from '../../../shared/fixtures/api/error-response/valid/validation.json';
import { mockApi } from '@/test/render-app';
import createdKey from '../../../shared/fixtures/api/create-key-response/valid/created.json';
import { apiGet, apiSend, apiUrl, KNOWN_ERROR_CODES } from './client';
import { ApiError, ContractError, fieldErrors, isServerDown, NetworkError } from './errors';
import { getServerStatus } from './server-status';

describe('apiUrl', () => {
  it('builds same-origin URLs and leaves out empty parameters', () => {
    expect(apiUrl('/accounts/all/gains', { period: 'week', from: undefined, to: null })).toBe(
      '/api/v1/accounts/all/gains?period=week',
    );
    expect(apiUrl('/health')).toBe('/api/v1/health');
  });
});

describe('apiGet', () => {
  it('returns the body of a valid response', async () => {
    mockApi();
    const health = await apiGet<{ status: string }>('health-response', '/health');
    expect(health.status).toBe('ok');
  });

  it('checks responses against the contract in development and tests', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockApi({ '/api/v1/accounts': { body: invalidAccounts } });
    await expect(apiGet('accounts-response', '/accounts')).rejects.toBeInstanceOf(ContractError);
  });

  it('turns an error body into an ApiError with details', async () => {
    mockApi({ '/api/v1/accounts': { status: 400, body: validationFixture } });
    const error: unknown = await apiGet('accounts-response', '/accounts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VALIDATION_ERROR');
    expect((error as ApiError).details.length).toBeGreaterThan(0);
    expect(getServerStatus()).toEqual({ down: false, forbidden: false, unauthorized: 0 });
  });

  it('handles error bodies that are not the shared format', async () => {
    mockApi({ '/api/v1/accounts': () => new Response('Bad gateway', { status: 502 }) });
    const error: unknown = await apiGet('accounts-response', '/accounts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UNKNOWN');
    expect(isServerDown(error)).toBe(true);
  });

  it('marks the server down when fetch fails, and up again on the next answer', async () => {
    mockApi({
      '/api/v1/health': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(apiGet('health-response', '/health')).rejects.toBeInstanceOf(NetworkError);
    expect(getServerStatus().down).toBe(true);

    mockApi();
    await apiGet('health-response', '/health');
    expect(getServerStatus().down).toBe(false);
  });

  it('records a 403', async () => {
    mockApi({
      '/api/v1/accounts': {
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Forbidden', details: [] } },
      },
    });
    await expect(apiGet('accounts-response', '/accounts')).rejects.toBeInstanceOf(ApiError);
    expect(getServerStatus().forbidden).toBe(true);
  });

  it('knows the same error codes as the contract', () => {
    expect([...KNOWN_ERROR_CODES]).toEqual([...ERROR_CODES]);
  });
});

describe('apiSend', () => {
  it('sends a JSON body and returns the checked response', async () => {
    const fetchMock = mockApi({ 'POST /api/v1/keys': { status: 201, body: createdKey } });
    const result = await apiSend<{ key: string }>('POST', '/keys', {
      body: { name: 'Gaming PC' },
      schema: 'create-key-response',
    });
    expect(result.key).toBe(createdKey.key);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/keys');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"name":"Gaming PC"}');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it.each(['PUT', 'PATCH'] as const)('sends %s with a JSON body', async (method) => {
    const answer = { accountId: 1, mode: 'FFA' };
    const fetchMock = mockApi({
      [`${method} /api/v1/accounts/1/raids/split-default`]: { body: answer },
    });
    const result = await apiSend<{ mode: string }>(method, '/accounts/1/raids/split-default', {
      body: { mode: 'FFA' },
      schema: 'raid-split-default-response',
    });
    expect(result).toEqual(answer);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe(method);
    expect(init?.body).toBe('{"mode":"FFA"}');
  });

  it('sends no body or content type without a body, and accepts 204', async () => {
    const fetchMock = mockApi({ 'DELETE /api/v1/keys/4': { status: 204, body: null } });
    await expect(apiSend('DELETE', '/keys/4')).resolves.toBeUndefined();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
  });

  it('turns an error body into an ApiError with details', async () => {
    mockApi({ 'POST /api/v1/keys': { status: 400, body: validationFixture } });
    const error: unknown = await apiSend('POST', '/keys', { body: { name: '' } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).details.length).toBeGreaterThan(0);
  });

  it('marks the server down when fetch fails', async () => {
    mockApi({
      'POST /api/v1/admin/rebuild': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(apiSend('POST', '/admin/rebuild')).rejects.toBeInstanceOf(NetworkError);
    expect(getServerStatus().down).toBe(true);
  });

  it('checks the method, so a GET answer is not used for a POST', async () => {
    mockApi({ 'GET /api/v1/keys': { body: { keys: [] } } });
    await expect(apiSend('POST', '/keys', { body: { name: 'x' } })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe('fieldErrors', () => {
  it('maps VALIDATION_ERROR details to fields, first message wins', () => {
    const error = new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
      { path: 'body.name', message: 'Name is required' },
      { path: 'body.name', message: 'Second message' },
      { path: '', message: 'Whole request' },
    ]);
    expect(fieldErrors(error)).toEqual({ name: 'Name is required', '': 'Whole request' });
  });

  it('is empty for other errors', () => {
    expect(fieldErrors(new ApiError(404, 'NOT_FOUND', 'Not found'))).toEqual({});
    expect(fieldErrors(new Error('x'))).toEqual({});
  });
});
