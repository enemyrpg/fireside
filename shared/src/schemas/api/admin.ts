import { z } from 'zod';
import { nonNegativeInt, utcTimestamp } from '../common.js';

// Admin endpoints of the dashboard.

/** `POST /api/v1/admin/rebuild` */
export const rebuildResponseSchema = z.strictObject({
  /** Events projected without errors. */
  processed: nonNegativeInt,
  /** Events whose projection failed. Their raw rows are kept. */
  failed: nonNegativeInt,
  /** How long the rebuild took, in whole milliseconds. */
  durationMs: nonNegativeInt,
});

export type RebuildResponse = z.infer<typeof rebuildResponseSchema>;

/** The newest backup in `BACKUP_DIR`. */
export const backupFileSchema = z.strictObject({
  /** File name only (never the folder, which differs in Docker). */
  fileName: z.string().min(1),
  /** When the backup was taken (read from the file name), UTC. */
  createdAt: utcTimestamp,
  sizeBytes: nonNegativeInt,
});

/** The latest backup attempt failed. Cleared by the next successful backup. */
export const backupErrorSchema = z.strictObject({
  at: utcTimestamp,
  message: z.string().min(1),
});

/** `GET /api/v1/admin/backups` (contract 1.16.0) */
export const backupStatusResponseSchema = z.strictObject({
  /** Automatic daily backups are on (`BACKUP_ENABLED`). Manual backups always work. */
  enabled: z.boolean(),
  /** `null` when there are no backups yet. */
  latest: backupFileSchema.nullable(),
  /** Backups kept in `BACKUP_DIR` (copies made before a restore are not counted). */
  count: nonNegativeInt,
  /** Total size of those backups. */
  totalSizeBytes: nonNegativeInt,
  /** Next scheduled backup, UTC. `null` when automatic backups are off. */
  nextRunAt: utcTimestamp.nullable(),
  /** Set when the server's latest backup attempt failed. */
  lastError: backupErrorSchema.nullable(),
});

// --- External sources (contract 1.24.0) -----------------------------

/**
 * Every external service the server can call. All are optional and off by
 * default. `RUNEPROFILE` since 1.25.0.
 */
export const EXTERNAL_SOURCE_IDS = ['WIKI_PRICES', 'RUNEPROFILE'] as const;
export const externalSourceIdSchema = z.enum(EXTERNAL_SOURCE_IDS);

/** The latest call failed. Cleared by the next successful one. */
export const externalSourceErrorSchema = z.strictObject({
  at: utcTimestamp,
  /** A status or error code. Never headers, URLs with a query, or response bodies. */
  message: z.string().min(1),
});

export const externalSourceSchema = z
  .strictObject({
    id: externalSourceIdSchema,
    /** Display name, e.g. `OSRS Wiki Prices`. */
    name: z.string().min(1),
    /** The `.env` variable that turns the source on, e.g. `PRICES_ENABLED`. */
    envName: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    /** That variable is `true`. */
    enabled: z.boolean(),
    /** `enabled` and `USER_AGENT_CONTACT` is set. Only then is the source called. */
    active: z.boolean(),
    /** The latest successful fetch. `null` if there has been none. */
    lastFetchAt: utcTimestamp.nullable(),
    /**
     * Earliest time of the next fetch, not a promise that one happens then
     * (Settings shows it as "Earliest next fetch"). `null` when the source is
     * not active. For `WIKI_PRICES` it is an hour after the latest attempt:
     * after a failure, nothing is fetched sooner. A missing hour of trades is
     * fetched once it has settled and bank data is read or a session is open;
     * with neither, once a day of hours is missing, so an idle server may
     * fetch nothing for about a day after this time (since 1.42.1).
     * For `RUNEPROFILE` it is six hours after the latest call: an account can
     * be synced sooner (after a session, or with "Sync now").
     */
    nextFetchAt: utcTimestamp.nullable(),
    lastError: externalSourceErrorSchema.nullable(),
  })
  .refine((source) => source.enabled || !source.active, {
    message: 'A source is only active when it is enabled',
    path: ['active'],
  })
  .refine((source) => source.active === (source.nextFetchAt !== null), {
    message: 'nextFetchAt is set exactly when the source is active',
    path: ['nextFetchAt'],
  });

/**
 * `GET /api/v1/admin/external-sources` (contract 1.24.0). The contact itself
 * is never returned.
 */
export const externalSourcesResponseSchema = z
  .strictObject({
    /** `USER_AGENT_CONTACT` is set. Without it no source is ever called. */
    contactSet: z.boolean(),
    /** One entry per source in `EXTERNAL_SOURCE_IDS`, in that order. */
    sources: z.array(externalSourceSchema),
  })
  .refine(
    ({ sources }) =>
      sources.length === EXTERNAL_SOURCE_IDS.length &&
      sources.every((source, index) => source.id === EXTERNAL_SOURCE_IDS[index]),
    { message: 'Every source must be listed once, in order', path: ['sources'] },
  )
  .refine(({ contactSet, sources }) => contactSet || sources.every((source) => !source.active), {
    message: 'No source is active without a contact',
    path: ['sources'],
  });

export type ExternalSourceId = z.infer<typeof externalSourceIdSchema>;
export type ExternalSourceStatus = z.infer<typeof externalSourceSchema>;
export type ExternalSourcesResponse = z.infer<typeof externalSourcesResponseSchema>;
export type BackupFile = z.infer<typeof backupFileSchema>;
export type BackupStatusResponse = z.infer<typeof backupStatusResponseSchema>;
