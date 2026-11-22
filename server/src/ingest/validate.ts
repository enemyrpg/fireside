import { eventSchema, type Event, type IngestRejection } from '@fireside/shared';

// Per-event validation for `POST /api/v1/ingest`. The batch envelope is checked
// before this runs; here each event is checked on its own, so one bad event
// never fails the rest of the batch.

/** Max issues listed in one rejection, so one huge bad event can't blow up the response. */
export const MAX_LISTED_ISSUES = 5;

export interface ValidEvent {
  /** Position in the batch. */
  index: number;
  event: Event;
  /** The event as received, before parsing. Its payload is what gets stored. */
  raw: Record<string, unknown>;
}

export interface ValidatedBatch {
  valid: ValidEvent[];
  rejected: IngestRejection[];
}

interface Issue {
  path: readonly PropertyKey[];
  message: string;
}

/**
 * `payload.items.0.quantity: Too small…; eventId: …`, capped at `MAX_LISTED_ISSUES`.
 * An empty path is shown as `root` (`event`, or `icon` for icon uploads).
 */
export function formatIssues(issues: readonly Issue[], root = 'event'): string {
  const listed = issues.slice(0, MAX_LISTED_ISSUES).map((issue) => {
    const path = issue.path.map(String).join('.');
    return `${path === '' ? root : path}: ${issue.message}`;
  });
  const hidden = issues.length - listed.length;
  if (hidden > 0) listed.push(`(+${String(hidden)} more)`);
  return listed.join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The event's `eventId` as sent, or `null` if it's missing, empty or not a string. */
export function rawEventId(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const id = raw.eventId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Splits a batch into valid events and rejections, keeping batch order. */
export function validateBatch(rawEvents: readonly unknown[]): ValidatedBatch {
  const valid: ValidEvent[] = [];
  const rejected: IngestRejection[] = [];
  rawEvents.forEach((raw, index) => {
    const result = eventSchema.safeParse(raw);
    // `isRecord` always holds after a successful parse; it narrows the type.
    if (result.success && isRecord(raw)) {
      valid.push({ index, event: result.data, raw });
    } else {
      rejected.push({
        index,
        eventId: rawEventId(raw),
        error: result.error ? formatIssues(result.error.issues) : 'event: Invalid input',
      });
    }
  });
  return { valid, rejected };
}
