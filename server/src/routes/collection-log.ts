import {
  accountParamsSchema,
  collectionLogQuerySchema,
  collectionLogSourceRequestSchema,
  type CollectionLogResponse,
  type CollectionLogStatusResponse,
  type CollectionLogSyncResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { setClogSource, type ClogSyncer } from '../clog/sync.js';
import { ApiError } from '../errors.js';
import { collectionLog, collectionLogStatus, collectionLogSync } from '../read/collection-log.js';
import { ownedAccount } from './account-scope.js';
import { jsonBodiesOnly } from './json-body.js';
import { noQuerySchema, parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// Collection log from an optional external source. Registered in the dashboard
// scope. One account at a time: `all` is not accepted.

export interface CollectionLogRoutesOptions {
  syncer: ClogSyncer;
  now?: Clock;
}

export const collectionLogRoutes: FastifyPluginCallback<CollectionLogRoutesOptions> = (
  app,
  { syncer, now = systemClock },
  done,
) => {
  jsonBodiesOnly(app);

  const readOptions = (accountId: number) => ({
    sourceActive: syncer.sourceActive(),
    syncing: syncer.isSyncing(accountId),
    nowMs: now().getTime(),
  });

  /**
   * The path's account ID. 404 for an unknown account or another user's,
   * before anything else happens (no sync is started, nothing is stored).
   */
  function accountOf(request: FastifyRequest): number {
    const { accountId } = parseRequest(accountParamsSchema, request.params, 'params');
    return ownedAccount(request, accountId);
  }

  // Always 200 for a known account: the source's state is in `sync.status`.
  app.get('/accounts/:accountId/collection-log', USER_ROUTE, (request): CollectionLogResponse => {
    const accountId = accountOf(request);
    parseRequest(collectionLogQuerySchema, request.query, 'query');
    return collectionLog(app.db, accountId, readOptions(accountId));
  });

  // The same without the tabs (contract 1.26.0): cheap enough to poll while a
  // sync runs, and all that Settings, menus and the account cards need.
  app.get(
    '/accounts/:accountId/collection-log/status',
    USER_ROUTE,
    (request): CollectionLogStatusResponse => {
      const accountId = accountOf(request);
      parseRequest(collectionLogQuerySchema, request.query, 'query');
      return collectionLogStatus(app.db, accountId, readOptions(accountId));
    },
  );

  // The owner's opt-in. Turning it on starts a first sync when the source is
  // on in `.env`; turning it off keeps the stored collection log.
  app.put(
    '/accounts/:accountId/collection-log/source',
    USER_ROUTE,
    (request): CollectionLogSyncResponse => {
      const accountId = accountOf(request);
      parseRequest(noQuerySchema, request.query, 'query');
      const { source } = parseRequest(collectionLogSourceRequestSchema, request.body, 'body');
      setClogSource(app.db, accountId, source, now());
      request.log.info({ accountId, source }, 'Collection log source changed');
      if (source !== null) syncer.start(accountId);
      return collectionLogSync(app.db, accountId, readOptions(accountId));
    },
  );

  // "Sync now". Answers at once: the dashboard reads the result from the GET.
  app.post(
    '/accounts/:accountId/collection-log/sync',
    USER_ROUTE,
    (request, reply): CollectionLogSyncResponse => {
      const accountId = accountOf(request);
      parseRequest(noQuerySchema, request.query, 'query');
      const result = syncer.start(accountId);
      if (!result.started) {
        if (result.reason === 'NO_SOURCE') {
          throw new ApiError(
            409,
            'CONFLICT',
            'No collection log source is turned on for this account',
          );
        }
        if (result.reason === 'SOURCE_OFF') {
          throw new ApiError(409, 'CONFLICT', 'The collection log source is off on this server');
        }
        if (result.reason === 'TOO_SOON') {
          const seconds = Math.max(
            1,
            Math.ceil((result.retryAt.getTime() - now().getTime()) / 1000),
          );
          void reply.header('Retry-After', String(seconds));
          throw new ApiError(429, 'RATE_LIMITED', 'This account was synced less than a minute ago');
        }
        // `RUNNING`: the sync the caller asked for is already under way.
      }
      void reply.code(202);
      return collectionLogSync(app.db, accountId, readOptions(accountId));
    },
  );

  done();
};
