import type { PetDropPayload } from '@fireside/shared';
import type { Profile } from './profiles.js';
import type { Rng } from './rng.js';
import type { Draft } from './session.js';

// `pet.drop` events for the seed. Added after the sessions are simulated, each
// at the time of an event the account already has, with their own random
// streams and their own event IDs, so every other event is the same with or
// without them.
//
// Together with the seed's collection logs (generator/clog.ts) they show every
// state of the trophy case:
// - Seed Main: Vorki from chat, confirmed by the collection log, with the KC
//   at the time, and a later duplicate that never counts. Its other pets are
//   only in the collection log.
// - Seed Iron: Rock golem from chat with the Mining XP at the time, confirmed,
//   and a recent Beaver its collection log does not have yet (unconfirmed).
// - The third account has no pets.

interface PetPlan {
  payload: PetDropPayload;
  /** How far through the account's matching events the drop happens, 0–1. */
  at: number;
  /** The events the drop can happen at. */
  matches(draft: Draft): boolean;
}

const VORKATH = { type: 'ACTIVITY', name: 'Vorkath' } as const;
const VORKI = { itemId: 21992, name: 'Vorki' };

const isVorkathKill = (draft: Draft) =>
  draft.body.type === 'kc' && draft.body.payload.boss === 'Vorkath';
const isIntervalSnapshot = (draft: Draft) =>
  draft.body.type === 'xp.snapshot' && draft.body.payload.reason === 'interval';

const PLANS: Partial<Record<Profile['key'], readonly PetPlan[]>> = {
  main: [
    {
      payload: { message: 'FOLLOWED', guessedPet: VORKI, guessedSource: VORKATH },
      at: 0.5,
      matches: isVorkathKill,
    },
    {
      payload: { message: 'DUPLICATE', guessedPet: VORKI, guessedSource: VORKATH },
      at: 0.9,
      matches: isVorkathKill,
    },
  ],
  iron: [
    {
      payload: {
        message: 'BACKPACK',
        guessedPet: { itemId: 13321, name: 'Rock golem' },
        guessedSource: { type: 'SKILL', name: 'MINING' },
      },
      at: 0.4,
      matches: isIntervalSnapshot,
    },
    {
      payload: {
        message: 'FOLLOWED',
        guessedPet: { itemId: 13322, name: 'Beaver' },
        guessedSource: { type: 'SKILL', name: 'WOODCUTTING' },
      },
      at: 0.95,
      matches: isIntervalSnapshot,
    },
  ],
};

/**
 * The account's pet drops, as drafts in the session of the event each one
 * happens at, one millisecond after it. `drafts` are the account's own, in
 * game order. `takenMs` holds the time of every event of every account: a
 * drop gets a millisecond of its own, so its ID (from its own generator)
 * sorts in game order. `nextSeq` gives emission numbers after every simulated
 * event.
 */
export function petDropDrafts(
  profile: Profile,
  drafts: readonly Draft[],
  rng: Rng,
  takenMs: Set<number>,
  untilMs: number,
  nextSeq: () => number,
): Draft[] {
  /** The last event of each session. */
  const sessionEnd = new Map<string, number>();
  for (const draft of drafts) {
    sessionEnd.set(draft.sessionKey, Math.max(sessionEnd.get(draft.sessionKey) ?? 0, draft.ms));
  }
  /** Events with a free millisecond right after them, before their session's last event. */
  const free = (draft: Draft) =>
    draft.ms + 1 <= untilMs &&
    !takenMs.has(draft.ms + 1) &&
    draft.ms + 1 < (sessionEnd.get(draft.sessionKey) ?? 0);
  return (PLANS[profile.key] ?? []).flatMap((plan) => {
    const candidates = drafts.filter((draft) => plan.matches(draft) && free(draft));
    if (candidates.length === 0) return [];
    // Near the planned point, a little different per seed.
    const middle = Math.floor(plan.at * (candidates.length - 1));
    const spread = Math.floor(candidates.length / 20);
    const index = Math.min(candidates.length - 1, Math.max(0, middle + rng.int(-spread, spread)));
    const anchor = candidates[index];
    if (!anchor) return [];
    takenMs.add(anchor.ms + 1);
    return [
      {
        ms: anchor.ms + 1,
        account: anchor.account,
        seq: nextSeq(),
        sessionKey: anchor.sessionKey,
        body: { type: 'pet.drop', payload: plan.payload },
      },
    ];
  });
}
