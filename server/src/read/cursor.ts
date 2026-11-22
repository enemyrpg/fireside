import { z } from 'zod';
import { ApiError } from '../errors.js';

// Opaque keyset cursors for paginated lists (`loot/drops`, later `sessions`).
// A cursor is the sort key of the last item on a page, as base64url JSON.
// Clients pass it back unchanged; it is validated like any other input.

/** Sort-key parts that cursors use. Same formats as in events. */
export const cursorParts = {
  timestamp: z.iso.datetime({ precision: 3 }),
  // Stored in lower case (see ingest), so compare in lower case.
  eventId: z.uuid({ version: 'v7' }).transform((id) => id.toLowerCase()),
  index: z.int().nonnegative(),
};

export function encodeCursor(key: readonly unknown[]): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/** The key in `cursor`, checked by `schema`. `400 VALIDATION_ERROR` at `query.cursor` if invalid. */
export function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.infer<S> {
  const invalid = () =>
    new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
      { path: 'query.cursor', message: 'Invalid cursor' },
    ]);
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
