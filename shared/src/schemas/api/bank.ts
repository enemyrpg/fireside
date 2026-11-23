import { z } from 'zod';
import {
  addCapped,
  BANK_TAB_COUNT,
  compareBankTabs,
  comparePriceMovers,
  itemValue,
  MAX_ITEM_DOSES,
  potionValue,
  priceMoverChange,
  sumPriceChanges,
} from '../../game/bank.js';
import { nonNegativeInt, positiveInt, upperName, utcTimestamp } from '../common.js';
import { accountId, checkBoundedRange, localDateSchema, timeRangeFields } from './common.js';

// The rules of price movers live in `game/bank.ts`, without Zod, so the
// dashboard can use them too. Exported here as well for existing imports.
export { comparePriceMovers, priceMoverChange, sumPriceChanges };

// Bank and potion storage (since 1.19.0). All endpoints accept `all`. `bank`
// and `potion-storage` list one entry per account (the game order and tabs are
// per account, so items are never merged) plus summed totals. Values are
// quantity × price per item, capped at 2^53 − 1, and sums are capped the same
// way.

type Issues = z.core.ParsePayload['issues'];

function issue(issues: Issues, input: unknown, path: PropertyKey[], message: string) {
  issues.push({ code: 'custom', message, input, path });
}

/** Capped sum of `key` over `rows`. */
function sumOf<K extends string>(rows: readonly Record<K, number>[], key: K): number {
  return rows.reduce((sum, row) => addCapped(sum, row[key]), 0);
}

/** Adds an issue unless `object[key]` is the capped sum of `rows[key]`. */
function checkSum<K extends string>(
  issues: Issues,
  object: Record<K, number>,
  rows: readonly Record<K, number>[],
  key: K,
  path: PropertyKey[],
) {
  if (object[key] !== sumOf(rows, key)) {
    issue(issues, object, [...path, key], `${key} must be the sum of the rows`);
  }
}

/** Adds an issue unless the entries are sorted by `accountId` without duplicates. */
function checkAccountOrder(issues: Issues, rows: readonly { accountId: number }[], key: string) {
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (previous && previous.accountId >= row.accountId) {
      issue(
        issues,
        row,
        [key, index, 'accountId'],
        'Must be sorted by accountId without duplicates',
      );
    }
  });
}

/**
 * Where a GE price comes from (since 1.24.0): `SNAPSHOT` is the price the
 * plugin sent with the snapshot, `CURRENT` the latest price the server fetched
 * from the OSRS Wiki (`PRICES_ENABLED`).
 */
export const BANK_PRICE_SOURCES = ['SNAPSHOT', 'CURRENT'] as const;
export const bankPriceSourceSchema = z.enum(BANK_PRICE_SOURCES);

/**
 * Which GE prices a response uses (since 1.24.0). With `CURRENT`, each item
 * with a fetched price uses it and the rest keep their snapshot price (see
 * `gePriceSource` per item); `fetchedAt` is when those prices were fetched.
 * With `SNAPSHOT`, every price is from the snapshot and `fetchedAt` is `null`.
 * HA prices and `cashValue` are always from the snapshot.
 */
export const bankPricesSchema = z
  .strictObject({
    source: bankPriceSourceSchema,
    fetchedAt: utcTimestamp.nullable(),
  })
  .refine((prices) => (prices.source === 'CURRENT') === (prices.fetchedAt !== null), {
    message: 'fetchedAt is set exactly when the source is CURRENT',
    path: ['fetchedAt'],
  });

/** Adds an issue for every row with a current price in a response that uses snapshot prices. */
function checkPriceSources(
  issues: Issues,
  prices: { source: string },
  rows: readonly { gePriceSource: string }[],
  path: PropertyKey[],
) {
  if (prices.source !== 'SNAPSHOT') return;
  rows.forEach((row, index) => {
    if (row.gePriceSource !== 'SNAPSHOT') {
      issue(
        issues,
        row,
        [...path, index, 'gePriceSource'],
        'Must be SNAPSHOT when the response uses snapshot prices',
      );
    }
  });
}

const priceAndValueFields = {
  /** The GE price used for `geValue`: see `gePriceSource`. */
  gePriceEach: nonNegativeInt,
  /** Since 1.24.0. */
  gePriceSource: bankPriceSourceSchema,
  haPriceEach: nonNegativeInt,
  /** `quantity × gePriceEach`, capped. */
  geValue: nonNegativeInt,
  /** `quantity × haPriceEach`, capped. */
  haValue: nonNegativeInt,
};

/** Refinement for rows with `quantity`, prices and values. */
function valuesMatch(row: {
  quantity: number;
  gePriceEach: number;
  haPriceEach: number;
  geValue: number;
  haValue: number;
}): boolean {
  return (
    row.geValue === itemValue(row.quantity, row.gePriceEach) &&
    row.haValue === itemValue(row.quantity, row.haPriceEach)
  );
}

const valuesMessage = { message: 'geValue/haValue must be quantity × price (capped)' };

// --- Queries ----------------------------------------------------------------

/** `…/bank`, `…/bank/summary` and `…/potion-storage` take no query parameters. */
export const bankQuerySchema = z.strictObject({});

/**
 * `…/bank/history?from=&to=`: both or neither, `[from, to)`, at most
 * `MAX_RANGE_DAYS`. Without them: a rolling year up to the next local midnight.
 */
export const bankHistoryQuerySchema = z
  .strictObject(timeRangeFields)
  .superRefine(checkBoundedRange);

// --- Bank -------------------------------------------------------------------

const bankTab = z.int().min(0).max(BANK_TAB_COUNT);

/** One bank slot, in game order. A placeholder has quantity 0 and value 0. */
export const bankItemResponseSchema = z
  .strictObject({
    /** Index in the bank container, 0, 1, … */
    position: nonNegativeInt,
    /** 1–9, or 0 for the main tab. */
    tab: bankTab,
    itemId: nonNegativeInt,
    name: z.string().min(1),
    quantity: nonNegativeInt,
    placeholder: z.boolean(),
    ...priceAndValueFields,
  })
  .refine(valuesMatch, valuesMessage)
  .refine((item) => item.placeholder === (item.quantity === 0), {
    message: 'Placeholders have quantity 0, other items at least 1',
    path: ['quantity'],
  });

/** One bank tab: tabs 1–9 with items, then the main tab (0), which is always listed. */
export const bankTabSchema = z.strictObject({
  tab: bankTab,
  /** Slots in the tab, placeholders included. */
  itemCount: nonNegativeInt,
  geValue: nonNegativeInt,
  haValue: nonNegativeInt,
});

/** One inventory slot or worn item. `slot` is set for equipment only. */
export const containerItemResponseSchema = z
  .strictObject({
    position: nonNegativeInt,
    /** `EquipmentInventorySlot` name for equipment, `null` for inventory. */
    slot: upperName.nullable(),
    itemId: nonNegativeInt,
    name: z.string().min(1),
    quantity: positiveInt,
    ...priceAndValueFields,
  })
  .refine(valuesMatch, valuesMessage);

/** Inventory or equipment with its total value. */
export const containerResponseSchema = z
  .strictObject({
    geValue: nonNegativeInt,
    haValue: nonNegativeInt,
    items: z.array(containerItemResponseSchema),
  })
  .check((ctx) => {
    checkSum(ctx.issues, ctx.value, ctx.value.items, 'geValue', []);
    checkSum(ctx.issues, ctx.value, ctx.value.items, 'haValue', []);
  });

export const bankTotalsSchema = z.strictObject({
  /** GE value of the bank items. */
  geValue: nonNegativeInt,
  /** HA value of the bank items. */
  haValue: nonNegativeInt,
  /** Coins + platinum tokens × 1 000 in the bank and the inventory. */
  cashValue: nonNegativeInt,
});

/** One account's latest bank snapshot. */
export const accountBankSchema = z
  .strictObject({
    accountId,
    takenAt: utcTimestamp,
    totals: bankTotalsSchema,
    tabs: z.array(bankTabSchema),
    items: z.array(bankItemResponseSchema),
    inventory: containerResponseSchema,
    equipment: containerResponseSchema,
  })
  .check((ctx) => {
    const { tabs, items, totals } = ctx.value;
    tabs.forEach((tab, index) => {
      const previous = tabs[index - 1];
      if (previous && compareBankTabs(previous.tab, tab.tab) >= 0) {
        issue(ctx.issues, tab, ['tabs', index, 'tab'], 'Tabs must be 1–9, then 0, once each');
      }
      if (tab.tab !== 0 && tab.itemCount === 0) {
        issue(ctx.issues, tab, ['tabs', index, 'itemCount'], 'Tabs 1–9 are listed only with items');
      }
    });
    if (tabs.at(-1)?.tab !== 0) {
      issue(ctx.issues, tabs, ['tabs'], 'The main tab (0) is always listed, last');
    }
    // Items are in container order, grouped by tab in the order of `tabs`.
    const expected = tabs.flatMap((tab) => Array<number>(tab.itemCount).fill(tab.tab));
    if (expected.length !== items.length) {
      issue(ctx.issues, items, ['items'], 'Tab item counts must add up to the items');
    }
    items.forEach((item, index) => {
      if (item.position !== index) {
        issue(ctx.issues, item, ['items', index, 'position'], 'Positions must be 0, 1, …');
      }
      if (item.tab !== expected[index]) {
        issue(
          ctx.issues,
          item,
          ['items', index, 'tab'],
          'Item is not in the tab its position gives',
        );
      }
    });
    tabs.forEach((tab, index) => {
      const rows = items.filter((item) => item.tab === tab.tab);
      checkSum(ctx.issues, tab, rows, 'geValue', ['tabs', index]);
      checkSum(ctx.issues, tab, rows, 'haValue', ['tabs', index]);
    });
    checkSum(ctx.issues, totals, items, 'geValue', ['totals']);
    checkSum(ctx.issues, totals, items, 'haValue', ['totals']);
  });

/**
 * `GET …/bank`: the latest snapshot per account with one (sorted by
 * `accountId`; empty without data) and `totals` summed over them.
 */
export const bankResponseSchema = z
  .strictObject({
    banks: z.array(accountBankSchema),
    totals: bankTotalsSchema,
    /** Since 1.24.0. */
    prices: bankPricesSchema,
  })
  .check((ctx) => {
    const { banks, totals, prices } = ctx.value;
    checkAccountOrder(ctx.issues, banks, 'banks');
    banks.forEach((bank, index) => {
      checkPriceSources(ctx.issues, prices, bank.items, ['banks', index, 'items']);
      for (const key of ['inventory', 'equipment'] as const) {
        checkPriceSources(ctx.issues, prices, bank[key].items, ['banks', index, key, 'items']);
      }
    });
    const rows = banks.map((bank) => bank.totals);
    for (const key of ['geValue', 'haValue', 'cashValue'] as const) {
      checkSum(ctx.issues, totals, rows, key, ['totals']);
    }
  });

// --- Potion storage -----------------------------------------------------------

/** One potion type. Value is ⌊price × doses ÷ itemDoses⌋ (prices are for the full item). */
export const potionResponseSchema = z
  .strictObject({
    position: nonNegativeInt,
    itemId: nonNegativeInt,
    name: z.string().min(1),
    doses: positiveInt,
    itemDoses: z.int().min(1).max(MAX_ITEM_DOSES),
    /** Price of the full item `itemId` (`itemDoses` doses): see `gePriceSource`. */
    gePriceEach: nonNegativeInt,
    /** Since 1.24.0. */
    gePriceSource: bankPriceSourceSchema,
    haPriceEach: nonNegativeInt,
    geValue: nonNegativeInt,
    haValue: nonNegativeInt,
  })
  .refine(
    (potion) =>
      potion.geValue === potionValue(potion.gePriceEach, potion.doses, potion.itemDoses) &&
      potion.haValue === potionValue(potion.haPriceEach, potion.doses, potion.itemDoses),
    { message: 'geValue/haValue must be ⌊price × doses ÷ itemDoses⌋ (capped)' },
  );

export const potionStorageTotalsSchema = z.strictObject({
  geValue: nonNegativeInt,
  haValue: nonNegativeInt,
});

/** One account's latest potion storage snapshot. */
export const accountPotionStorageSchema = z
  .strictObject({
    accountId,
    takenAt: utcTimestamp,
    totals: potionStorageTotalsSchema,
    potions: z.array(potionResponseSchema),
  })
  .check((ctx) => {
    const { potions, totals } = ctx.value;
    potions.forEach((potion, index) => {
      if (potion.position !== index) {
        issue(ctx.issues, potion, ['potions', index, 'position'], 'Positions must be 0, 1, …');
      }
    });
    checkSum(ctx.issues, totals, potions, 'geValue', ['totals']);
    checkSum(ctx.issues, totals, potions, 'haValue', ['totals']);
  });

/** `GET …/potion-storage`: like `bank`, one entry per account with a snapshot. */
export const potionStorageResponseSchema = z
  .strictObject({
    storages: z.array(accountPotionStorageSchema),
    totals: potionStorageTotalsSchema,
    /** Since 1.24.0. */
    prices: bankPricesSchema,
  })
  .check((ctx) => {
    const { storages, totals, prices } = ctx.value;
    checkAccountOrder(ctx.issues, storages, 'storages');
    storages.forEach((storage, index) => {
      checkPriceSources(ctx.issues, prices, storage.potions, ['storages', index, 'potions']);
    });
    const rows = storages.map((storage) => storage.totals);
    checkSum(ctx.issues, totals, rows, 'geValue', ['totals']);
    checkSum(ctx.issues, totals, rows, 'haValue', ['totals']);
  });

// --- Summary and history ------------------------------------------------------

/** GE value parts of the net worth. `geValue` is their capped sum. */
const netWorthFields = {
  /** Bank + potion storage + inventory + equipment (GE). */
  geValue: nonNegativeInt,
  bankGeValue: nonNegativeInt,
  potionStorageGeValue: nonNegativeInt,
  inventoryGeValue: nonNegativeInt,
  equipmentGeValue: nonNegativeInt,
  /** Coins + platinum tokens × 1 000 in the bank and the inventory. */
  cashValue: nonNegativeInt,
};

type NetWorth = Record<keyof typeof netWorthFields, number>;

function netWorthSum(value: NetWorth): number {
  return [
    value.bankGeValue,
    value.potionStorageGeValue,
    value.inventoryGeValue,
    value.equipmentGeValue,
  ].reduce(addCapped, 0);
}

const netWorthMessage = {
  message: 'geValue must be bank + potion storage + inventory + equipment',
  path: ['geValue'],
};

/**
 * `GET …/bank/summary`: the net-worth card. From each
 * account's latest bank and potion storage snapshot, summed for `all`, at the
 * prices in `prices` (the same values as `bank` and `potion-storage`).
 * `updatedAt` is the newest of those snapshots, `null` (with zeros) without data.
 */
export const bankSummaryResponseSchema = z
  .strictObject({
    ...netWorthFields,
    updatedAt: utcTimestamp.nullable(),
    /** Since 1.24.0. */
    prices: bankPricesSchema,
  })
  .refine((summary) => summary.geValue === netWorthSum(summary), netWorthMessage)
  .refine(
    (summary) =>
      summary.updatedAt !== null ||
      (Object.keys(netWorthFields) as (keyof NetWorth)[]).every((key) => summary[key] === 0),
    { message: 'Values must be 0 without data (updatedAt null)', path: ['updatedAt'] },
  );

/**
 * One local day: each account's last snapshot taken before the end of the day,
 * carried forward over days without one, summed for `all`. Bank (with
 * inventory and equipment) and potion storage are carried forward separately.
 */
export const bankHistoryDaySchema = z
  .strictObject({
    /** Local date in `TZ`. */
    date: localDateSchema,
    /** Start of the day in UTC. */
    start: utcTimestamp,
    ...netWorthFields,
    bankHaValue: nonNegativeInt,
    potionStorageHaValue: nonNegativeInt,
    /** Since 1.20.0, so the net worth can be shown in HA too. */
    inventoryHaValue: nonNegativeInt,
    equipmentHaValue: nonNegativeInt,
  })
  .refine((day) => day.geValue === netWorthSum(day), netWorthMessage);

/**
 * `GET …/bank/history`. Days before the first snapshot of any account in scope
 * are left out; after that every day is listed, oldest first.
 */
export const bankHistoryResponseSchema = z
  .strictObject({
    from: utcTimestamp,
    to: utcTimestamp,
    days: z.array(bankHistoryDaySchema),
  })
  .check((ctx) => {
    const { from, to, days } = ctx.value;
    if (from >= to) issue(ctx.issues, to, ['to'], 'to must be after from');
    days.forEach((day, index) => {
      const previous = days[index - 1];
      if (previous && previous.date >= day.date) {
        issue(ctx.issues, day, ['days', index, 'date'], 'Days must be sorted without duplicates');
      }
    });
  });

// --- Price movers (since 1.40.0) --------------------------------------------------

/**
 * Periods of `…/bank/price-movers`, shortest first. A period compares the
 * current price with the stored fetch nearest to that long ago.
 */
export const PRICE_MOVER_PERIODS = ['24h', '7d', '30d'] as const;
export const priceMoverPeriodSchema = z.enum(PRICE_MOVER_PERIODS);

const safeInt = z.int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

const priceMoverFields = {
  itemId: nonNegativeInt,
  name: z.string().min(1),
  /** The current GE price of the full item: the one `bank` uses. */
  priceEach: positiveInt,
  /** The price at the period's `baselineAt`, by the same rule. */
  previousPriceEach: positiveInt,
  /** Value now minus value then, for the amount held now. Never 0. */
  change: safeInt,
};

/**
 * One item with a price change. `ITEM`: `quantity` is everything held in bank,
 * inventory and equipment (all accounts in scope). `POTION`: doses in potion
 * storage, valued per dose like `potion-storage`.
 */
export const priceMoverItemSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('ITEM'), ...priceMoverFields, quantity: positiveInt }),
    z.strictObject({
      kind: z.literal('POTION'),
      ...priceMoverFields,
      doses: positiveInt,
      itemDoses: z.int().min(1).max(MAX_ITEM_DOSES),
    }),
  ])
  .refine((item) => item.change !== 0 && item.change === priceMoverChange(item), {
    message: 'change must be the value now minus the value then, and never 0',
    path: ['change'],
  });

/** One period: every held item whose price moved, largest gain first. */
export const priceMoverPeriodResultSchema = z
  .strictObject({
    period: priceMoverPeriodSchema,
    /** When the prices compared against were fetched. */
    baselineAt: utcTimestamp,
    /** Sum of the items' `change`. */
    change: safeInt,
    items: z.array(priceMoverItemSchema),
  })
  .superRefine((result, ctx) => {
    if (result.change !== sumPriceChanges(result.items)) {
      ctx.addIssue({
        code: 'custom',
        message: 'change must be the sum of the items',
        path: ['change'],
      });
    }
    const seen = new Set<string>();
    result.items.forEach((item, index) => {
      const key = `${item.kind}:${String(item.itemId)}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'An item is listed once per kind',
          path: ['items', index, 'itemId'],
        });
      }
      seen.add(key);
      const previous = result.items[index - 1];
      if (previous && comparePriceMovers(previous, item) > 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'Must be sorted by change (largest first), then item ID, then kind',
          path: ['items', index, 'change'],
        });
      }
    });
  });

/**
 * `GET …/bank/price-movers` (since 1.40.0): how GE price changes moved the
 * value of what the accounts in scope hold now (bank, inventory, equipment and
 * potion storage; buying and selling are not part of it). Only periods with
 * stored prices from about that long ago are listed, shortest first; none when
 * the response uses snapshot prices (the price source is off or has never been
 * fetched). Items without a current price or a price from then, coins and
 * platinum tokens are left out.
 */
export const priceMoversResponseSchema = z
  .strictObject({
    prices: bankPricesSchema,
    periods: z.array(priceMoverPeriodResultSchema),
  })
  .superRefine((response, ctx) => {
    if (response.prices.source === 'SNAPSHOT' && response.periods.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'No periods when the response uses snapshot prices',
        path: ['periods'],
      });
    }
    response.periods.forEach((result, index) => {
      const previous = response.periods[index - 1];
      if (
        previous &&
        PRICE_MOVER_PERIODS.indexOf(previous.period) >= PRICE_MOVER_PERIODS.indexOf(result.period)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Periods are listed once each, shortest first',
          path: ['periods', index, 'period'],
        });
      }
      if (response.prices.fetchedAt !== null && result.baselineAt >= response.prices.fetchedAt) {
        ctx.addIssue({
          code: 'custom',
          message: 'baselineAt must be before the current prices were fetched',
          path: ['periods', index, 'baselineAt'],
        });
      }
    });
  });

// --- Types ------------------------------------------------------------------

export type BankPriceSource = z.infer<typeof bankPriceSourceSchema>;
export type BankPrices = z.infer<typeof bankPricesSchema>;
export type BankHistoryQuery = z.infer<typeof bankHistoryQuerySchema>;
export type BankItemResponse = z.infer<typeof bankItemResponseSchema>;
export type BankTab = z.infer<typeof bankTabSchema>;
export type ContainerItemResponse = z.infer<typeof containerItemResponseSchema>;
export type ContainerResponse = z.infer<typeof containerResponseSchema>;
export type BankTotals = z.infer<typeof bankTotalsSchema>;
export type AccountBank = z.infer<typeof accountBankSchema>;
export type BankResponse = z.infer<typeof bankResponseSchema>;
export type PotionResponse = z.infer<typeof potionResponseSchema>;
export type AccountPotionStorage = z.infer<typeof accountPotionStorageSchema>;
export type PotionStorageResponse = z.infer<typeof potionStorageResponseSchema>;
export type BankSummaryResponse = z.infer<typeof bankSummaryResponseSchema>;
export type BankHistoryDay = z.infer<typeof bankHistoryDaySchema>;
export type BankHistoryResponse = z.infer<typeof bankHistoryResponseSchema>;
export type PriceMoverPeriod = z.infer<typeof priceMoverPeriodSchema>;
export type PriceMoverItem = z.infer<typeof priceMoverItemSchema>;
export type PriceMoverPeriodResult = z.infer<typeof priceMoverPeriodResultSchema>;
export type PriceMoversResponse = z.infer<typeof priceMoversResponseSchema>;
