import type { Queryable } from '../db/index.js';
import { clogReads } from '../db/schema.js';

// `clog_reads`: one row per successful collection log read, also when the body
// was unchanged and so not stored. Raw data like `external_snapshots`: written
// only by the sync (and the seed's simulated syncs), never by `rebuild`,
// deleted with the user. Read by the rule that ties an approximate collection
// log item to a session (server/src/read/session-clog.ts).

/** Records that the account's collection log was read at `readAt`. */
export function recordClogRead(tx: Queryable, accountId: number, readAt: string): void {
  tx.insert(clogReads).values({ accountId, readAt }).onConflictDoNothing().run();
}
