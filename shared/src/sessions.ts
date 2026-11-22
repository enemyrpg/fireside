// Rules about sessions that the server and the dashboard share.

/** A hop is merged with the next session when that starts less than this after the hop. */
export const HOP_MERGE_MS = 2 * 60_000;

/**
 * Whether `next` continues `previous` after a quick world hop: same account,
 * `previous` ended with `hop` and `next` started less than 2 minutes later.
 * The one hop rule: the Sessions list, the hop chain on Session detail, and
 * the server's rule for collection log items found after a session.
 */
export function continuesHop(
  previous: { accountId: number; endReason: string | null; endedAt: string | null },
  next: { accountId: number; startedAt: string },
): boolean {
  if (previous.accountId !== next.accountId) return false;
  if (previous.endReason !== 'hop' || previous.endedAt === null) return false;
  return Date.parse(next.startedAt) - Date.parse(previous.endedAt) < HOP_MERGE_MS;
}
