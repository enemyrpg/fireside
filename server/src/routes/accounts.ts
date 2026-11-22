import {
  accountParamsSchema,
  accountScopeParamsSchema,
  gainsQuerySchema,
  periodAt,
  xpQuerySchema,
  type AccountDetailResponse,
  type AccountsResponse,
  type GainsResponse,
  type XpResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { ApiError } from '../errors.js';
import { accountDetail, listAccounts } from '../read/accounts.js';
import { accountSeries, firstSnapshotAt, snapshotPairs, sumGains, xpPoints } from '../read/xp.js';
import { accountNotFound, requestUser, scopeIds } from './account-scope.js';
import { noQuerySchema, parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// `GET /accounts`, `/accounts/:accountId`, `/accounts/:accountId/xp` and
// `/accounts/:accountId/gains`. Registered in the dashboard scope.

export interface AccountRoutesOptions {
  /** IANA time zone for days, weeks and months (`TZ`). */
  timeZone: string;
  /** Clock for the current period and the default end of a series. Tests inject it. */
  now?: Clock;
}

const iso = (ms: number) => new Date(ms).toISOString();

export const accountRoutes: FastifyPluginCallback<AccountRoutesOptions> = (
  app,
  { timeZone, now = systemClock },
  done,
) => {
  app.get('/accounts', USER_ROUTE, (request): AccountsResponse => {
    parseRequest(noQuerySchema, request.query, 'query');
    return { accounts: listAccounts(app.db, requestUser(request).id) };
  });

  app.get('/accounts/:accountId', USER_ROUTE, (request): AccountDetailResponse => {
    const { accountId } = parseRequest(accountParamsSchema, request.params, 'params');
    parseRequest(noQuerySchema, request.query, 'query');
    const detail = accountDetail(app.db, requestUser(request).id, accountId);
    if (!detail) throw accountNotFound();
    return detail;
  });

  app.get('/accounts/:accountId/gains', USER_ROUTE, (request): GainsResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(gainsQuerySchema, request.query, 'query');
    if ((query.from === undefined) !== (query.to === undefined)) {
      const missing = query.from === undefined ? 'from' : 'to';
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
        { path: `query.${missing}`, message: 'from and to must be given together' },
      ]);
    }
    const ids = scopeIds(request, accountId);

    let from: string;
    let to: string;
    if (query.from !== undefined && query.to !== undefined) {
      ({ from, to } = query);
    } else {
      const period = periodAt(now().getTime(), query.period, timeZone);
      from = iso(period.start);
      to = iso(period.end);
    }
    return { from, to, ...sumGains(snapshotPairs(app.db, ids, from, to)) };
  });

  app.get('/accounts/:accountId/xp', USER_ROUTE, (request): XpResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(xpQuerySchema, request.query, 'query');
    const ids = scopeIds(request, accountId);
    const response: XpResponse = { skill: query.skill ?? null, bucket: query.bucket, points: [] };

    // No future buckets: the series ends now at the latest.
    const nowMs = now().getTime();
    const to = Math.min(query.to === undefined ? nowMs : Date.parse(query.to), nowMs);
    // Never before the first snapshot: earlier buckets are empty, and an early
    // `from` (year 1000) would otherwise make hundreds of thousands of them.
    const first = firstSnapshotAt(app.db, ids);
    if (first === undefined) return response;
    const from = Math.max(Date.parse(first), query.from === undefined ? 0 : Date.parse(query.from));
    if (from >= to) return response;

    const series = accountSeries(app.db, ids, query.skill, iso(from), iso(to));
    response.points = xpPoints(series, from, to, query.bucket, timeZone);
    return response;
  });

  done();
};
