import { z } from 'zod';
import { nonNegativeInt, positiveInt, utcTimestamp, uuidV7 } from '../common.js';
import {
  accountId,
  apiLootSourceSchema,
  localDateSchema,
  nonNegativeIntQuery,
  paginated,
  paginationQueryFields,
  refineTimeRange,
  timeRangeFields,
} from './common.js';

// `GET /api/v1/accounts/:accountId/loot` and `/loot/drops`.
// Values are GE/HA prices at drop time, in coins.

export const LOOT_GROUP_BY = ['source', 'day'] as const;

/** `…/loot?from=&to=&groupBy=`. Without `from`/`to`: all time. */
export const lootQuerySchema = refineTimeRange(
  z.strictObject({
    ...timeRangeFields,
    groupBy: z.enum(LOOT_GROUP_BY).default('source'),
  }),
);

const lootValueFields = {
  /** Number of loot events. */
  lootCount: nonNegativeInt,
  geValue: nonNegativeInt,
  haValue: nonNegativeInt,
};

export const lootTotalsSchema = z.strictObject(lootValueFields);

/** One item summed over all loot events in a group. */
export const lootItemTotalSchema = z.strictObject({
  itemId: nonNegativeInt,
  name: z.string().min(1),
  quantity: positiveInt,
  geValue: nonNegativeInt,
  haValue: nonNegativeInt,
});

export const lootSourceGroupSchema = z.strictObject({
  source: apiLootSourceSchema,
  ...lootValueFields,
  items: z.array(lootItemTotalSchema),
});

export const lootDayGroupSchema = z.strictObject({
  /** Local date. */
  date: localDateSchema,
  ...lootValueFields,
});

const lootRangeFields = {
  /** Resolved range in UTC. `null` means unbounded (all time). */
  from: utcTimestamp.nullable(),
  to: utcTimestamp.nullable(),
  totals: lootTotalsSchema,
};

export const lootResponseSchema = refineTimeRange(
  z.discriminatedUnion('groupBy', [
    z.strictObject({
      groupBy: z.literal('source'),
      ...lootRangeFields,
      groups: z.array(lootSourceGroupSchema),
    }),
    z.strictObject({
      groupBy: z.literal('day'),
      ...lootRangeFields,
      groups: z.array(lootDayGroupSchema),
    }),
  ]),
);

/** `…/loot/drops?minValue=&from=&to=&cursor=&limit=`. `minValue` applies to `geValue`. */
export const dropsQuerySchema = refineTimeRange(
  z.strictObject({
    minValue: nonNegativeIntQuery.optional(),
    ...timeRangeFields,
    ...paginationQueryFields,
  }),
);

/** One item line from one loot event. Newest first. */
export const dropSchema = z
  .strictObject({
    lootEventId: positiveInt,
    accountId,
    sessionId: uuidV7,
    occurredAt: utcTimestamp,
    source: apiLootSourceSchema,
    itemId: nonNegativeInt,
    name: z.string().min(1),
    quantity: positiveInt,
    gePriceEach: nonNegativeInt,
    haPriceEach: nonNegativeInt,
    /** `quantity * gePriceEach`. */
    geValue: nonNegativeInt,
    /** `quantity * haPriceEach`. */
    haValue: nonNegativeInt,
  })
  .refine((drop) => drop.geValue === drop.quantity * drop.gePriceEach, {
    message: 'geValue must equal quantity * gePriceEach',
    path: ['geValue'],
  })
  .refine((drop) => drop.haValue === drop.quantity * drop.haPriceEach, {
    message: 'haValue must equal quantity * haPriceEach',
    path: ['haValue'],
  });

export const dropsResponseSchema = paginated(dropSchema);

export type LootGroupBy = (typeof LOOT_GROUP_BY)[number];
export type LootQuery = z.infer<typeof lootQuerySchema>;
export type LootTotals = z.infer<typeof lootTotalsSchema>;
export type LootItemTotal = z.infer<typeof lootItemTotalSchema>;
export type LootSourceGroup = z.infer<typeof lootSourceGroupSchema>;
export type LootDayGroup = z.infer<typeof lootDayGroupSchema>;
export type LootResponse = z.infer<typeof lootResponseSchema>;
export type DropsQuery = z.infer<typeof dropsQuerySchema>;
export type Drop = z.infer<typeof dropSchema>;
export type DropsResponse = z.infer<typeof dropsResponseSchema>;
