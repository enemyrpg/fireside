import {
  accountScopeParamsSchema,
  dropsQuerySchema,
  lootQuerySchema,
  type DropsResponse,
  type KcResponse,
  type LootResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { kcGainWindowStart, latestKc } from '../read/kc.js';
import { drops, lootByDay, lootBySource } from '../read/loot.js';
import { scopeIds } from './account-scope.js';
import { noQuerySchema, parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// `GET /accounts/:accountId/loot`, `/loot/drops` and `/kc`. Registered in the
// dashboard scope.

export interface LootKcRoutesOptions {
  /** IANA time zone for `groupBy=day` and the KC window (`TZ`). */
  timeZone: string;
  /** Clock for the KC window. Tests inject it. */
  now?: Clock;
}

export const lootKcRoutes: FastifyPluginCallback<LootKcRoutesOptions> = (
  app,
  { timeZone, now = systemClock },
  done,
) => {
  app.get('/accounts/:accountId/loot', USER_ROUTE, (request): LootResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(lootQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    const filter = { accountIds, from: query.from, to: query.to };
    const range = { from: query.from ?? null, to: query.to ?? null };
    return query.groupBy === 'day'
      ? { groupBy: 'day', ...range, ...lootByDay(app.db, filter, timeZone) }
      : { groupBy: 'source', ...range, ...lootBySource(app.db, filter) };
  });

  app.get('/accounts/:accountId/loot/drops', USER_ROUTE, (request): DropsResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(dropsQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    return drops(app.db, { accountIds, ...query });
  });

  app.get('/accounts/:accountId/kc', USER_ROUTE, (request): KcResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    parseRequest(noQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    const windowStart = new Date(kcGainWindowStart(now().getTime(), timeZone)).toISOString();
    return { bosses: latestKc(app.db, accountIds, windowStart) };
  });

  done();
};
