# 0021. Prices from hourly volume-weighted averages

- **Date:** 2026-11-28
- **Status:** Accepted. Replaces the price rule and price history parts of
  [ADR 0019](0019-prices-fetched-on-demand.md); its on-demand triggers still hold.

## Context

Bank values and Price movers priced each item as the midpoint of the wiki's
`/latest` high and low: the single last insta-buy and insta-sell, with no age
or volume check (the same rule as RuneLite's own GE value). The 24 h, 7 d and
30 d baselines were single earlier fetches of the same kind. For an illiquid
item one side can be days old and then be replaced by one odd trade: an item
worth about 2.6K showed −95 % and +36,000 % moves. For an expensive item
each fetch's midpoint moves by millions on single trades, and as the
largest holding it can flip the sign of the total between two fetches.

The wiki's `/1h` endpoint gives, for every item in one request, the average
price and volume of each side in one hour, and any past hour can be asked
for by its `timestamp` (the start of the hour). Averages can have two
decimals and exceed 32 bits. A side without trades has a `null` average and
volume 0, and an item without trades in the hour is left out.

## Decision

- **Source:** only `/api/v2/osrs/1h?timestamp=<hour start>`, without `id`,
  through `server/src/external/client.ts` with the source's flag, User-Agent
  and 10 s spacing ([ADR 0014](0014-external-calls-through-one-module.md)).
  Never one request per item, never `/timeseries`, and `/latest` is no
  longer used. An hour is asked for 10 minutes after it ends
  (`PRICE_HOUR_SETTLE_MS`) and stored once (`server/src/prices/fetch.ts`). A
  response for another hour, with fewer than 100 items or in another shape
  stores nothing for that hour: the failure is counted against the hour
  (`price_hour_failures`) and the catch-up goes on with the next ones, so one
  bad hour never holds back newer hours. The hour is asked for again in later
  catch-ups and skipped after 3 failed ones: never asked for again, and
  missing in the windows. A network or HTTP error ends the catch-up and
  counts against no hour.
- **Storage:** per hour and item the value (average × volume, whole gp) and
  volume of each side (`price_hours`, the 48 hours up to the newest stored
  one), and the same sums per UTC day (`price_days`, 35 days, with the number
  of hours in each day in `price_day_hours`). Retention counts back from the
  newest stored hour, never from the clock.
- **Price rule** (`server/src/prices/rule.ts`): the volume-weighted average
  of all trades in the window, both sides together. A side without trades is
  not used, so a stale side goes away by itself. When both sides traded and
  one side's average is more than 2× the other's, only the side with more
  trades is used (the lower one on a tie).
- **Current price** (`server/src/prices/history.ts`): the 24 hours up to the
  newest stored hour. Without trades then: the last 7 UTC days, then the
  item's newest day with trades, then the snapshot price. Bank, summary, net
  worth, potion storage and Price movers all use it, so the movers' sum still
  explains the change in net worth.
- **Periods:** 24 h compares with the 24 hours before the current window; 7 d
  and 30 d with the UTC day whose middle is nearest to the window's middle
  that long before (the label ± 12 hours). A period is shown only when both
  windows have all 24 hours, and an item only when it traded in the current
  window and in the baseline. `baselineAt` is the end of the baseline window
  (contract 1.42.1, a doc-only patch).
- **Schedule** (`server/src/jobs/prices.ts`): a catch-up fetches every
  missing settled hour of the last 48, oldest first, at most 48, one request
  at a time. It starts when an hour is missing and prices are read or a
  session is open, and also when the newest stored hour is 24 hours behind
  (`PRICES_BACKGROUND_AFTER_MS`). That replaces ADR 0019's fetch every
  3 h 55 min. After a failed request, nothing for an hour; then a catch-up
  starts again also without reads or sessions, so a batch that stopped part
  of the way is finished an hour later, not a day later.

## Consequences

- One odd trade or a stale side no longer moves a price: the side with more
  trades decides, and an expensive liquid item moves by its real 24 h average
  between two fetches, not by the last two trades.
- Values can differ slightly from RuneLite's own GE value, which is still the
  `/latest` midpoint.
- Calls (about 278 KB each): about 24 a day with any use and also when idle, in
  one batch a day of about 4 minutes when nobody reads prices. ADR 0019 made
  about 6 when idle and at most 24. The first start after the upgrade, or a
  start after the server was off, makes up to 48 in one catch-up (about 8
  minutes at 10 s spacing).
- **Why a daily background catch-up (option B), not none (option A):**
  buckets can be fetched afterwards, so on-demand use alone always fills
  24 h. But a catch-up reaches back only 48 hours: after more than 48 hours
  without reads or sessions, the hours before that are never fetched, their
  UTC days are incomplete, and 7 d and 30 d are left out on the matching
  days 7 and 30 days later. With the daily catch-up no hour is lost while the
  server runs and the wiki answers, apart from an hour the wiki never gives
  a usable response for (skipped after 3 tries). Without it an idle server
  would make no calls at all.
- The migration drops `item_prices` and `item_price_history`. They are not
  derived from raw events ([ADR 0003](0003-raw-events-and-projections.md))
  and midpoints are not comparable with averages. 24 h returns after the first
  catch-up, and 7 d and 30 d after 7 and 30 days, as on a new instance. Like
  before, the stored hours and days cannot be rebuilt.
- While the first catch-up after the upgrade (or after a pause) runs, hours
  are stored oldest first, so for those few minutes the current price comes
  from the oldest hours fetched so far, while `fetchedAt` is the time of the
  latest request. It is right again once the catch-up is done.
- Thresholds (2× between sides) are constants in `rule.ts`. The low-volume
  marker for items with few trades is a separate contract change.
