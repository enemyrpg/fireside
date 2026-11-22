import type { Session } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { chainFromList, HOP_CHAIN_MAX_STEPS, walkHopChain, type KnownSession } from './hop-chain';

const id = (n: number) => `01933c40-2222-7aaa-bbbb-${String(n).padStart(12, '0')}`;

/** Sessions `n` for account 1, each 10 min, `gapSeconds` apart; `hop` marks the ones ending with a hop. */
function sessions(specs: { hop?: boolean; gapSeconds?: number; accountId?: number }[]): Session[] {
  let at = Date.parse('2026-11-08T10:00:00Z');
  return specs.map((spec, index) => {
    if (index > 0) at += (spec.gapSeconds ?? 20) * 1000;
    const startedAt = new Date(at).toISOString();
    at += 10 * 60_000;
    return {
      id: id(index + 1),
      accountId: spec.accountId ?? 1,
      startedAt,
      endedAt: new Date(at).toISOString(),
      endReason: spec.hop ? 'hop' : 'logout',
      world: 300 + index,
      durationSeconds: 600,
      activeSeconds: 600,
      afkSeconds: 0,
      summary: null,
      newCollectionLogCount: 0,
    };
  });
}

/** Oldest first in, with neighbours as the API gives them (same account, list order). */
function known(list: Session[]): Map<string, KnownSession> {
  const map = new Map<string, KnownSession>();
  list.forEach((session, index) => {
    map.set(session.id, {
      session,
      neighbors: { olderId: list[index - 1]?.id ?? null, newerId: list[index + 1]?.id ?? null },
    });
  });
  return map;
}

const at = (map: Map<string, KnownSession>, n: number) => {
  const found = map.get(id(n));
  if (!found) throw new Error('missing');
  return found;
};
const ids = (parts: readonly Session[]) => parts.map((part) => part.id);

describe('walkHopChain', () => {
  // 1 logout | 2 hop → 3 hop → 4 logout | 5
  const list = sessions([
    {},
    { gapSeconds: 3600, hop: true },
    { hop: true },
    {},
    { gapSeconds: 3600 },
  ]);
  const map = known(list);

  it('finds the whole chain from any part, in both directions', () => {
    for (const n of [2, 3, 4]) {
      const walk = walkHopChain(at(map, n), (sessionId) => map.get(sessionId));
      expect(ids(walk.parts)).toEqual([id(2), id(3), id(4)]);
      expect(walk.pending).toEqual([]);
      expect(walk.capped).toBe(false);
    }
  });

  it('asks for the sessions it has not seen yet, one step at a time', () => {
    const seen = new Map([[id(3), at(map, 3)]]);
    const walk = walkHopChain(at(map, 3), (sessionId) => seen.get(sessionId));
    expect(ids(walk.parts)).toEqual([id(3)]);
    expect(walk.pending).toEqual([id(2), id(4)]);
  });

  it('needs only the older neighbour for a session that did not end with a hop', () => {
    const walk = walkHopChain(at(map, 5), () => undefined);
    expect(walk.pending).toEqual([id(4)]);
    const done = walkHopChain(at(map, 5), (sessionId) => map.get(sessionId));
    expect(ids(done.parts)).toEqual([id(5)]);
  });

  it('stops at a gap of 2 minutes or more, or a session that could not be fetched', () => {
    const gap = known(sessions([{ hop: true }, { gapSeconds: 120 }]));
    expect(ids(walkHopChain(at(gap, 2), (s) => gap.get(s)).parts)).toEqual([id(2)]);
    const failed = walkHopChain(at(map, 3), (s) => (s === id(2) ? null : map.get(s)));
    expect(ids(failed.parts)).toEqual([id(3), id(4)]);
    expect(failed.pending).toEqual([]);
  });

  it('never joins another account', () => {
    const mixed = known(sessions([{ hop: true }, { accountId: 2 }]));
    expect(ids(walkHopChain(at(mixed, 2), (s) => mixed.get(s)).parts)).toEqual([id(2)]);
  });

  it(`stops after ${String(HOP_CHAIN_MAX_STEPS)} steps and says so`, () => {
    const long = known(sessions(Array.from({ length: 15 }, () => ({ hop: true }))));
    const walk = walkHopChain(at(long, 1), (s) => long.get(s));
    expect(walk.parts).toHaveLength(HOP_CHAIN_MAX_STEPS + 1);
    expect(walk.capped).toBe(true);
  });
});

describe('chainFromList', () => {
  const list = sessions([{}, { gapSeconds: 3600, hop: true }, { hop: true }, {}]);
  const newestFirst = [...list].reverse();
  const part = (n: number) => {
    const found = list[n - 1];
    if (!found) throw new Error('missing');
    return found;
  };

  it('takes the chain from the loaded list', () => {
    expect(ids(chainFromList(newestFirst, false, part(3)) ?? [])).toEqual([id(2), id(3), id(4)]);
    expect(ids(chainFromList(newestFirst, false, part(1)) ?? [])).toEqual([id(1)]);
  });

  it('is unknown for a session not in the list', () => {
    const other = { ...part(1), id: id(9) };
    expect(chainFromList(newestFirst, false, other)).toBeUndefined();
  });

  it('is unknown when an older part may be on the next page', () => {
    // Only the chain is loaded and more pages exist: its first part may not be the first.
    const page = newestFirst.slice(0, 3);
    expect(chainFromList(page, true, part(3))).toBeUndefined();
    // With an older session of the account loaded, the chain is surely whole.
    expect(ids(chainFromList(newestFirst, true, part(3)) ?? [])).toEqual([id(2), id(3), id(4)]);
  });

  it('is unknown when the list has an older copy of the session (a hop after it loaded)', () => {
    // The list loaded while the session was live; the detail (polled) has the hop.
    const live = { ...part(1), endedAt: null, endReason: null };
    const hopped = { ...part(1), endReason: 'hop' as const };
    expect(chainFromList([live], false, hopped)).toBeUndefined();
  });

  it('is unknown when the session ended with a hop and the list has nothing newer', () => {
    // The next part may have started after the list loaded.
    const hopped = { ...part(1), endReason: 'hop' as const };
    expect(chainFromList([hopped], false, hopped)).toBeUndefined();
    // A newer session of the account in the list (not joined: > 2 min) settles it.
    const later = { ...part(4), startedAt: '2026-11-08T12:00:00.000Z' };
    expect(ids(chainFromList([later, hopped], false, hopped) ?? [])).toEqual([id(1)]);
  });

  it("uses the detail's copy of the current part, so its times are fresh", () => {
    const fresh = { ...part(4), durationSeconds: 1234 };
    const chain = chainFromList(newestFirst, false, fresh);
    expect(chain?.at(-1)?.durationSeconds).toBe(1234);
  });
});
