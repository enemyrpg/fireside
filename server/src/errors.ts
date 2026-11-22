import type { ErrorCode, ErrorResponse } from '@fireside/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HASHER_BUSY_RETRY_AFTER_SECONDS, HasherBusyError } from './users/password.js';

// Maps anything a route or Fastify throws to the shared error format
// (see docs/api.md#errors).

export type ErrorDetail = ErrorResponse['error']['details'][number];

/** Error with a known status and code. Throw it from routes. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message);
  }
}

export interface MappedError {
  statusCode: number;
  body: ErrorResponse;
  /** Set for a `503` the server chose to give: sent as `Retry-After`, not logged as a failure. */
  retryAfterSeconds?: number;
}

/** Shown when the password queue is full. */
export const SERVER_BUSY = 'The server is busy. Try again in a few seconds.';

const INTERNAL_MESSAGE = 'Internal server error';

const CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
};

function errorBody(code: ErrorCode, message: string, details: ErrorDetail[] = []): ErrorResponse {
  return { error: { code, message, details } };
}

/** URL without the query string, which is never needed in logs or errors and could hold something private. */
export function withoutQuery(url: string): string {
  return url.split('?', 1)[0] ?? url;
}

/**
 * Whether `url` is under `/api`. Such paths never get the dashboard's
 * index.html (routes/web.ts) and are never stored by caches (security-headers.ts).
 */
export function isApiPath(url: string): boolean {
  const path = withoutQuery(url);
  return path === '/api' || path.startsWith('/api/');
}

export function notFound(method: string, url: string): MappedError {
  return {
    statusCode: 404,
    body: errorBody('NOT_FOUND', `Route ${method} ${withoutQuery(url)} not found`),
  };
}

/** Not-found handler for `setNotFoundHandler`. Used at the root and in scopes with their own hooks. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const { statusCode, body } = notFound(request.method, request.url);
  return reply.code(statusCode).send(body);
}

interface ZodLikeError {
  name: 'ZodError';
  issues: { path: PropertyKey[]; message: string }[];
}

// Duck-typed so it also matches errors from another copy of zod (e.g. shared's).
function isZodError(error: unknown): error is ZodLikeError {
  return (
    error instanceof Error &&
    error.name === 'ZodError' &&
    Array.isArray((error as Partial<ZodLikeError>).issues)
  );
}

interface FastifyLikeError {
  code?: unknown;
  statusCode?: unknown;
  message?: unknown;
  validation?: { instancePath?: string; message?: string }[];
  validationContext?: string;
}

function asFastifyError(error: unknown): FastifyLikeError {
  return typeof error === 'object' && error !== null ? error : {};
}

/**
 * Turns a JSON pointer like `/items/0/qty` into `items.0.qty`, decoding the
 * `~1` (`/`) and `~0` (`~`) escapes (RFC 6901, in that order).
 */
function pointerToPath(context: string | undefined, pointer: string | undefined): string {
  const parts = (pointer ?? '')
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  return [context, ...parts].filter(Boolean).join('.');
}

/** Messages for 4xx errors that don't come from Fastify itself. */
const GENERIC_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Invalid request',
  BAD_REQUEST: 'Bad request',
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  RATE_LIMITED: 'Too many requests',
  INTERNAL_ERROR: INTERNAL_MESSAGE,
};

/** Fastify's own errors (`FST_*`) have messages written for clients. */
function isFastifyOwnError(error: FastifyLikeError): boolean {
  return typeof error.code === 'string' && error.code.startsWith('FST_');
}

/**
 * Maps a thrown error to a status and error body. Unknown errors become a
 * generic 500, and 4xx errors from outside Fastify get a generic message, so
 * internal messages and stack traces never reach the client.
 */
export function toErrorResponse(error: unknown): MappedError {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      body: errorBody(error.code, error.message, error.details),
    };
  }

  // Too many password operations waiting: the client should try again soon.
  // `RATE_LIMITED`, as for a `429`: no new error code in the contract.
  if (error instanceof HasherBusyError) {
    return {
      statusCode: 503,
      body: errorBody('RATE_LIMITED', SERVER_BUSY),
      retryAfterSeconds: HASHER_BUSY_RETRY_AFTER_SECONDS,
    };
  }

  if (isZodError(error)) {
    const details = error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    return { statusCode: 400, body: errorBody('VALIDATION_ERROR', 'Invalid request', details) };
  }

  const fastifyError = asFastifyError(error);

  if (Array.isArray(fastifyError.validation)) {
    const details = fastifyError.validation.map((item) => ({
      path: pointerToPath(fastifyError.validationContext, item.instancePath),
      message: item.message ?? 'Invalid value',
    }));
    return { statusCode: 400, body: errorBody('VALIDATION_ERROR', 'Invalid request', details) };
  }

  const status = fastifyError.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code = CODE_BY_STATUS[status] ?? 'BAD_REQUEST';
    // Other libraries' messages can hold internals (paths, upstream details).
    const message =
      isFastifyOwnError(fastifyError) &&
      typeof fastifyError.message === 'string' &&
      fastifyError.message !== ''
        ? fastifyError.message
        : GENERIC_MESSAGES[code];
    return { statusCode: status, body: errorBody(code, message) };
  }

  return { statusCode: 500, body: errorBody('INTERNAL_ERROR', INTERNAL_MESSAGE) };
}
