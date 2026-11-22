import {
  accountScopeParamsSchema,
  screentimeQuerySchema,
  screentimeRangeQuerySchema,
  type ScreentimeHeatmapResponse,
  type ScreentimeResponse,
  type ScreentimeWorldsResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import {
  defaultRange,
  screentime,
  screentimeHeatmap,
  screentimeWorlds,
  type TimeRange,
} from '../read/screentime.js';
import { scopeIds } from './account-scope.js';
import { parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// `GET /accounts/:accountId/screentime`, `/screentime/worlds` and
// `/screentime/heatmap`. Registered in the dashboard scope.

export interface ScreentimeRoutesOptions {
  /** IANA time zone for periods, the heatmap and the default range (`TZ`). */
  timeZone: string;
  /** Clock for the default range and the average per day. Tests inject it. */
  now?: Clock;
}

export const screentimeRoutes: FastifyPluginCallback<ScreentimeRoutesOptions> = (
  app,
  { timeZone, now = systemClock },
  done,
) => {
  /**
   * The query's range, or the last 30 local days before `nowMs`. The schema
   * makes sure both or neither are set.
   */
  const rangeOf = (
    query: { from?: string | undefined; to?: string | undefined },
    nowMs: number,
  ): TimeRange =>
    query.from !== undefined && query.to !== undefined
      ? { from: query.from, to: query.to }
      : defaultRange(nowMs, timeZone);

  app.get('/accounts/:accountId/screentime', USER_ROUTE, (request): ScreentimeResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(screentimeQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    // One clock reading per request, so the default range and the stats agree.
    const nowMs = now().getTime();
    const range = rangeOf(query, nowMs);
    return {
      ...range,
      bucket: query.bucket,
      ...screentime(app.db, accountIds, range, query.bucket, timeZone, nowMs),
    };
  });

  app.get(
    '/accounts/:accountId/screentime/worlds',
    USER_ROUTE,
    (request): ScreentimeWorldsResponse => {
      const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
      const query = parseRequest(screentimeRangeQuerySchema, request.query, 'query');
      const accountIds = scopeIds(request, accountId);
      const range = rangeOf(query, now().getTime());
      return { ...range, ...screentimeWorlds(app.db, accountIds, range) };
    },
  );

  app.get(
    '/accounts/:accountId/screentime/heatmap',
    USER_ROUTE,
    (request): ScreentimeHeatmapResponse => {
      const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
      const query = parseRequest(screentimeRangeQuerySchema, request.query, 'query');
      const accountIds = scopeIds(request, accountId);
      const range = rangeOf(query, now().getTime());
      return { ...range, cells: screentimeHeatmap(app.db, accountIds, range, timeZone) };
    },
  );

  done();
};
