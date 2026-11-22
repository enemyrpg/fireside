import { and, eq, inArray } from 'drizzle-orm';
import { storeExternalSnapshot } from '../clog/project.js';
import { recordClogRead } from '../clog/reads.js';
import { contentHash } from '../clog/runeprofile.js';
import type { Db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import type { SeedData } from './generator/generate.js';

// Collection logs for the seed accounts. The rest of the seed goes through
// `POST /api/v1/ingest`, but a collection log is not an event: it is raw data
// from an external source. So the hand-made bodies are stored unchanged in
// `external_snapshots` and applied by the same function a sync uses, and
// `pnpm cli rebuild` gives the same tables.
//
// No row is written to `account_clog_sources`: a seed account must never be
// looked up at the real source, whose profile under that name could be a real
// player's. The accounts show as "source off, with a stored collection log".

/**
 * Stores the seed's collection logs for the accounts of `userId` (the user
 * whose key sent the seed's events). Returns how many responses were stored.
 */
export function storeSeedCollectionLogs(db: Db, data: SeedData, userId: number): number {
  if (data.collectionLogs.length === 0) return 0;
  const ids = new Map(
    db
      .select({ hash: accounts.accountHash, id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          inArray(
            accounts.accountHash,
            data.collectionLogs.map((log) => log.accountHash),
          ),
        ),
      )
      .all()
      .map((account) => [account.hash, account.id]),
  );
  // In the order they were fetched, as syncs of several accounts would store them.
  const rows = data.collectionLogs
    .flatMap((log, account) => {
      const accountId = ids.get(log.accountHash);
      // No account row: none of its events was stored.
      if (accountId === undefined) return [];
      return log.snapshots.map((snapshot, index) => ({ accountId, account, index, snapshot }));
    })
    .sort(
      (a, b) =>
        a.snapshot.fetchedAt.localeCompare(b.snapshot.fetchedAt) ||
        a.account - b.account ||
        a.index - b.index,
    );
  db.transaction(
    (tx) => {
      for (const { accountId, snapshot } of rows) {
        storeExternalSnapshot(tx, {
          source: 'RUNEPROFILE',
          kind: snapshot.kind,
          accountId,
          fetchedAt: snapshot.fetchedAt,
          body: snapshot.body,
          contentHash: contentHash(snapshot.body),
        });
      }
      // Every successful read, also those that found nothing new.
      for (const log of data.collectionLogs) {
        const accountId = ids.get(log.accountHash);
        if (accountId === undefined) continue;
        for (const readAt of log.reads) recordClogRead(tx, accountId, readAt);
      }
    },
    { behavior: 'immediate' },
  );
  return rows.length;
}
