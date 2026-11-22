import rateLimit from '@fastify/rate-limit';
import {
  CONTRACT_VERSION,
  iconsUploadRequestSchema,
  iconsWantedRequestSchema,
  ingestRequestSchema,
  MAX_ICONS_BODY_BYTES,
  type IconsUploadResponse,
  type IconsWantedResponse,
  MAX_INGEST_BYTES,
  type IngestResponse,
  type IngestVerifyResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import {
  addIngestAuth,
  type AuthenticatedKey,
  type IngestAuthOptions,
} from '../auth/ingest-auth.js';
import { ApiError, notFoundHandler } from '../errors.js';
import { logSecurityEvent } from '../auth/security-log.js';
import { findMissingIcons, findMissingNamedIcons, storeIcons } from '../icons/store.js';
import { storeEvents } from '../ingest/store.js';
import { validateBatch } from '../ingest/validate.js';
import { PROJECTIONS, projectEvents, type Projection } from '../projections/index.js';
import { SERVER_VERSION } from '../version.js';

/**
 * Requests per key per window, shared by all ingest routes. The plugin sends
 * every 30 s or at 50 events (2–4 requests/min per client), so this leaves
 * room for several clients on one key and for flushing a large backlog. See
 * docs/api.md#rate-limits.
 */
export const INGEST_RATE_LIMIT = { max: 120, timeWindowMs: 60_000 };

export interface IngestRoutesOptions extends IngestAuthOptions {
  /** Overrides `INGEST_RATE_LIMIT`. Used by tests. */
  rateLimit?: { max: number; timeWindowMs: number };
  /** Overrides `PROJECTIONS`. Used by tests. */
  projections?: readonly Projection[];
}

/** The key set by the auth hook. Missing means the hook didn't run, which is a bug. */
function apiKeyOf(request: FastifyRequest): AuthenticatedKey {
  if (!request.apiKey) throw new Error('Ingest route reached without an authenticated API key');
  return request.apiKey;
}

/**
 * Everything under `/api/v1/ingest`. Every route here requires an API key,
 * and so do unknown paths: they get 401 without a valid key and 404 with one,
 * so the routes can't be probed without a key. Order per request: auth (401,
 * or 429 per client IP after too many requests without a valid key), rate
 * limit per key (429), body parsing (400/413), handler.
 */
export const ingestRoutes: FastifyPluginCallback<IngestRoutesOptions> = (app, options, done) => {
  try {
    addIngestAuth(app, options);
  } catch (error) {
    done(error as Error);
    return;
  }

  // Only JSON is accepted. Anything else is a bad batch (400, as in the status
  // table in 03), not Fastify's 415. The body is never read.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('*', (_request, _payload, parse) => {
    parse(new ApiError(400, 'BAD_REQUEST', 'Content-Type must be application/json'));
  });

  const limit = options.rateLimit ?? INGEST_RATE_LIMIT;
  void app.register(rateLimit, {
    max: limit.max,
    timeWindow: limit.timeWindowMs,
    // Route-level hook, so it runs after the scope's auth hook and sees the key.
    hook: 'onRequest',
    keyGenerator: (request) => `key:${String(apiKeyOf(request).id)}`,
    // The in-memory store is an LRU of this many keys, so memory stays bounded.
    cache: 10_000,
    errorResponseBuilder: (request, context) => {
      logSecurityEvent(request, 'rate_limited', 'Ingest refused: rate limit', {
        apiKeyId: apiKeyOf(request).id,
      });
      return new ApiError(429, 'RATE_LIMITED', `Rate limit exceeded, retry in ${context.after}`);
    },
  });

  // A child plugin, so its routes are added after the rate limiter is loaded
  // and get its hook, and the not-found handler can use `app.rateLimit()`.
  void app.register(ingestEndpoints, {
    now: options.now ?? systemClock,
    projections: options.projections ?? PROJECTIONS,
  });
  done();
};

interface IngestEndpointsOptions {
  now: Clock;
  projections: readonly Projection[];
}

const ingestEndpoints: FastifyPluginCallback<IngestEndpointsOptions> = (
  app,
  { now, projections },
  done,
) => {
  // Runs after the scope's auth hook. Unknown paths count against the same
  // per-key limit as the routes, so they can't be used to get around it.
  app.setNotFoundHandler({ preValidation: app.rateLimit() }, notFoundHandler);

  app.get('/verify', (request): IngestVerifyResponse => ({
    ok: true,
    keyName: apiKeyOf(request).name,
    serverVersion: SERVER_VERSION,
    contractVersion: CONTRACT_VERSION,
    serverTime: now().toISOString(),
  }));

  app.post('/', { bodyLimit: MAX_INGEST_BYTES }, (request): IngestResponse => {
    const apiKey = apiKeyOf(request);
    // Checks only the envelope; a ZodError here becomes 400 VALIDATION_ERROR.
    const { events } = ingestRequestSchema.parse(request.body);
    const validated = validateBatch(events);
    const stored = storeEvents(app.db, validated.valid, {
      userId: apiKey.userId,
      apiKeyId: apiKey.id,
      receivedAt: now().toISOString(),
    });
    const { accepted, duplicates, foreignDuplicates, storedIds } = stored;
    const rejected = [...validated.rejected, ...stored.rejected].sort((a, b) => a.index - b.index);

    // The raw events are committed. Projection errors never change the
    // response: failed events are marked in `events`, and if the whole step
    // fails they stay pending and are projected at the next startup.
    let projectionFailures: number;
    try {
      projectionFailures = projectEvents(app.db, storedIds, {
        projections,
        now,
        log: request.log,
      }).failed.length;
    } catch (error) {
      projectionFailures = storedIds.length;
      request.log.error({ err: error }, 'Projection step failed, events left pending');
    }

    // Counts only: payloads hold display names and never go to the logs.
    request.log.info(
      {
        apiKeyId: apiKey.id,
        accepted: accepted.length,
        duplicates: duplicates.length,
        rejected: rejected.length,
        projectionFailures,
      },
      'Ingest batch processed',
    );
    // An ID another user already has: a bug or a replay. Counted, never the IDs.
    if (foreignDuplicates > 0) {
      request.log.warn({ apiKeyId: apiKey.id, foreignDuplicates }, 'Event IDs of another user');
    }
    return { accepted, duplicates, rejected };
  });

  // Icons. Assets, not events: nothing here touches `events`. `wanted` is the one
  // read an ingest key can do: it only says which of the item IDs, skills and boss
  // names sent have no icon (see docs/decisions/0005-security-defaults.md).
  app.post('/icons/wanted', (request): IconsWantedResponse => {
    const { itemIds, skills, bosses } = iconsWantedRequestSchema.parse(request.body);
    const missing = findMissingIcons(app.db, itemIds ?? []);
    const missingSkills = skills && findMissingNamedIcons(app.db, 'SKILL', skills);
    const missingBosses = bosses && findMissingNamedIcons(app.db, 'BOSS', bosses);
    request.log.info(
      {
        apiKeyId: apiKeyOf(request).id,
        requested: (itemIds?.length ?? 0) + (skills?.length ?? 0) + (bosses?.length ?? 0),
        missing: missing.length + (missingSkills?.length ?? 0) + (missingBosses?.length ?? 0),
      },
      'Icon lookup processed',
    );
    // The new lists are only in the answer when they were asked for.
    return {
      missing,
      ...(missingSkills ? { missingSkills } : {}),
      ...(missingBosses ? { missingBosses } : {}),
    };
  });

  app.post('/icons', { bodyLimit: MAX_ICONS_BODY_BYTES }, (request): IconsUploadResponse => {
    // Checks only the envelope; each icon is validated on its own.
    const { icons } = iconsUploadRequestSchema.parse(request.body);
    const { response, kept } = storeIcons(app.db, icons, now());
    // Counts only. `kept`: valid icons with other bytes than the stored one,
    // answered as `unchanged` (the first icon wins).
    request.log.info(
      {
        apiKeyId: apiKeyOf(request).id,
        stored: response.stored.length + (response.storedNamed?.length ?? 0),
        unchanged: response.unchanged.length + (response.unchangedNamed?.length ?? 0) - kept,
        kept,
        rejected: response.rejected.length,
      },
      'Icon upload processed',
    );
    return response;
  });
  done();
};
