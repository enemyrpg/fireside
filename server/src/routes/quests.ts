import {
  accountParamsSchema,
  questsQuerySchema,
  type DiariesResponse,
  type QuestsResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { diaries, quests } from '../read/quests.js';
import { ownedAccount } from './account-scope.js';
import { parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// `GET /accounts/:accountId/quests` and `/diaries`. Registered in the dashboard
// scope. One account at a time: `all` is a 400.

export const questRoutes: FastifyPluginCallback = (app, _options, done) => {
  /** The account ID of the request; rejects `all`, unknown IDs and query parameters. */
  const accountOf = (request: FastifyRequest): number => {
    const { accountId } = parseRequest(accountParamsSchema, request.params, 'params');
    parseRequest(questsQuerySchema, request.query, 'query');
    return ownedAccount(request, accountId);
  };

  app.get('/accounts/:accountId/quests', USER_ROUTE, (request): QuestsResponse =>
    quests(app.db, accountOf(request)),
  );

  app.get('/accounts/:accountId/diaries', USER_ROUTE, (request): DiariesResponse =>
    diaries(app.db, accountOf(request)),
  );

  done();
};
