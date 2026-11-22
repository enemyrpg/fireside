import {
  accountParamsSchema,
  accountScopeParamsSchema,
  raidDropCreateRequestSchema,
  raidDropParamsSchema,
  raidDropUpdateRequestSchema,
  raidSplitDefaultRequestSchema,
  raidSplitsQuerySchema,
  type RaidDropResponse,
  type RaidSplitDefaultResponse,
  type RaidSplitsResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { ApiError } from '../errors.js';
import {
  createManualDrop,
  deleteManualDrop,
  InvalidChoiceError,
  setSplitDefault,
  updateDropChoices,
} from '../raids/choices.js';
import { findTrackedDrop, raidSplits, splitDefault } from '../read/raid-splits.js';
import { ownedAccount, scopeIds } from './account-scope.js';
import { jsonBodiesOnly } from './json-body.js';
import { parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// Raid loot split tracker. Registered in the dashboard scope, so the changes
// get the network and Origin checks, and each account and drop must be the
// user's own (`ownedAccount`): `404` before anything is stored.
//
// Nicknames and notes are the owner's own notes: the log lines here carry
// the drop ID and the names of the changed fields, never their values.

export interface RaidSplitRoutesOptions {
  timeZone: string;
  now?: Clock;
}

function dropNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Drop not found');
}

/** Runs a write; a value that can't be stored becomes `400` on its body field. */
function storing<T>(write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (!(error instanceof InvalidChoiceError)) throw error;
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
      { path: `body.${error.field}`, message: error.message },
    ]);
  }
}

export const raidSplitRoutes: FastifyPluginCallback<RaidSplitRoutesOptions> = (
  app,
  options,
  done,
) => {
  const now = options.now ?? systemClock;

  jsonBodiesOnly(app);

  /** The drop as the list shows it, after a change. */
  function dropResponse(accountId: number, dropId: string): RaidDropResponse {
    const tracked = findTrackedDrop(app.db, accountId, dropId);
    if (!tracked) throw dropNotFound();
    return { drop: tracked.drop };
  }

  app.get('/accounts/:accountId/raids/splits', USER_ROUTE, (request): RaidSplitsResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(raidSplitsQuerySchema, request.query, 'query');
    return raidSplits(app.db, {
      accountIds: scopeIds(request, accountId),
      ...query,
      timeZone: options.timeZone,
      now: now(),
    });
  });

  app.put(
    '/accounts/:accountId/raids/split-default',
    USER_ROUTE,
    (request): RaidSplitDefaultResponse => {
      // One account only: `all` has no default of its own.
      const { accountId } = parseRequest(accountParamsSchema, request.params, 'params');
      const { mode } = parseRequest(raidSplitDefaultRequestSchema, request.body, 'body');
      ownedAccount(request, accountId);
      setSplitDefault(app.db, accountId, mode, now());
      request.log.info({ accountId, mode }, 'Raid split default set');
      return splitDefault(app.db, accountId);
    },
  );

  app.post('/accounts/:accountId/raids/drops', USER_ROUTE, (request, reply): RaidDropResponse => {
    const { accountId } = parseRequest(accountParamsSchema, request.params, 'params');
    const body = parseRequest(raidDropCreateRequestSchema, request.body, 'body');
    ownedAccount(request, accountId);
    const dropId = storing(() => createManualDrop(app.db, accountId, body, now()));
    request.log.info({ accountId, dropId }, 'Manual raid drop added');
    void reply.code(201);
    return dropResponse(accountId, dropId);
  });

  app.patch('/accounts/:accountId/raids/drops/:dropId', USER_ROUTE, (request): RaidDropResponse => {
    const params = parseRequest(raidDropParamsSchema, request.params, 'params');
    const body = parseRequest(raidDropUpdateRequestSchema, request.body, 'body');
    ownedAccount(request, params.accountId);
    const dropId = storing(() =>
      updateDropChoices(app.db, params.accountId, params.dropId, body, now()),
    );
    if (dropId === undefined) throw dropNotFound();
    request.log.info(
      { accountId: params.accountId, dropId, fields: Object.keys(body).sort() },
      'Raid drop choices changed',
    );
    return dropResponse(params.accountId, dropId);
  });

  app.delete('/accounts/:accountId/raids/drops/:dropId', USER_ROUTE, (request, reply) => {
    const params = parseRequest(raidDropParamsSchema, request.params, 'params');
    ownedAccount(request, params.accountId);
    const result = deleteManualDrop(app.db, params.accountId, params.dropId);
    if (result === 'not-found') throw dropNotFound();
    if (result === 'not-manual') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
        { path: 'params.dropId', message: 'Only a drop you added yourself can be deleted' },
      ]);
    }
    request.log.info(
      { accountId: params.accountId, dropId: params.dropId },
      'Manual raid drop deleted',
    );
    return reply.code(204).send();
  });

  done();
};
