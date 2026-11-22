import {
  accountScopeParamsSchema,
  calendarQuerySchema,
  sessionParamsSchema,
  sessionsQuerySchema,
  toLocal,
  type CalendarResponse,
  type SessionDetailResponse,
  type SessionsResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { ApiError } from '../errors.js';
import { calendarDays, localYear } from '../read/playtime.js';
import { listSessions, sessionDetail } from '../read/sessions.js';
import { scopeIds } from './account-scope.js';
import { noQuerySchema, parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// `GET /accounts/:accountId/sessions`, `/sessions/:sessionId` and
// `/accounts/:accountId/calendar`. Registered in the dashboard scope.

export interface SessionRoutesOptions {
  /** IANA time zone for calendar days (`TZ`). */
  timeZone: string;
  /** Clock for the default calendar year. Tests inject it. */
  now?: Clock;
}

export const sessionRoutes: FastifyPluginCallback<SessionRoutesOptions> = (
  app,
  { timeZone, now = systemClock },
  done,
) => {
  app.get('/accounts/:accountId/sessions', USER_ROUTE, (request): SessionsResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(sessionsQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    return listSessions(app.db, { accountIds, ...query });
  });

  app.get('/sessions/:sessionId', USER_ROUTE, (request): SessionDetailResponse => {
    const { sessionId } = parseRequest(sessionParamsSchema, request.params, 'params');
    parseRequest(noQuerySchema, request.query, 'query');
    // Another user's session is not found, the same as an unknown ID.
    const detail = sessionDetail(app.db, scopeIds(request, 'all'), sessionId);
    if (!detail) throw new ApiError(404, 'NOT_FOUND', 'Session not found');
    return detail;
  });

  app.get('/accounts/:accountId/calendar', USER_ROUTE, (request): CalendarResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(calendarQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    let range: { year: number | null; from: string; to: string };
    if (query.from !== undefined && query.to !== undefined) {
      range = { year: null, from: query.from, to: query.to };
    } else {
      const year = query.year ?? toLocal(now().getTime(), timeZone).year;
      const { start, end } = localYear(year, timeZone);
      range = { year, from: new Date(start).toISOString(), to: new Date(end).toISOString() };
    }
    return { ...range, days: calendarDays(app.db, { accountIds, ...range }, timeZone) };
  });

  done();
};
