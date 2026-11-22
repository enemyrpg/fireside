import { normalizeBossName } from '@fireside/shared';
import { asc, eq } from 'drizzle-orm';
import { accounts, pbRecords } from '../db/schema.js';
import type { Projection } from './framework.js';
import { accountIdOf } from './lookup.js';

// `pb_records`. Keyed insert: one row per record of a `pb.records` event. Boss
// names are normalized like in `kc_observations`; scopes are stored as sent.

export const pbRecordsProjection: Projection = {
  name: 'pb-records',

  apply(tx, event) {
    if (event.type !== 'pb.records') return;
    const accountId = accountIdOf(tx, event);
    const boss = normalizeBossName(event.payload.boss);
    tx.insert(pbRecords)
      .values(
        event.payload.records.map(({ scope, teamSize, seconds }) => ({
          accountId,
          sessionId: event.sessionId,
          eventId: event.eventId,
          observedAt: event.occurredAt,
          boss,
          scope,
          teamSize,
          seconds,
        })),
      )
      .run();
  },

  reset(tx) {
    tx.delete(pbRecords).run();
  },

  snapshot(db) {
    return db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        eventId: pbRecords.eventId,
        sessionId: pbRecords.sessionId,
        observedAt: pbRecords.observedAt,
        boss: pbRecords.boss,
        scope: pbRecords.scope,
        teamSize: pbRecords.teamSize,
        seconds: pbRecords.seconds,
      })
      .from(pbRecords)
      .innerJoin(accounts, eq(pbRecords.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(pbRecords.observedAt),
        asc(pbRecords.eventId),
        asc(pbRecords.scope),
        asc(pbRecords.teamSize),
      )
      .all();
  },
};
