import { z } from 'zod';
import { accountTypeName, nonNegativeInt, positiveInt, utcTimestamp } from '../common.js';
import { accountId } from './common.js';

// `GET /api/v1/accounts` and `GET /api/v1/accounts/:accountId`.

export const accountSummarySchema = z.strictObject({
  id: accountId,
  /** Current display name. `null` until the first `session.start` (since 1.5.0). */
  displayName: z.string().min(1).nullable(),
  /** Current account type. `null` until the first `session.start` (since 1.5.0). */
  accountType: accountTypeName.nullable(),
  firstSeenAt: utcTimestamp,
  lastSeenAt: utcTimestamp,
  /** From the latest XP snapshot. `null` until the first snapshot. */
  totalLevel: positiveInt.nullable(),
  totalXp: nonNegativeInt.nullable(),
});

export const accountsResponseSchema = z.strictObject({
  accounts: z.array(accountSummarySchema),
});

export const accountNameSchema = z.strictObject({
  displayName: z.string().min(1),
  firstSeenAt: utcTimestamp,
  lastSeenAt: utcTimestamp,
});

export const accountDetailResponseSchema = accountSummarySchema.extend({
  /** Name history, oldest first. */
  names: z.array(accountNameSchema),
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type AccountsResponse = z.infer<typeof accountsResponseSchema>;
export type AccountName = z.infer<typeof accountNameSchema>;
export type AccountDetailResponse = z.infer<typeof accountDetailResponseSchema>;
