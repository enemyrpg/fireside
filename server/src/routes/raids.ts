import { accountScopeParamsSchema, raidsQuerySchema, type RaidsResponse } from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { raidSummaries, specialLoot } from '../read/raids.js';
import { scopeIds } from './account-scope.js';
import { parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// `GET /accounts/:accountId/raids`. Registered in the dashboard scope.

export const raidRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/accounts/:accountId/raids', USER_ROUTE, (request): RaidsResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(raidsQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    return {
      raids: raidSummaries(app.db, accountIds),
      specialLoot: specialLoot(app.db, { accountIds, ...query }),
    };
  });

  done();
};
