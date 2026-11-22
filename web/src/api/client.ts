import type { ApiSchemaName, ErrorCode } from '@fireside/shared';
import { ApiError, isServerDown, NetworkError, type ErrorDetail } from './errors';
import { reportError, reportSuccess } from './server-status';

// The dashboard only ever calls its own server, on the same origin.

export const API_BASE = '/api/v1';

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

/** `path` plus the query string. `undefined` and `null` values are left out. */
export function apiUrl(path: string, query: QueryParams = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const text = search.toString();
  return `${API_BASE}${path}${text ? `?${text}` : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Same list as `ERROR_CODES` in shared (a test checks it). Copied because that
 * module builds Zod schemas when it loads, which would pull Zod into the bundle.
 */
export const KNOWN_ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const satisfies readonly ErrorCode[];

function isErrorCode(value: unknown): value is ErrorCode {
  return (KNOWN_ERROR_CODES as readonly unknown[]).includes(value);
}

function isErrorDetail(value: unknown): value is ErrorDetail {
  return isRecord(value) && typeof value.path === 'string' && typeof value.message === 'string';
}

/**
 * Builds an `ApiError` from an error response. Checked by hand rather than
 * with the Zod schema, so production builds don't need Zod. Bodies that
 * aren't the shared error format (e.g. from a proxy) still give an error.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = isRecord(body) ? body.error : undefined;
  if (isRecord(error) && isErrorCode(error.code) && typeof error.message === 'string') {
    const details = Array.isArray(error.details) ? error.details.filter(isErrorDetail) : [];
    return new ApiError(response.status, error.code, error.message, details);
  }
  return new ApiError(response.status, 'UNKNOWN', `HTTP ${String(response.status)}`);
}

export interface RequestOptions {
  query?: QueryParams;
  signal?: AbortSignal;
}

/**
 * Sends a request and returns the response if it is OK. Throws `ApiError` for
 * error statuses and `NetworkError` when the server can't be reached, and
 * reports both to the server status (banner, 403 page) right away.
 */
async function send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal?.aborted) throw error;
    const networkError = new NetworkError('Could not reach the server', { cause: error });
    reportError(networkError);
    throw networkError;
  }
  if (!response.ok) {
    const apiError = await toApiError(response);
    // Shows the server-down banner or the 403 page right away, before any retry.
    reportError(apiError);
    if (!isServerDown(apiError)) reportSuccess();
    throw apiError;
  }
  reportSuccess();
  return response;
}

/** Reads the body and, in development and tests, checks it against the contract schema. */
async function readBody<T>(schema: ApiSchemaName, response: Response): Promise<T> {
  const data: unknown = await response.json();
  if (import.meta.env.DEV) {
    const { validateResponse } = await import('./validate');
    validateResponse(schema, data);
  }
  // The server's responses follow the contract (checked above in development).
  return data as T;
}

/**
 * GET from the API. Throws `ApiError` for error statuses and `NetworkError`
 * when the server can't be reached. In development and tests, the body is
 * checked against the contract schema `schema`.
 */
export async function apiGet<T>(
  schema: ApiSchemaName,
  path: string,
  { query, signal }: RequestOptions = {},
): Promise<T> {
  const response = await send(
    apiUrl(path, query),
    { headers: { accept: 'application/json' } },
    signal,
  );
  return readBody<T>(schema, response);
}

export interface SendOptions {
  /** Sent as JSON. Without a body, no `content-type` is sent. */
  body?: unknown;
  /** Contract schema of the response body; leave out for `204 No Content`. */
  schema?: ApiSchemaName;
}

/**
 * POST, PUT, PATCH or DELETE to the API (dashboard actions: API keys, rebuild,
 * the raid split tracker). Errors as for `apiGet`. Returns the checked body, or `undefined` without `schema`.
 */
export async function apiSend<T = undefined>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  { body, schema }: SendOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await send(apiUrl(path), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  // Without a schema the caller expects no body (`204`).
  if (schema === undefined) return undefined as T;
  return readBody<T>(schema, response);
}
