import { z } from 'zod';
import { accountTypeName, nonNegativeInt, positiveInt, utcTimestamp } from '../common.js';
import { SESSION_CLOSE_REASONS } from '../events.js';
import { accountId } from './common.js';

// `GET /api/v1/accounts` and `GET /api/v1/accounts/:accountId`.

/**
 * State of an account's newest session (by start time), as facts: the client
 * decides "online" from these and its own clock (docs/design.md, "Online").
 */
export const latestSessionSchema = z
  .strictObject({
    /** `null` while the session is open. */
    endedAt: utcTimestamp.nullable(),
    endReason: z.enum(SESSION_CLOSE_REASONS).nullable(),
  })
  .superRefine((session, ctx) => {
    if ((session.endedAt === null) !== (session.endReason === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'endedAt and endReason must both be set or both be null',
        path: ['endReason'],
      });
    }
  });

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
  /** The newest session's state. `null` without sessions (since 1.42.0). */
  latestSession: latestSessionSchema.nullable(),
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

export type LatestSession = z.infer<typeof latestSessionSchema>;
export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type AccountsResponse = z.infer<typeof accountsResponseSchema>;
export type AccountName = z.infer<typeof accountNameSchema>;
export type AccountDetailResponse = z.infer<typeof accountDetailResponseSchema>;
