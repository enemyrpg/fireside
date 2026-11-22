import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import {
  acceptedKeyPrefixes,
  findApiKey,
  isWellFormedApiKey,
  systemClock,
  touchLastUsed,
  type Clock,
} from './api-keys.js';
import { IpFailureLimiter } from './login-limiter.js';
import { logSecurityEvent } from './security-log.js';

// Bearer API key auth for the plugin (see
// docs/decisions/0005-security-defaults.md). Keys can send, and read only
// their own name with the server's versions and clock (`verify`) and which
// icons are missing (`icons/wanted`): this hook must only run in the ingest
// scope. Dashboard auth is session-based and must
// never accept API keys.

/** Routes where API keys are valid. */
export const INGEST_PREFIX = '/api/v1/ingest';

declare module 'fastify' {
  interface FastifyRequest {
    /** The key that authenticated the request. Only set on ingest routes. */
    apiKey?: AuthenticatedKey;
  }
}

export interface IngestAuthOptions {
  /** Defaults to the current branding prefix. Only tests pass others. */
  prefixes?: readonly string[];
  now?: Clock;
  /** Limits requests without a valid key per client IP. Tests replace it. */
  ipLimiter?: IpFailureLimiter;
}

/** The key behind an ingest request. Events it sends belong to `userId`. */
export interface AuthenticatedKey {
  id: number;
  name: string;
  userId: number;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** A 401 error, with the `WWW-Authenticate` header set on the reply (RFC 6750). */
function unauthorized(reply: FastifyReply, message: string): ApiError {
  reply.header('WWW-Authenticate', 'Bearer');
  return new ApiError(401, 'UNAUTHORIZED', message);
}

/** The 429 for a client IP over the limit for requests without a valid key. */
function tooMany(
  request: FastifyRequest,
  reply: FastifyReply,
  blocked: { retryAfterSeconds: number },
): ApiError {
  reply.header('retry-after', String(blocked.retryAfterSeconds));
  // The IP was logged once, when it got blocked (`failed` below).
  request.log.debug({}, 'Ingest refused: too many requests without a valid API key');
  return new ApiError(
    429,
    'RATE_LIMITED',
    `Too many requests without a valid API key. Try again in ${String(blocked.retryAfterSeconds)} seconds.`,
  );
}

/**
 * Adds the API key hook to `app`, which must be the encapsulated ingest scope
 * (a plugin registered with exactly the `/api/v1/ingest` prefix). The hook then
 * covers every route in that scope, including nested plugins, and nothing
 * outside it. Call it once per scope; it throws anywhere else.
 */
export function addIngestAuth(app: FastifyInstance, options: IngestAuthOptions = {}): void {
  if (app.prefix !== INGEST_PREFIX) {
    throw new Error(`API key auth may only be added at ${INGEST_PREFIX}, not at "${app.prefix}"`);
  }
  const prefixes = options.prefixes ?? acceptedKeyPrefixes();
  const now = options.now ?? systemClock;
  const ipLimiter = options.ipLimiter ?? new IpFailureLimiter({ now });

  // Declared up front so every request in the scope has the same shape.
  app.decorateRequest('apiKey', undefined);

  // Rejections are logged at debug with the reason, without the IP. The
  // error handler already logs every 401 at info. The client's IP is logged
  // as a security event (auth/security-log.ts) only when its failures make the
  // limiter block it, so a plugin without a key in a loop writes one line per
  // block, not one per request.
  //
  // Requests without a valid key are limited per client IP, and every kind
  // counts. A valid key is never limited by its IP.
  // - Missing or malformed: can never be valid, so a blocked IP gets its 429
  //   before any hashing or lookup.
  // - Unknown: 429 once the IP is blocked.
  // - Revoked, or its user disabled: always 401, so the plugin stops and says
  //   the key is invalid instead of backing off on a 429.
  /**
   * Counts a failure from the client's IP. Returns the wait if the IP was
   * already blocked (nothing counted). Logs the IP once when this failure
   * blocks it.
   */
  const failed = (request: FastifyRequest) => {
    const already = ipLimiter.fail(request.clientIp);
    if (already) return already;
    const now = ipLimiter.blocked(request.clientIp);
    if (now) {
      logSecurityEvent(
        request,
        'rate_limited',
        'Ingest: IP blocked after requests without a valid API key',
        {
          retryAfterSeconds: now.retryAfterSeconds,
        },
      );
    }
    return undefined;
  };

  app.addHook('onRequest', async (request, reply) => {
    const match = BEARER.exec(request.headers.authorization?.trim() ?? '');
    const key = match?.[1];
    if (key === undefined || !isWellFormedApiKey(key, prefixes)) {
      const reason = key === undefined ? 'missing' : 'malformed';
      const blocked = ipLimiter.blocked(request.clientIp);
      if (blocked) throw tooMany(request, reply, blocked);
      failed(request);
      request.log.debug({ reason }, 'API key rejected');
      throw unauthorized(reply, 'Missing or malformed API key');
    }

    const result = findApiKey(app.db, key, prefixes);
    if (result.status === 'malformed') {
      // Checked above already; kept so the cases stay exhaustive.
      failed(request);
      throw unauthorized(reply, 'Missing or malformed API key');
    }
    if (result.status === 'unknown') {
      const blocked = failed(request);
      if (blocked) throw tooMany(request, reply, blocked);
      request.log.debug({ reason: 'unknown' }, 'API key rejected');
      throw unauthorized(reply, 'Invalid or revoked API key');
    }
    if (result.status !== 'active') {
      failed(request);
      request.log.debug({ reason: result.status, apiKeyId: result.row.id }, 'API key rejected');
      throw unauthorized(reply, 'Invalid or revoked API key');
    }

    // Best effort: `last_used_at` is informational, so a busy or locked
    // database must not fail a request whose key is valid.
    try {
      touchLastUsed(app.db, result.row, now());
    } catch (error) {
      request.log.warn({ err: error, apiKeyId: result.row.id }, 'Could not update last_used_at');
    }
    request.apiKey = { id: result.row.id, name: result.row.name, userId: result.row.userId };
  });
}
