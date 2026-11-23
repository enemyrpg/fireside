import { eventSchema, type Event } from '@fireside/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Db, Queryable } from '../db/index.js';
import { events, type EventRow } from '../db/schema.js';
import { formatIssues } from '../ingest/validate.js';

// Turns raw rows in `events` into derived tables. See
// docs/architecture.md#raw-events-and-projections.
//
// Raw events are committed first (`storeEvents`). Projection runs afterwards in
// its own transaction, with a savepoint per event: a failing event rolls back
// only its own derived changes, gets `projection_error` set, and the rest
// carries on. A projection error never loses or rejects a raw event.
//
// Order rule: `apply` must give the same derived state for the same *set* of
// raw events, whatever order they arrive in. Use one of two styles:
// - keyed insert: one derived row per event, keyed by its event ID;
// - refresh from raw: recompute the affected key (an account, a session) from
//   `events`, ordered by `(occurred_at, event_id)`.
// Never use `received_at` or what was projected before as the source of truth.

/**
 * An event as projected: the contract's event plus its owner, from
 * `events.user_id`. The account is (owner, account hash), never the hash alone.
 */
export type StoredEvent = Event & { readonly userId: number };

/** One event type with its owner, for helpers that take a narrowed event. */
export type Stored<E extends Event> = E & { readonly userId: number };

/** Passed to `apply` along with each event. */
export interface ProjectionContext {
  /**
   * When the event is projected. Only for rules that depend on the clock
   * (session timeout); never stored as the event's time.
   */
  readonly now: Date;
}

/** One derived view of the raw events, e.g. accounts or XP snapshots. */
export interface Projection {
  /** Short name, used in `projection_error`, logs and `projection_versions`. */
  readonly name: string;
  /**
   * Version of the rules `apply` derives rows with (default 1). Bump it when a
   * change gives existing events other derived rows: databases built with an
   * older version are then recomputed at startup (projections/versions.ts).
   */
  readonly version?: number;
  /**
   * Brings derived rows built with an older `version` up to date, inside the
   * startup transaction. Without it, an outdated projection is brought up to
   * date by a full rebuild.
   */
  recompute?(tx: Queryable, context: ProjectionContext): RecomputeResult;
  /** Updates derived tables for one event. The raw row is already stored. */
  apply(tx: Queryable, event: StoredEvent, context: ProjectionContext): void;
  /**
   * Clears derived state before a rebuild, which then replays every event.
   * Called in reverse registry order, so later projections can depend on
   * earlier ones' rows.
   */
  reset(tx: Queryable): void;
  /**
   * The derived tables as plain, sorted data without surrogate IDs, so two
   * databases built in different orders can be compared.
   */
  snapshot(db: Queryable): unknown;
}

/** What `Projection.recompute` did. */
export interface RecomputeResult {
  /** SQL names of every table it may have changed (check-migration allows only these). */
  tables: readonly string[];
  /** Counts for the log, e.g. `{ sessions: 950 }`. */
  counts: Record<string, number>;
}

/** The part of a pino/Fastify logger the projections use. */
export interface ProjectionLogger {
  warn(obj: object, msg: string): void;
}

export interface ProjectionOptions {
  /** Usually `PROJECTIONS` (projections/index.ts). Tests pass their own. */
  projections: readonly Projection[];
  now?: Clock;
  log?: ProjectionLogger;
}

export interface ProjectionFailure {
  eventId: string;
  error: string;
}

export interface ProjectionResult {
  /** Events projected without errors. */
  processed: number;
  failed: ProjectionFailure[];
}

/** Events loaded and projected per query/transaction. */
const CHUNK_SIZE = 500;

/** Longest error message stored in `projection_error`. */
const MAX_ERROR_LENGTH = 1000;

/** Raised inside the savepoint so the failing step is named in the error. */
class ProjectionError extends Error {
  override name = 'ProjectionError';
  constructor(step: string, cause: unknown) {
    super(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function emptyResult(): ProjectionResult {
  return { processed: 0, failed: [] };
}

function addResult(total: ProjectionResult, part: ProjectionResult): void {
  total.processed += part.processed;
  total.failed.push(...part.failed);
}

/** Order used everywhere: `occurredAt`, then `eventId` to break ties. */
export function compareEventRows(
  a: Pick<EventRow, 'occurredAt' | 'eventId'>,
  b: Pick<EventRow, 'occurredAt' | 'eventId'>,
): number {
  // Timestamps are fixed-format UTC, so string order is time order.
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

/** Rebuilds the typed event and its owner from the stored row. Throws if it no longer validates. */
export function parseStoredEvent(row: EventRow): StoredEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new ProjectionError('parse', 'payload is not valid JSON');
  }
  const result = eventSchema.safeParse({
    eventId: row.eventId,
    schemaVersion: row.schemaVersion,
    type: row.type,
    accountHash: row.accountHash,
    occurredAt: row.occurredAt,
    sessionId: row.sessionId,
    payload,
  });
  if (!result.success) throw new ProjectionError('parse', formatIssues(result.error.issues));
  return { ...result.data, userId: row.userId };
}

/**
 * The same options with the clock read once, so a run split into chunks
 * (rebuild, pending, failed) uses one `now` throughout.
 */
function withFixedClock(options: ProjectionOptions): ProjectionOptions {
  const at = (options.now ?? systemClock)();
  return { ...options, now: () => at };
}

/** Projects `rows` in the given order, one savepoint per event. */
function projectRows(
  tx: Queryable,
  rows: readonly EventRow[],
  { projections, now = systemClock, log }: ProjectionOptions,
): ProjectionResult {
  const result = emptyResult();
  const context: ProjectionContext = { now: now() };
  const processedAt = context.now.toISOString();

  for (const row of rows) {
    try {
      tx.transaction((savepoint) => {
        const event = parseStoredEvent(row);
        for (const projection of projections) {
          try {
            projection.apply(savepoint, event, context);
          } catch (error) {
            throw new ProjectionError(projection.name, error);
          }
        }
        savepoint
          .update(events)
          .set({ processedAt, projectionError: null })
          .where(eq(events.eventId, row.eventId))
          .run();
      });
      result.processed += 1;
    } catch (error) {
      // The savepoint is rolled back; keep the raw event and record why.
      const message = (error instanceof Error ? error.message : String(error)).slice(
        0,
        MAX_ERROR_LENGTH,
      );
      tx.update(events)
        .set({ processedAt: null, projectionError: message })
        .where(eq(events.eventId, row.eventId))
        .run();
      result.failed.push({ eventId: row.eventId, error: message });
      // IDs and the message only: payloads hold display names.
      log?.warn(
        { eventId: row.eventId, type: row.type, error: message },
        'Projection failed, raw event kept',
      );
    }
  }
  return result;
}

/**
 * Projects stored events by ID (as stored, lower case). Events already
 * processed are skipped, so a resent or repeated ID is never applied twice.
 * Runs in one transaction; events are applied in `(occurredAt, eventId)` order.
 */
export function projectEvents(
  db: Db,
  eventIds: readonly string[],
  options: ProjectionOptions,
): ProjectionResult {
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return emptyResult();

  return db.transaction(
    (tx) => {
      const rows: EventRow[] = [];
      for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
        const chunk = ids.slice(start, start + CHUNK_SIZE);
        rows.push(
          ...tx
            .select()
            .from(events)
            .where(and(inArray(events.eventId, chunk), isNull(events.processedAt)))
            .all(),
        );
      }
      rows.sort(compareEventRows);
      return projectRows(tx, rows, options);
    },
    { behavior: 'immediate' },
  );
}

/**
 * Projects every event that was stored but never projected, e.g. after a
 * crash between storing and projecting. Failed events are left alone (see
 * `reprocessFailed`). Run at startup.
 */
export function projectPending(db: Db, options: ProjectionOptions): ProjectionResult {
  options = withFixedClock(options);
  const total = emptyResult();
  for (;;) {
    // Each round either processes or fails every row it loads, so this ends.
    const ids = db
      .select({ eventId: events.eventId })
      .from(events)
      .where(and(isNull(events.processedAt), isNull(events.projectionError)))
      .orderBy(asc(events.occurredAt), asc(events.eventId))
      .limit(CHUNK_SIZE)
      .all()
      .map((row) => row.eventId);
    if (ids.length === 0) return total;
    addResult(total, projectEvents(db, ids, options));
  }
}

/** Events whose projection failed, oldest first. */
export function failedEvents(db: Queryable): { eventId: string; type: string; error: string }[] {
  return db
    .select({ eventId: events.eventId, type: events.type, error: events.projectionError })
    .from(events)
    .where(isNotNull(events.projectionError))
    .orderBy(asc(events.occurredAt), asc(events.eventId))
    .all()
    .map((row) => ({ ...row, error: row.error ?? '' }));
}

/** Tries failed events again, e.g. after a fix. Events that fail again keep their error. */
export function reprocessFailed(db: Db, options: ProjectionOptions): ProjectionResult {
  options = withFixedClock(options);
  const ids = failedEvents(db).map((row) => row.eventId);
  const total = emptyResult();
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    addResult(total, projectEvents(db, ids.slice(start, start + CHUNK_SIZE), options));
  }
  return total;
}

/**
 * Clears the derived tables and replays every raw event in `(occurredAt,
 * eventId)` order, in one transaction. Readers see the old state until it
 * commits. Gives the same result as projecting the events as they arrived.
 */
export function rebuildProjections(db: Db, options: ProjectionOptions): ProjectionResult {
  return db.transaction((tx) => rebuildProjectionsIn(tx, options), { behavior: 'immediate' });
}

/** `rebuildProjections` inside a transaction the caller holds. */
export function rebuildProjectionsIn(tx: Queryable, options: ProjectionOptions): ProjectionResult {
  options = withFixedClock(options);
  for (const projection of [...options.projections].reverse()) projection.reset(tx);
  tx.update(events).set({ processedAt: null, projectionError: null }).run();

  const total = emptyResult();
  let after: Pick<EventRow, 'occurredAt' | 'eventId'> | undefined;
  for (;;) {
    const rows = tx
      .select()
      .from(events)
      .where(
        after &&
          or(
            gt(events.occurredAt, after.occurredAt),
            and(eq(events.occurredAt, after.occurredAt), gt(events.eventId, after.eventId)),
          ),
      )
      .orderBy(asc(events.occurredAt), asc(events.eventId))
      .limit(CHUNK_SIZE)
      .all();
    if (rows.length === 0) return total;
    addResult(total, projectRows(tx, rows, options));
    after = rows[rows.length - 1];
  }
}
