import { z } from 'zod';
import { nonNegativeInt, positiveInt, skillName, utcTimestamp, uuidV7 } from '../common.js';
import { SESSION_CLOSE_REASONS } from '../events.js';
import {
  accountId,
  activeAfkSum,
  apiLootSourceSchema,
  checkBoundedRange,
  intFromString,
  localDateSchema,
  MAX_RANGE_DAYS,
  paginated,
  paginationQueryFields,
  playtimeFields,
  refineTimeRange,
  timeRangeFields,
} from './common.js';

// `GET /api/v1/accounts/:accountId/sessions`, `GET /api/v1/sessions/:sessionId`
// and `GET /api/v1/accounts/:accountId/calendar`.

/** `…/sessions?from=&to=&cursor=&limit=`. Newest first. */
export const sessionsQuerySchema = refineTimeRange(
  z.strictObject({
    ...timeRangeFields,
    ...paginationQueryFields,
  }),
);

export const sessionParamsSchema = z.strictObject({ sessionId: uuidV7 });

/** From `session_summaries`. Keys are skill names and normalized boss names. */
export const sessionSummarySchema = z.strictObject({
  xpGainedTotal: nonNegativeInt,
  xpGainedBySkill: z.record(skillName, nonNegativeInt),
  lootGeValue: nonNegativeInt,
  lootCount: nonNegativeInt,
  kcGainedByBoss: z.record(z.string().min(1), nonNegativeInt),
});

export const sessionSchema = z
  .strictObject({
    id: uuidV7,
    accountId,
    startedAt: utcTimestamp,
    /** `null` while the session is ongoing. */
    endedAt: utcTimestamp.nullable(),
    endReason: z.enum(SESSION_CLOSE_REASONS).nullable(),
    /**
     * World at session start, else from the first heartbeat. `null` if neither
     * has arrived (since 1.6.0).
     */
    world: positiveInt.nullable(),
    durationSeconds: nonNegativeInt,
    activeSeconds: nonNegativeInt,
    afkSeconds: nonNegativeInt,
    /** `null` until the summary is built (when the session closes). */
    summary: sessionSummarySchema.nullable(),
    /**
     * New collection log items tied to the session (since 1.39.0). Not from
     * events, so not in `summary`; open sessions have it too.
     */
    newCollectionLogCount: nonNegativeInt,
  })
  .superRefine((session, ctx) => {
    if ((session.endedAt === null) !== (session.endReason === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'endedAt and endReason must both be set or both be null',
        path: ['endReason'],
      });
    }
    if (session.endedAt !== null && session.endedAt < session.startedAt) {
      ctx.addIssue({
        code: 'custom',
        message: 'endedAt must not be before startedAt',
        path: ['endedAt'],
      });
    }
  })
  .refine(...activeAfkSum('durationSeconds'));

export const sessionsResponseSchema = paginated(sessionSchema);

// --- Session detail ---------------------------------------------------------

export const sessionXpSchema = z
  .strictObject({
    skill: skillName,
    xpGained: nonNegativeInt,
    startLevel: positiveInt,
    endLevel: positiveInt,
  })
  .refine((xp) => xp.endLevel >= xp.startLevel, {
    message: 'endLevel must not be below startLevel',
    path: ['endLevel'],
  });

export const sessionLootItemSchema = z.strictObject({
  itemId: nonNegativeInt,
  name: z.string().min(1),
  quantity: positiveInt,
  gePriceEach: nonNegativeInt,
  haPriceEach: nonNegativeInt,
});

export const sessionLootSchema = z.strictObject({
  id: positiveInt,
  occurredAt: utcTimestamp,
  source: apiLootSourceSchema,
  killCount: positiveInt.nullable(),
  geValue: nonNegativeInt,
  haValue: nonNegativeInt,
  items: z.array(sessionLootItemSchema).min(1),
});

/**
 * KC gained in the session: highest KC in the session minus `startKillCount`.
 * `startKillCount` is the last KC before the session or, for a boss never seen
 * before, the first KC seen in the session (that first observation counts as 0).
 */
export const sessionKcSchema = z
  .strictObject({
    boss: z.string().min(1),
    startKillCount: positiveInt,
    endKillCount: positiveInt,
    gained: nonNegativeInt,
  })
  .refine((kc) => kc.gained === kc.endKillCount - kc.startKillCount, {
    message: 'gained must equal endKillCount - startKillCount',
    path: ['gained'],
  });

export const afkPeriodSchema = z
  .strictObject({
    startedAt: utcTimestamp,
    endedAt: utcTimestamp,
  })
  .refine((period) => period.endedAt >= period.startedAt, {
    message: 'endedAt must not be before startedAt',
    path: ['endedAt'],
  });

/**
 * The sessions just before and after this one for the same account, in list
 * order (`started_at`, then `id`). `null` at either end. Since 1.10.0.
 */
export const sessionNeighborsSchema = z.strictObject({
  olderId: uuidV7.nullable(),
  newerId: uuidV7.nullable(),
});

/** A new collection log item tied to the session (since 1.39.0). */
export const sessionClogItemSchema = z
  .strictObject({
    itemId: positiveInt,
    name: z.string().min(1),
    /** The tab and first page in the game's order that have the item. */
    tab: z.string().min(1),
    page: z.string().min(1),
    /** Unique items obtained on `page` and its size, in the latest collection log. */
    pageObtained: nonNegativeInt,
    pageTotal: positiveInt,
    /**
     * When the item was obtained: the activity feed's time, or with
     * `approximate` the time of the sync after the session that first saw it.
     */
    at: utcTimestamp,
    approximate: z.boolean(),
  })
  .refine((item) => item.pageObtained <= item.pageTotal, {
    message: 'pageObtained must not exceed pageTotal',
    path: ['pageObtained'],
  });

/** New collection log items in the session (since 1.39.0). */
export const sessionCollectionLogSchema = z
  .strictObject({
    /**
     * Unique items obtained and in total in the account's latest collection
     * log. Both `null` when no collection log is stored for the account.
     */
    obtained: nonNegativeInt.nullable(),
    total: nonNegativeInt.nullable(),
    /** Oldest first. */
    items: z.array(sessionClogItemSchema),
  })
  .superRefine((clog, ctx) => {
    if ((clog.obtained === null) !== (clog.total === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'obtained and total must both be set or both be null',
        path: ['total'],
      });
    }
    if (clog.obtained !== null && clog.total !== null && clog.obtained > clog.total) {
      ctx.addIssue({
        code: 'custom',
        message: 'obtained must not exceed total',
        path: ['obtained'],
      });
    }
    if (clog.obtained === null && clog.items.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'items need a stored collection log',
        path: ['items'],
      });
    }
    const seen = new Set<number>();
    clog.items.forEach((item, index) => {
      if (seen.has(item.itemId)) {
        ctx.addIssue({ code: 'custom', message: 'Each item once', path: ['items', index] });
      }
      seen.add(item.itemId);
      const previous = clog.items[index - 1];
      if (previous && previous.at > item.at) {
        ctx.addIssue({
          code: 'custom',
          message: 'Items must be oldest first',
          path: ['items', index, 'at'],
        });
      }
    });
  });

export const sessionDetailResponseSchema = z
  .strictObject({
    session: sessionSchema,
    neighbors: sessionNeighborsSchema,
    xp: z.array(sessionXpSchema),
    /** Oldest first. */
    loot: z.array(sessionLootSchema),
    kc: z.array(sessionKcSchema),
    afkPeriods: z.array(afkPeriodSchema),
    /** Since 1.39.0. */
    collectionLog: sessionCollectionLogSchema,
  })
  .refine((detail) => detail.collectionLog.items.length === detail.session.newCollectionLogCount, {
    message: 'collectionLog.items must have newCollectionLogCount items',
    path: ['collectionLog', 'items'],
  });

// --- Calendar ---------------------------------------------------------------

/** @deprecated Since 1.8.0: use `MAX_RANGE_DAYS` (shared with screen time). */
export const MAX_CALENDAR_RANGE_DAYS = MAX_RANGE_DAYS;

const calendarYear = z.int().min(2000).max(9999);

/**
 * `…/calendar?year=` or `…/calendar?from=&to=` (since 1.7.0), not both.
 * `from`/`to` must be given together, `[from, to)`, at most `MAX_RANGE_DAYS`.
 * Without parameters: the current local year.
 */
export const calendarQuerySchema = z
  .strictObject({
    year: intFromString(calendarYear).optional(),
    ...timeRangeFields,
  })
  .superRefine((query, ctx) => {
    if (query.year !== undefined && (query.from !== undefined || query.to !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'year cannot be combined with from/to',
        path: ['year'],
      });
      return;
    }
    checkBoundedRange(query, ctx);
  });

export const calendarDaySchema = z
  .strictObject({
    /** Local date. */
    date: localDateSchema,
    ...playtimeFields,
    sessionCount: nonNegativeInt,
  })
  .refine(...activeAfkSum('playedSeconds'));

/**
 * Only days with play time are listed. `from`/`to` is the range used (for
 * `year`: the local year in UTC). `year` is `null` for a `from`/`to` query.
 * Both since 1.7.0.
 */
export const calendarResponseSchema = refineTimeRange(
  z.strictObject({
    year: calendarYear.nullable(),
    from: utcTimestamp,
    to: utcTimestamp,
    days: z.array(calendarDaySchema),
  }),
).superRefine((calendar, ctx) => {
  if (calendar.year === null) return;
  calendar.days.forEach((day, index) => {
    if (!day.date.startsWith(`${String(calendar.year)}-`)) {
      ctx.addIssue({
        code: 'custom',
        message: 'date must be in year',
        path: ['days', index, 'date'],
      });
    }
  });
});

export type SessionsQuery = z.infer<typeof sessionsQuerySchema>;
export type SessionParams = z.infer<typeof sessionParamsSchema>;
export type SessionCloseReason = (typeof SESSION_CLOSE_REASONS)[number];
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
export type SessionXp = z.infer<typeof sessionXpSchema>;
export type SessionLootItem = z.infer<typeof sessionLootItemSchema>;
export type SessionLoot = z.infer<typeof sessionLootSchema>;
export type SessionKc = z.infer<typeof sessionKcSchema>;
export type AfkPeriod = z.infer<typeof afkPeriodSchema>;
export type SessionNeighbors = z.infer<typeof sessionNeighborsSchema>;
export type SessionClogItem = z.infer<typeof sessionClogItemSchema>;
export type SessionCollectionLog = z.infer<typeof sessionCollectionLogSchema>;
export type SessionDetailResponse = z.infer<typeof sessionDetailResponseSchema>;
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;
export type CalendarDay = z.infer<typeof calendarDaySchema>;
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;
