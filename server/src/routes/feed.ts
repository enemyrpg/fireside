import { accountScopeParamsSchema, feedQuerySchema, type FeedResponse } from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { USER_ROUTE } from '../auth/dashboard-auth.js';
import { feed } from '../read/feed.js';
import { scopeIds } from './account-scope.js';
import { parseRequest } from './parse.js';

// `GET /accounts/:accountId/feed`. Registered in the dashboard scope.
// `:accountId` may be `all`: the caller's own accounts, as every other
// `accounts/…` route.

export const feedRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/accounts/:accountId/feed', USER_ROUTE, (request): FeedResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(feedQuerySchema, request.query, 'query');
    return feed(app.db, { accountIds: scopeIds(request, accountId), ...query });
  });

  done();
};
