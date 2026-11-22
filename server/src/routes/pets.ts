import { accountScopeParamsSchema, petsQuerySchema, type PetsResponse } from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { pets } from '../read/pets.js';
import { scopeIds } from './account-scope.js';
import { parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// `GET /accounts/:accountId/pets`. Registered in the dashboard scope. Read
// only: pets come from the collection log and from chat, and cannot be added or
// removed.

export const petRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/accounts/:accountId/pets', USER_ROUTE, (request): PetsResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    parseRequest(petsQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    return pets(app.db, accountIds);
  });

  done();
};
