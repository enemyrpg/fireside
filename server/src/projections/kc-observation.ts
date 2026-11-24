import { normalizeBossName, type Event } from '@fireside/shared';

// The KC observation an event gives. Its own module so the kc projection and
// the session summaries can both use it without importing each other.

export interface Observation {
  boss: string;
  killCount: number;
  timeSeconds: number | null;
  personalBest: boolean;
  personalBestSeconds: number | null;
  teamSize: number | null;
}

/**
 * The KC observation an event gives, or `undefined` if none: from a `kc`
 * event, or a named `loot` event with `killCount`. Boss names are normalized
 * with the alias table in shared/; unknown bosses are stored as sent (cleaned up).
 */
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
