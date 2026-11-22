import type { ErrorCode, ErrorResponse } from '@fireside/shared';

// Errors from the API client. Messages here are for logs only: the UI shows its
// own texts, never these.

export type ErrorDetail = ErrorResponse['error']['details'][number];

/** The server answered with an error status. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'UNKNOWN',
    message: string,
    readonly details: readonly ErrorDetail[] = [],
  ) {
    super(message);
  }
}

/** The server couldn't be reached (fetch failed, or the dev proxy got no answer). */
export class NetworkError extends Error {
  override name = 'NetworkError';
}

/** The response didn't match the contract (checked in development and tests only). */
export class ContractError extends Error {
  override name = 'ContractError';
}

/** Status codes the Vite dev proxy (or a reverse proxy) returns when the server is down. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** Whether the error means the server is down, not that the request was wrong. */
export function isServerDown(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    (error instanceof ApiError && GATEWAY_STATUSES.has(error.status) && error.code === 'UNKNOWN')
  );
}

/**
 * The server refused because it is busy or the client must wait (`429`, or a
 * `503` of its own with `Retry-After`): its message says what to do.
 */
export function isAskedToWait(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 429 || (error.status === 503 && error.code === 'RATE_LIMITED'))
  );
}

/**
 * Thrown by a page to replace itself with the full-page 404, e.g. for a session
 * that doesn't exist. The message is shown to the user.
 */
export class PageNotFoundError extends Error {
  override name = 'PageNotFoundError';
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * `VALIDATION_ERROR` details by field, for messages under form fields. The key
 * is the last part of the path (`body.name` -> `name`); details without a path
 * go under `''`. The first message per field wins.
 */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_ERROR') return {};
  const result: Record<string, string> = {};
  for (const detail of error.details) {
    const field = detail.path.split('.').at(-1) ?? '';
    result[field] ??= detail.message;
  }
  return result;
}
