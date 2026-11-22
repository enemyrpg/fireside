import { z } from 'zod';
import { nonNegativeInt, semver, utcTimestamp, uuidV7 } from '../common.js';

// Plugin endpoints.

/** Max events per `POST /ingest` batch. */
export const MAX_INGEST_EVENTS = 500;

/** Max request body size for `POST /ingest` (larger gives 413). */
export const MAX_INGEST_BYTES = 1024 * 1024;

/** `GET /api/v1/ingest/verify` */
export const ingestVerifyResponseSchema = z.strictObject({
  ok: z.literal(true),
  /** Name of the API key that was used. */
  keyName: z.string().min(1),
  serverVersion: semver,
  /** `CONTRACT_VERSION` the server implements. The plugin warns if it's too old. */
  contractVersion: semver,
  /**
   * Server clock when the response was built (since 1.13.0). Same format as
   * `occurredAt`. The plugin compares it with its own clock and warns about
   * clock skew, since session timeouts compare plugin and server time.
   */
  serverTime: utcTimestamp,
});

/**
 * `POST /api/v1/ingest` body. Events are not validated here: the server
 * validates them one by one (with `eventSchema`), so one bad event is
 * rejected without failing the whole batch.
 */
export const ingestRequestSchema = z.strictObject({
  events: z
    .array(z.unknown())
    .min(1)
    .max(MAX_INGEST_EVENTS)
    // Shows up in the JSON Schema, where `items` is empty.
    .meta({
      description: 'Events are not checked here. Validate each event against schema/event.json.',
    }),
});

export const ingestRejectionSchema = z.strictObject({
  /** Position of the event in the batch. */
  index: nonNegativeInt,
  /** The event's `eventId` as sent, or `null` if it was missing, empty or not a string. */
  eventId: z.string().min(1).nullable(),
  error: z.string().min(1),
});

/** `POST /api/v1/ingest` response (200). */
export const ingestResponseSchema = z.strictObject({
  accepted: z.array(uuidV7),
  duplicates: z.array(uuidV7),
  rejected: z.array(ingestRejectionSchema),
});

export type IngestVerifyResponse = z.infer<typeof ingestVerifyResponseSchema>;
export type IngestRequest = z.infer<typeof ingestRequestSchema>;
export type IngestRejection = z.infer<typeof ingestRejectionSchema>;
export type IngestResponse = z.infer<typeof ingestResponseSchema>;
