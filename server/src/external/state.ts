import type {
  ExternalSourceId,
  ExternalSourcesResponse,
  ExternalSourceStatus,
} from '@fireside/shared';
import { EXTERNAL_SOURCE_IDS } from '@fireside/shared';
import { eq } from 'drizzle-orm';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Config } from '../config.js';
import type { Queryable } from '../db/index.js';
import { externalSources } from '../db/schema.js';
import { EXTERNAL_SOURCES, isSourceActive } from './sources.js';

// `external_sources`: when each source was last called and how it went. Kept
// in the database so the schedule holds across restarts, and so Settings →
// Server can show it.

export type ExternalSourceRow = typeof externalSources.$inferSelect;

export function sourceState(db: Queryable, source: ExternalSourceId): ExternalSourceRow | null {
  return db.select().from(externalSources).where(eq(externalSources.source, source)).get() ?? null;
}

function upsert(
  db: Queryable,
  source: ExternalSourceId,
  values: Partial<Omit<ExternalSourceRow, 'source'>>,
): void {
  db.insert(externalSources)
    .values({ source, ...values })
    .onConflictDoUpdate({ target: externalSources.source, set: values })
    .run();
}

/** Stored before the request is made, so a crash mid-call still counts. */
export function recordAttempt(db: Queryable, source: ExternalSourceId, at: Date): void {
  upsert(db, source, { lastAttemptAt: at.toISOString() });
}

export function recordSuccess(db: Queryable, source: ExternalSourceId, at: Date): void {
  upsert(db, source, { lastSuccessAt: at.toISOString(), lastError: null, lastErrorAt: null });
}

/** `message` must be safe to show: a status or error code, never a header or body. */
export function recordFailure(
  db: Queryable,
  source: ExternalSourceId,
  at: Date,
  message: string,
): void {
  upsert(db, source, { lastError: message, lastErrorAt: at.toISOString() });
}

/**
 * Earliest time of the next call for a source called at most every
 * `intervalMs`: now if it has never been tried, or if the last attempt is in
 * the future (the clock was changed).
 */
export function nextAttemptAt(
  row: ExternalSourceRow | null,
  intervalMs: number,
  nowMs: number,
): number {
  if (!row?.lastAttemptAt) return nowMs;
  const last = Date.parse(row.lastAttemptAt);
  if (Number.isNaN(last) || last > nowMs) return nowMs;
  return Math.max(nowMs, last + intervalMs);
}

/** `GET /admin/external-sources`. `intervals` gives each source's schedule. */
export function externalSourcesStatus(
  db: Queryable,
  config: Config,
  intervals: Record<ExternalSourceId, number>,
  now: Clock = systemClock,
): ExternalSourcesResponse {
  const nowMs = now().getTime();
  const sources = EXTERNAL_SOURCE_IDS.map((id): ExternalSourceStatus => {
    const source = EXTERNAL_SOURCES[id];
    const row = sourceState(db, id);
    const active = isSourceActive(config, id);
    return {
      id,
      name: source.name,
      envName: source.envName,
      enabled: source.enabled(config),
      active,
      lastFetchAt: row?.lastSuccessAt ?? null,
      nextFetchAt: active ? new Date(nextAttemptAt(row, intervals[id], nowMs)).toISOString() : null,
      lastError:
        row?.lastError && row.lastErrorAt ? { at: row.lastErrorAt, message: row.lastError } : null,
    };
  });
  return { contactSet: config.userAgentContact !== null, sources };
}
