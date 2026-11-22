import { z } from 'zod';
import { nonNegativeInt, positiveInt, utcTimestamp } from '../common.js';
import { accountId } from './common.js';

// `GET /api/v1/accounts/:accountId/kc`: latest KC per boss.

/** One account's latest KC for a boss (since 1.7.0). */
export const accountKcSchema = z.strictObject({
  accountId,
  killCount: positiveInt,
});

export const BOSS_CATEGORIES = ['boss', 'raid'] as const;

/** Fastest time for one team size (since 1.9.0). */
export const teamSizeTimeSchema = z.strictObject({
  /** Players in the raid or group, yourself included. */
  teamSize: z.int().min(1).max(100),
  seconds: z.number().positive(),
});

export const bossKcSchema = z
  .strictObject({
    /** Normalized boss name. Unknown bosses keep the name from the plugin. */
    boss: z.string().min(1),
    /** Latest KC, summed over the accounts for `all`. */
    killCount: positiveInt,
    lastObservedAt: utcTimestamp,
    /**
     * Fastest recorded kill time or reported personal best (`kc.personalBestSeconds`,
     * since 1.14.0). `null` if neither has been seen.
     */
    bestTimeSeconds: z.number().positive().nullable(),
    /**
     * KC gained from local midnight 29 days ago (`TZ`) until now, with the same
     * rule as KC in a session. Never negative. Since 1.7.0.
     */
    gainedLast30Days: nonNegativeInt,
    /**
     * Latest KC per account that has seen the boss, sorted by `accountId`. One
     * entry for a single account. Since 1.7.0.
     */
    byAccount: z.array(accountKcSchema).min(1),
    /** `raid` for a raid mode in `RAIDS` (shared/src/game/raids.ts). Since 1.9.0. */
    category: z.enum(BOSS_CATEGORIES),
    /** The raid a mode belongs to (e.g. "Chambers of Xeric"), `null` for bosses. Since 1.9.0. */
    raid: z.string().min(1).nullable(),
    /**
     * Fastest time per team size (any account), sorted by `teamSize`: kill
     * times and, since 1.14.0, reported personal bests. Only sizes with a
     * recorded time; empty if none. Since 1.9.0.
     */
    bestTimesByTeamSize: z.array(teamSizeTimeSchema),
  })
  .superRefine((kc, ctx) => {
    if ((kc.category === 'raid') !== (kc.raid !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'raid must be set exactly when category is raid',
        path: ['raid'],
      });
    }
    kc.bestTimesByTeamSize.forEach((time, index) => {
      const previous = kc.bestTimesByTeamSize[index - 1];
      if (previous && previous.teamSize >= time.teamSize) {
        ctx.addIssue({
          code: 'custom',
          message: 'bestTimesByTeamSize must be sorted by teamSize without duplicates',
          path: ['bestTimesByTeamSize', index, 'teamSize'],
        });
      }
    });
    const sum = kc.byAccount.reduce((total, account) => total + account.killCount, 0);
    if (sum !== kc.killCount) {
      ctx.addIssue({
        code: 'custom',
        message: 'killCount must equal the sum of byAccount',
        path: ['killCount'],
      });
    }
    kc.byAccount.forEach((account, index) => {
      const previous = kc.byAccount[index - 1];
      if (previous && previous.accountId >= account.accountId) {
        ctx.addIssue({
          code: 'custom',
          message: 'byAccount must be sorted by accountId without duplicates',
          path: ['byAccount', index, 'accountId'],
        });
      }
    });
  });

export const kcResponseSchema = z.strictObject({
  bosses: z.array(bossKcSchema),
});

export type AccountKc = z.infer<typeof accountKcSchema>;
export type BossCategory = (typeof BOSS_CATEGORIES)[number];
export type TeamSizeTime = z.infer<typeof teamSizeTimeSchema>;
export type BossKc = z.infer<typeof bossKcSchema>;
export type KcResponse = z.infer<typeof kcResponseSchema>;
