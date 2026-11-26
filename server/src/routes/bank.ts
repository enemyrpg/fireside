import {
  accountScopeParamsSchema,
  bankHistoryQuerySchema,
  bankQuerySchema,
  type BankHistoryResponse,
  type BankResponse,
  type BankSummaryResponse,
  type PotionStorageResponse,
  type PriceMoversResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import {
  bank,
  bankHistory,
  bankSummary,
  defaultHistoryRange,
  potionStorage,
} from '../read/bank.js';
import { priceMovers } from '../read/price-movers.js';
import { currentPrices } from '../read/prices.js';
import { scopeIds } from './account-scope.js';
import { parseRequest } from './parse.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';

// `GET /accounts/:accountId/bank`, `/bank/history`, `/bank/summary`,
// `/bank/price-movers` and `/potion-storage`. Registered in the dashboard scope. All accept `all`.

export interface BankRoutesOptions {
  /** IANA time zone for history days and the default range (`TZ`). */
  timeZone: string;
  /** Clock for the default range and the end of the history. Tests inject it. */
  now?: Clock;
  /**
   * Value the latest snapshots at current GE prices (`PRICES_ENABLED` and
   * `USER_AGENT_CONTACT`). Off: the snapshot's own prices.
   */
  currentPrices?: boolean;
  /**
   * Called before the latest snapshots are valued at current prices, so the
   * price job can start a fetch when they are old (jobs/prices.ts). The
   * answer never waits for it: it has the stored prices.
   */
  onPricesRead?: () => void;
}

export const bankRoutes: FastifyPluginCallback<BankRoutesOptions> = (
  app,
  { timeZone, now = systemClock, currentPrices: useCurrent = false, onPricesRead },
  done,
) => {
  /** The stored prices for this read. The history uses snapshot prices and never asks. */
  const prices = () => {
    if (useCurrent) onPricesRead?.();
    return currentPrices(app.db, useCurrent);
  };

  /** Account IDs for the request; rejects unknown query parameters. */
  const accountsOf = (request: FastifyRequest): number[] => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    parseRequest(bankQuerySchema, request.query, 'query');
    return scopeIds(request, accountId);
  };

  app.get('/accounts/:accountId/bank', USER_ROUTE, (request): BankResponse =>
    bank(app.db, accountsOf(request), prices()),
  );

  app.get('/accounts/:accountId/bank/summary', USER_ROUTE, (request): BankSummaryResponse =>
    bankSummary(app.db, accountsOf(request), prices()),
  );

  // Price movers. Empty when prices are off: the same lookup as the three above.
  app.get('/accounts/:accountId/bank/price-movers', USER_ROUTE, (request): PriceMoversResponse =>
    priceMovers(app.db, accountsOf(request), prices()),
  );

  app.get('/accounts/:accountId/potion-storage', USER_ROUTE, (request): PotionStorageResponse =>
    potionStorage(app.db, accountsOf(request), prices()),
  );

  app.get('/accounts/:accountId/bank/history', USER_ROUTE, (request): BankHistoryResponse => {
    const { accountId } = parseRequest(accountScopeParamsSchema, request.params, 'params');
    const query = parseRequest(bankHistoryQuerySchema, request.query, 'query');
    const accountIds = scopeIds(request, accountId);
    // One clock reading per request, so the default range and the end agree.
    const nowMs = now().getTime();
    const range =
      query.from !== undefined && query.to !== undefined
        ? { from: query.from, to: query.to }
        : defaultHistoryRange(nowMs, timeZone);
    return { ...range, days: bankHistory(app.db, accountIds, range, timeZone, nowMs) };
  });

  done();
};
