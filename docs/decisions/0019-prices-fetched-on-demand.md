# 0019. Wiki prices fetched only when needed

- **Date:** 2026-11-26
- **Status:** Accepted. The price rule, the price history and the 3 h 55 min
  fetch are replaced by [ADR 0021](0021-prices-from-hourly-volume-weighted-averages.md);
  fetching on reads and while a session is open still holds.

## Context

With `PRICES_ENABLED` on, the server fetched `/latest` from the OSRS Wiki
every hour, 24 calls a day, also when nobody played or opened the dashboard.
Current prices are only needed when bank data is read or an account plays.
Price movers, though, compare with earlier fetches
(`server/src/prices/history.ts`). The 24 h period needs a stored fetch within
2 hours of exactly a day before the current one. 7 d and 30 d use the first
fetch of each UTC day. Fetches only on demand would leave gaps: in a
simulation of 45 days, one dashboard visit a day at a random time showed
24 h on 10 % of the visits and 7 d / 30 d on 80 %.

## Decision

- `server/src/jobs/prices.ts` fetches when bank data is read (bank, summary,
  price movers, potion storage) or a session of any account is open, if the
  last attempt is at least an hour old. The read answers at once with the
  stored prices. The fetch runs in the background.
- It also fetches whenever the last attempt is 3 h 55 min old
  (`PRICES_HISTORY_INTERVAL_MS`), or an hour old when that attempt failed, so
  one error does not leave almost 8 hours between two stored fetches. The job checks once a minute, so two
  fetches are less than 4 hours apart, and a fetch is always within the 2
  hours the 24 h period allows. With 6 h, 24 h showed on only 80 % of the
  visits in the simulation.
- With fetches at uneven times, the first fetch of a UTC day can land
  anywhere from midnight to almost 4 hours after it, so two of them can be up
  to about 28 hours apart. 7 d and 30 d therefore allow 26 hours before the
  target, not 22 (`PRICE_MOVER_WINDOWS`). With the 2 hours after it, there is
  always one in reach.
- Unchanged: one fetch at a time, at most one attempt an hour, failed ones
  included, the stored last attempt, and every call through
  `server/src/external/client.ts` ([ADR 0014](0014-external-calls-through-one-module.md)).
  `nextFetchAt` stays the earliest time a fetch is allowed.

## Consequences

- About 6 calls a day on an idle server (24 h ÷ 3 h 55 min), at most 24.
  Simulated use made 6–8.
- In the simulation, all three periods showed at every hour from day 32 on
  (`server/src/prices/history.test.ts`). A period is still left out after a
  failed fetch or while the server was off. It is never compared with a fetch
  out of reach.
- A "7 d" or "30 d" baseline can be up to 26 hours older than its label (it
  was 22 hours), and never more than 2 hours newer.
- A read after a pause answers with the old prices, with their time. The
  bank queries never poll, so when the answer's current prices are over an
  hour old the dashboard asks the bank-price queries of that account again
  once, a few seconds later (`useRefreshStalePrices` in `web/src/api/hooks.ts`):
  then they all show the new prices. At most once per account and price fetch
  per page visit, never in a loop, and never with snapshot prices. If the
  fetch failed or was slow, the old prices stay until the next visit.
