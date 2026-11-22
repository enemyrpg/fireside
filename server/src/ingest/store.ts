import type { IngestResponse } from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { events } from '../db/schema.js';
import type { ValidEvent } from './validate.js';

/**
 * Why an event that uses another user's `sessionId` is rejected. Neutral on
 * purpose: it must not tell the sender that the session exists.
 */
export const SESSION_NOT_ALLOWED = 'sessionId: not allowed';

export interface StoreContext {
  /** The owner of the key; every stored event belongs to this user. */
  userId: number;
  apiKeyId: number;
  /** ISO 8601 UTC, the same for every event in the batch. */
  receivedAt: string;
}

export interface StoreResult {
  /** Newly stored event IDs as sent, in batch order. */
  accepted: string[];
  /**
   * IDs already stored before, or earlier in the same batch. An ID another
   * user stored counts too: nothing is stored or changed for it, and the
   * answer is the same as for an own resend.
   */
  duplicates: string[];
  /** Of `duplicates`, how many another user had stored. For the log only. */
  foreignDuplicates: number;
  /** Events that use another user's session. Nothing is stored for them. */
  rejected: IngestResponse['rejected'];
  /** The newly stored IDs as stored (lower case), for the projections. */
  storedIds: string[];
}

/**
 * Stores valid events in `events`, unchanged and owned by `userId`, in one
 * transaction: if any insert fails, nothing from the batch is stored.
 * Idempotent on `eventId`: existing IDs and repeats within the batch are
 * duplicates, and the first occurrence in a batch wins. The write lock is
 * taken up front, so a concurrent request can't slip in between the lookup
 * and the insert (`ON CONFLICT DO NOTHING` stays as a second guard).
 *
 * IDs are stored in lower case, since the schema accepts either case and the
 * same UUID must never be stored twice. The response lists IDs as sent, so
 * the plugin can match them against its queue.
 *
 * `eventId` and `sessionId` are global (they come from the plugin), so:
 * 1. an ID that is already stored is a duplicate, whoever stored it;
 * 2. otherwise, an event whose session already has events of another user is
 *    rejected with `SESSION_NOT_ALLOWED`.
 * Earlier events in the batch are already inserted when later ones are
 * checked, and `BEGIN IMMEDIATE` keeps two batches from racing.
 */
export function storeEvents(
  db: Db,
  validEvents: readonly ValidEvent[],
  { userId, apiKeyId, receivedAt }: StoreContext,
): StoreResult {
  const accepted: string[] = [];
  const duplicates: string[] = [];
  const rejected: StoreResult['rejected'] = [];
  const storedIds: string[] = [];
  let foreignDuplicates = 0;

  db.transaction(
    (tx) => {
      for (const { index, event, raw } of validEvents) {
        const eventId = event.eventId.toLowerCase();
        const sessionId = event.sessionId.toLowerCase();

        const existing = tx
          .select({ userId: events.userId })
          .from(events)
          .where(eq(events.eventId, eventId))
          .get();
        if (existing) {
          duplicates.push(event.eventId);
          if (existing.userId !== userId) foreignDuplicates += 1;
          continue;
        }

        const sessionOwner = tx
          .select({ userId: events.userId })
          .from(events)
          .where(eq(events.sessionId, sessionId))
          .limit(1)
          .get();
        if (sessionOwner && sessionOwner.userId !== userId) {
          rejected.push({ index, eventId: event.eventId, error: SESSION_NOT_ALLOWED });
          continue;
        }

        const { changes } = tx
          .insert(events)
          .values({
            eventId,
            userId,
            type: event.type,
            accountHash: event.accountHash,
            sessionId,
            occurredAt: event.occurredAt,
            receivedAt,
            apiKeyId,
            schemaVersion: event.schemaVersion,
            // The payload as received, not Zod's output, so nothing is reshaped.
            payload: JSON.stringify(raw.payload),
          })
          .onConflictDoNothing({ target: events.eventId })
          .run();
        if (changes === 1) {
          accepted.push(event.eventId);
          storedIds.push(eventId);
        } else {
          duplicates.push(event.eventId);
        }
      }
    },
    // Take the write lock up front instead of upgrading a read lock mid-batch.
    { behavior: 'immediate' },
  );

  return { accepted, duplicates, foreignDuplicates, rejected, storedIds };
}
