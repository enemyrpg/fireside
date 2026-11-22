import { normalizeBossName, type Event } from '@fireside/shared';
import { asc, eq } from 'drizzle-orm';
import { accounts, kcObservations } from '../db/schema.js';
import type { Projection } from './framework.js';
import { accountIdOf } from './lookup.js';

// `kc_observations`. Keyed insert: at most one observation per event, from a
// `kc` event or a `loot` event with `killCount`. Boss names are normalized with
// the alias table in shared/; unknown bosses are stored as sent (cleaned up).

interface Observation {
  boss: string;
  killCount: number;
  timeSeconds: number | null;
  personalBest: boolean;
  personalBestSeconds: number | null;
  teamSize: number | null;
}

/** The KC observation an event gives, or `undefined` if none. */
export function kcObservationOf(event: Event): Observation | undefined {
  if (event.type === 'kc') {
    const { boss, killCount, timeSeconds, personalBest, personalBestSeconds, teamSize } =
      event.payload;
    return {
      boss: normalizeBossName(boss),
      killCount,
      timeSeconds: timeSeconds ?? null,
      personalBest: personalBest ?? false,
      personalBestSeconds: personalBestSeconds ?? null,
      teamSize: teamSize ?? null,
    };
  }
  if (event.type === 'loot') {
    const { source, killCount } = event.payload;
    // PLAYER loot has no name, so there is no boss to attach the KC to.
    if (killCount === undefined || source.name === null) return undefined;
    return {
      boss: normalizeBossName(source.name),
      killCount,
      timeSeconds: null,
      personalBest: false,
      personalBestSeconds: null,
      teamSize: null,
    };
  }
  return undefined;
}

export const kcProjection: Projection = {
  name: 'kc',

  apply(tx, event) {
    const observation = kcObservationOf(event);
    if (!observation) return;
    tx.insert(kcObservations)
      .values({
        accountId: accountIdOf(tx, event),
        sessionId: event.sessionId,
        eventId: event.eventId,
        observedAt: event.occurredAt,
        ...observation,
      })
      .run();
  },

  reset(tx) {
    tx.delete(kcObservations).run();
  },

  snapshot(db) {
    return db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        eventId: kcObservations.eventId,
        sessionId: kcObservations.sessionId,
        observedAt: kcObservations.observedAt,
        boss: kcObservations.boss,
        killCount: kcObservations.killCount,
        timeSeconds: kcObservations.timeSeconds,
        personalBest: kcObservations.personalBest,
        personalBestSeconds: kcObservations.personalBestSeconds,
        teamSize: kcObservations.teamSize,
      })
      .from(kcObservations)
      .innerJoin(accounts, eq(kcObservations.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(kcObservations.observedAt),
        asc(kcObservations.eventId),
      )
      .all();
  },
};
