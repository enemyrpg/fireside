import { accountScopeParamsSchema, weeklyQuerySchema, type WeeklyResponse } from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { weeklySummary } from '../read/weekly.js';
import { scopeIds } from './account-scope.js';
import { parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// `GET /accounts/:accountId/weekly?week=`. Registered in the dashboard scope.

export interface WeeklyRoutesOptions {
  /** IANA time zone for weeks (`TZ`). */
  timeZone: string;
  /** Clock for the current week and whether a week is complete. Tests inject it. */
  now?: Clock;
}

export const weeklyRoutes: FastifyPluginCallback<WeeklyRoutesOptions> = (
  app,
  { timeZone, now = systemClock },
  done,
) => {
  app.get('/accounts/:accountId/weekly', USER_ROUTE, (request): WeeklyResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const { week } = parseRequest(weeklyQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    return weeklySummary(app.db, accountIds, week, timeZone, now().getTime());
  });

  done();
};
