import {
  BOSS_ALIASES,
  EVENT_TYPES,
  eventSchema,
  isRaidPurple,
  normalizeBossName,
  offsetChanges,
  raidOf,
  RAIDS,
  SKILLS,
  toLocal,
  type Event,
  type EventOfType,
} from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { generateSeed, type SeedData, type SeedOptions } from './generate.js';
import { AFK_THRESHOLD_MS } from './session.js';
import { levelForXp } from './xp-table.js';

const OSLO = 'Europe/Oslo';
const MINUTE = 60_000;
/** The server's session timeout (see docs/architecture.md#sessions). */
const TIMEOUT_MS = 10 * MINUTE;

const FULL: SeedOptions = {
  seed: 1,
  accounts: 3,
  months: 6,
  until: new Date('2026-11-10T12:00:00.000Z'),
  timeZone: OSLO,
};
/** Two accounts, about two weeks, across the October DST change. */
const SHORT: SeedOptions = {
  seed: 7,
  accounts: 2,
  months: 0.5,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: OSLO,
};

const cache = new Map<SeedOptions, SeedData>();
function data(options: SeedOptions): SeedData {
  let generated = cache.get(options);
  if (!generated) {
    generated = generateSeed(options);
    cache.set(options, generated);
  }
  return generated;
}

const ms = (iso: string) => Date.parse(iso);
const ARCHIVE = 'The Fractured Archive';

function ofType<T extends Event['type']>(events: readonly Event[], type: T): EventOfType<T>[] {
  return events.filter((event): event is EventOfType<T> => event.type === type);
}

function bySession(events: readonly Event[]): Map<string, Event[]> {
  const sessions = new Map<string, Event[]>();
  for (const event of events) {
    const list = sessions.get(event.sessionId) ?? [];
    list.push(event);
    sessions.set(event.sessionId, list);
  }
  return sessions;
}

function byAccount(events: readonly Event[]): Map<string, Event[]> {
  const accounts = new Map<string, Event[]>();
  for (const event of events) {
    const list = accounts.get(event.accountHash) ?? [];
    list.push(event);
    accounts.set(event.accountHash, list);
  }
  return accounts;
}

/** Raid KC messages (any mode in `RAIDS`). */
function raidKc(events: readonly Event[]): EventOfType<'kc'>[] {
  return ofType(events, 'kc').filter((kc) => raidOf(normalizeBossName(kc.payload.boss)));
}

/** Collapses runs of equal values: [a, a, b, a] → [a, b, a]. */
function runs<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

describe('generateSeed: determinism', () => {
  it('gives identical events (IDs included) for the same options', () => {
    const again = generateSeed({ ...SHORT });
    expect(again.events).toEqual(data(SHORT).events);
    expect(again.deliveries).toEqual(data(SHORT).deliveries);
    expect(again.stats).toEqual(data(SHORT).stats);
  });

  it('gives different events for another seed', () => {
    const other = generateSeed({ ...SHORT, seed: 8 });
    expect(other.events[0]?.eventId).not.toBe(data(SHORT).events[0]?.eventId);
    expect(other.events.length).not.toBe(data(SHORT).events.length);
  });

  it('validates its options', () => {
    expect(() => generateSeed({ ...SHORT, accounts: 4 })).toThrow(RangeError);
    expect(() => generateSeed({ ...SHORT, accounts: 1 })).toThrow(RangeError);
    expect(() => generateSeed({ ...SHORT, months: 0 })).toThrow(RangeError);
    expect(() => generateSeed({ ...SHORT, seed: -1 })).toThrow(RangeError);
    expect(() => generateSeed({ ...SHORT, until: new Date('nope') })).toThrow(RangeError);
  });
});

describe('generateSeed: raids over six months', () => {
  it('has every raid, several modes and team sizes, and purples for both recipients', () => {
    const { stats, events } = data(FULL);
    const raids = new Set(
      raidKc(events).map((kc) => raidOf(normalizeBossName(kc.payload.boss))?.name),
    );
    expect(raids).toEqual(new Set(RAIDS.map((raid) => raid.name)));
    expect(Object.keys(stats.raids.byMode).length).toBeGreaterThanOrEqual(7);
    expect(new Set(raidKc(events).map((kc) => kc.payload.teamSize)).size).toBeGreaterThanOrEqual(6);
    expect(stats.raids.specialLoot.SELF).toBeGreaterThan(0);
    expect(stats.raids.specialLoot.TEAMMATE).toBeGreaterThan(stats.raids.specialLoot.SELF);
    // Purples are rare.
    expect(stats.eventsByType['raid.special_loot']).toBeLessThan(stats.raids.completions / 5);
  });
});

describe.each([
  ['3 accounts × 6 months', FULL],
  ['2 accounts × 2 weeks', SHORT],
])('generateSeed: %s', (_name, options) => {
  const seed = () => data(options);

  it('has the requested accounts with distinct hashes', () => {
    const accounts = seed().accounts;
    expect(accounts).toHaveLength(options.accounts);
    expect(new Set(accounts.map((a) => a.accountHash)).size).toBe(options.accounts);
    expect(new Set(seed().events.map((e) => e.accountHash))).toEqual(
      new Set(accounts.map((a) => a.accountHash)),
    );
  });

  it('only makes events that pass the contract schema', () => {
    const invalid = seed().events.filter((event) => !eventSchema.safeParse(event).success);
    expect(invalid).toEqual([]);
  });

  it('stays inside the window', () => {
    const { events, from, until } = seed();
    expect(events.every((e) => ms(e.occurredAt) >= from.getTime())).toBe(true);
    expect(events.every((e) => ms(e.occurredAt) <= until.getTime())).toBe(true);
  });

  it('has strictly increasing, monotonic event IDs in game order', () => {
    const events = seed().events;
    for (let i = 1; i < events.length; i++) {
      const previous = events[i - 1];
      const event = events[i];
      if (!previous || !event) throw new Error('missing event');
      expect(event.occurredAt >= previous.occurredAt).toBe(true);
      expect(event.eventId > previous.eventId).toBe(true);
    }
    for (const event of events) {
      const idMs = Number.parseInt(event.eventId.replace(/-/g, '').slice(0, 12), 16);
      expect(idMs).toBe(ms(event.occurredAt));
      // The session ID was made at login, so it sorts before its events.
      expect(event.sessionId <= event.eventId).toBe(true);
    }
  });

  it('delivers every event exactly once, never before it happens, within limits', () => {
    const { events, deliveries } = seed();
    const delivered = deliveries.flatMap((d) => d.events.map((e) => e.eventId));
    expect(delivered.length).toBe(events.length);
    expect(new Set(delivered)).toEqual(new Set(events.map((e) => e.eventId)));
    for (let i = 1; i < deliveries.length; i++) {
      expect(
        (deliveries[i]?.sendAt.getTime() ?? 0) >= (deliveries[i - 1]?.sendAt.getTime() ?? 0),
      ).toBe(true);
    }
    for (const delivery of deliveries) {
      for (const event of delivery.events)
        expect(ms(event.occurredAt)).toBeLessThanOrEqual(delivery.sendAt.getTime());
    }
  });

  it('starts every session with session.start and ends it with at most one session.end', () => {
    for (const [, events] of bySession(seed().events)) {
      expect(events[0]?.type).toBe('session.start');
      expect(ofType(events, 'session.start')).toHaveLength(1);
      expect(new Set(events.map((e) => e.accountHash)).size).toBe(1);
      const ends = ofType(events, 'session.end');
      expect(ends.length).toBeLessThanOrEqual(1);
      if (ends[0]) expect(events[events.length - 1]).toBe(ends[0]);
    }
  });

  it('sends a heartbeat every 60 seconds during a session', () => {
    for (const [, events] of bySession(seed().events)) {
      const start = ms(events[0]?.occurredAt ?? '');
      const beats = ofType(events, 'session.heartbeat').map((e) => ms(e.occurredAt));
      expect(beats.length).toBeGreaterThan(0);
      let previous = start;
      for (const beat of beats) {
        expect(beat - previous).toBeGreaterThan(59 * 1000);
        expect(beat - previous).toBeLessThanOrEqual(61 * 1000);
        previous = beat;
      }
    }
  });

  it('keeps AFK periods inside their session, at least 5 minutes, with idle heartbeats in them', () => {
    let afkCount = 0;
    for (const [, events] of bySession(seed().events)) {
      const start = ms(events[0]?.occurredAt ?? '');
      const last = ms(events[events.length - 1]?.occurredAt ?? '');
      const periods = ofType(events, 'session.afk').map((e) => {
        expect(e.occurredAt).toBe(e.payload.endedAt);
        return { from: ms(e.payload.startedAt), to: ms(e.payload.endedAt) };
      });
      afkCount += periods.length;
      for (const period of periods) {
        expect(period.from).toBeGreaterThanOrEqual(start);
        expect(period.to).toBeLessThanOrEqual(last);
        expect(period.to - period.from).toBeGreaterThanOrEqual(AFK_THRESHOLD_MS);
      }
      const inAfk = (at: number) => periods.some((p) => at >= p.from && at <= p.to);
      for (const beat of ofType(events, 'session.heartbeat')) {
        expect(beat.payload.idle).toBe(inAfk(ms(beat.occurredAt)));
      }
      // Nothing happens in game while the player is away.
      for (const event of [...ofType(events, 'kc'), ...ofType(events, 'loot')]) {
        expect(inAfk(ms(event.occurredAt))).toBe(false);
      }
    }
    expect(afkCount).toBeGreaterThan(0);
  });

  it('never decreases XP, and levels match the XP table', () => {
    for (const [, events] of byAccount(seed().events)) {
      let previous: Record<string, number> | undefined;
      for (const snapshot of ofType(events, 'xp.snapshot')) {
        const skills = snapshot.payload.skills as Record<string, { xp: number; level: number }>;
        expect(Object.keys(skills).sort()).toEqual([...SKILLS].sort());
        for (const [skill, value] of Object.entries(skills)) {
          expect(value.level).toBe(levelForXp(value.xp));
          if (previous) expect(value.xp).toBeGreaterThanOrEqual(previous[skill] ?? 0);
        }
        previous = Object.fromEntries(Object.entries(skills).map(([skill, v]) => [skill, v.xp]));
      }
    }
  });

  it('takes XP snapshots at login, at logout and every 5 minutes only when XP changed', () => {
    for (const [, events] of bySession(seed().events)) {
      const snapshots = ofType(events, 'xp.snapshot');
      expect(snapshots[0]?.payload.reason).toBe('login');
      expect(snapshots[0]?.occurredAt).toBe(events[0]?.occurredAt);
      const total = (s: (typeof snapshots)[number]) =>
        Object.values(s.payload.skills).reduce((sum, v) => sum + v.xp, 0);
      for (let i = 1; i < snapshots.length; i++) {
        const snapshot = snapshots[i];
        const previous = snapshots[i - 1];
        if (snapshot?.payload.reason === 'interval' && previous) {
          expect(total(snapshot)).toBeGreaterThan(total(previous));
        }
      }
      const end = ofType(events, 'session.end')[0];
      if (end?.payload.reason === 'logout') expect(snapshots.at(-1)?.payload.reason).toBe('logout');
    }
  });

  it('counts KC up by one per kill per boss, and loot kill counts match the KC messages', () => {
    for (const [, events] of byAccount(seed().events)) {
      const lastKc = new Map<string, number>();
      for (const kc of ofType(events, 'kc')) {
        const boss = normalizeBossName(kc.payload.boss);
        const previous = lastKc.get(boss);
        if (previous !== undefined) expect(kc.payload.killCount).toBe(previous + 1);
        lastKc.set(boss, kc.payload.killCount);
      }
      const kcAt = new Set(
        ofType(events, 'kc').map(
          (kc) =>
            `${kc.occurredAt}|${normalizeBossName(kc.payload.boss)}|${String(kc.payload.killCount)}`,
        ),
      );
      for (const loot of ofType(events, 'loot')) {
        if (loot.payload.killCount === undefined) continue;
        expect(loot.payload.source.name).not.toBeNull();
        const key = `${loot.occurredAt}|${normalizeBossName(loot.payload.source.name ?? '')}|${String(loot.payload.killCount)}`;
        expect(kcAt.has(key)).toBe(true);
      }
    }
  });

  it('sends player loot without a name', () => {
    const player = ofType(seed().events, 'loot').filter((l) => l.payload.source.type === 'PLAYER');
    for (const loot of player) expect(loot.payload.source).toEqual({ type: 'PLAYER', name: null });
  });

  it('covers every event type and every way a session ends', () => {
    const { events, stats } = seed();
    // Only TFA has a records table, so `pb.records` needs TFA kills (the
    // short seed ends before TFA's release).
    const hasArchive = events.some(
      (e) => e.type === 'kc' && normalizeBossName(e.payload.boss) === ARCHIVE,
    );
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set(EVENT_TYPES.filter((type) => hasArchive || type !== 'pb.records')),
    );
    expect(stats.sessionsByEnd.logout).toBeGreaterThan(0);
    expect(stats.sessionsByEnd.client_closed).toBeGreaterThan(0);
    expect(stats.sessionsByEnd.hop).toBeGreaterThan(0);
    expect(stats.sessionsByEnd.crash).toBeGreaterThanOrEqual(2);
    expect(stats.sessionsByEnd.open).toBe(1);
    expect(stats.eventsByType['session.start']).toBe(stats.sessions);
  });

  it('has pet drops inside sessions: a new pet with a later duplicate, and skilling pets', () => {
    for (const options of [FULL, SHORT]) {
      const { events, accounts, sessions } = data(options);
      const drops = ofType(events, 'pet.drop');
      const hashOf = (profile: string) => accounts.find((a) => a.profile === profile)?.accountHash;
      const of = (profile: string) => drops.filter((d) => d.accountHash === hashOf(profile));

      // Seed Main: Vorki at a Vorkath kill, then a duplicate at a later one.
      expect(of('main').map((d) => d.payload.message)).toEqual(['FOLLOWED', 'DUPLICATE']);
      for (const drop of of('main')) {
        expect(drop.payload.guessedPet).toEqual({ itemId: 21992, name: 'Vorki' });
        const kill = events.find(
          (e) =>
            e.type === 'kc' &&
            e.accountHash === drop.accountHash &&
            ms(e.occurredAt) === ms(drop.occurredAt) - 1,
        );
        expect(kill?.type === 'kc' && kill.payload.boss).toBe('Vorkath');
      }
      // Seed Iron: two skilling pets. The third account has none.
      expect(of('iron').map((d) => d.payload.guessedSource)).toEqual([
        { type: 'SKILL', name: 'MINING' },
        { type: 'SKILL', name: 'WOODCUTTING' },
      ]);
      expect(drops).toHaveLength(4);

      for (const drop of drops) {
        const session = sessions.find((s) => s.sessionId === drop.sessionId);
        expect(session?.accountHash).toBe(drop.accountHash);
        expect(ms(drop.occurredAt)).toBeGreaterThan(ms(session?.startedAt ?? ''));
        expect(ms(drop.occurredAt)).toBeLessThan(ms(session?.endedAt ?? ''));
        // No chat text, and nothing else at the same millisecond.
        expect(Object.keys(drop.payload).sort()).toEqual([
          'guessedPet',
          'guessedSource',
          'message',
        ]);
        expect(events.filter((e) => e.occurredAt === drop.occurredAt)).toHaveLength(1);
      }
    }
  });

  it('sends quest and diary snapshots after the first login, then only when the content changed', () => {
    for (const type of ['quests.snapshot', 'diaries.snapshot'] as const) {
      for (const [, events] of byAccount(seed().events)) {
        const snapshots = ofType(events, type);
        expect(snapshots.length, type).toBeGreaterThan(0);
        // The first one comes right after the account's first login.
        const first = events.find((event) => event.type === 'session.start');
        expect(snapshots[0]?.sessionId).toBe(first?.sessionId);
        expect(ms(snapshots[0]?.occurredAt ?? '') - ms(first?.occurredAt ?? '')).toBeLessThan(
          MINUTE,
        );
        const contents = snapshots.map((snapshot) => JSON.stringify(snapshot.payload));
        contents.forEach((content, index) => {
          if (index > 0) expect(content, type).not.toBe(contents[index - 1]);
        });
      }
    }
    const { events } = seed();
    const sessions = new Set(events.map((event) => event.sessionId)).size;
    expect(ofType(events, 'quests.snapshot').length).toBeLessThan(sessions / 2);
    if (options !== FULL) return;
    expect(ofType(events, 'quests.snapshot').length).toBeGreaterThan(30);
    expect(ofType(events, 'diaries.snapshot').length).toBeGreaterThan(6);
  });

  it('moves quests forward only, marks miniquests, and has quest points that never drop', () => {
    const order = { NOT_STARTED: 0, IN_PROGRESS: 1, FINISHED: 2 };
    for (const [, events] of byAccount(seed().events)) {
      const snapshots = ofType(events, 'quests.snapshot');
      snapshots.forEach((snapshot, index) => {
        const kinds = new Set(snapshot.payload.quests.map((quest) => quest.kind));
        expect(kinds).toEqual(new Set(['QUEST', 'MINIQUEST']));
        const previous = snapshots[index - 1];
        if (!previous) return;
        expect(snapshot.payload.questPoints).toBeGreaterThanOrEqual(previous.payload.questPoints);
        const before = new Map(previous.payload.quests.map((quest) => [quest.quest, quest.state]));
        for (const quest of snapshot.payload.quests) {
          expect(order[quest.state]).toBeGreaterThanOrEqual(
            order[before.get(quest.quest) ?? 'NOT_STARTED'],
          );
        }
      });
    }
  });

  it('sends some quest changes first after the next login', () => {
    if (options !== FULL) return;
    // A change just before the client closed is sent with the next login.
    const afterLogin = ofType(seed().events, 'quests.snapshot').filter((snapshot, _i, all) => {
      const isFirst = all.find((other) => other.accountHash === snapshot.accountHash) === snapshot;
      const start = seed().events.find(
        (event) => event.type === 'session.start' && event.sessionId === snapshot.sessionId,
      );
      return !isFirst && start && ms(snapshot.occurredAt) - ms(start.occurredAt) < 10_000;
    });
    expect(afterLogin.length).toBeGreaterThan(0);
  });

  it('opens the TFA records table after a new PB: every team size’s best so far', () => {
    for (const [, events] of byAccount(seed().events)) {
      const best = new Map<number, number>();
      for (const event of events) {
        if (event.type === 'kc' && normalizeBossName(event.payload.boss) === ARCHIVE) {
          const { teamSize, personalBestSeconds } = event.payload;
          if (teamSize !== undefined && personalBestSeconds !== undefined) {
            best.set(teamSize, personalBestSeconds);
          }
        }
        if (event.type !== 'pb.records') continue;
        expect(normalizeBossName(event.payload.boss)).toBe(ARCHIVE);
        expect(event.payload.records).toEqual(
          [...best]
            .sort(([a], [b]) => a - b)
            .map(([teamSize, seconds]) => ({ scope: 'overall', teamSize, seconds })),
        );
      }
    }
  });

  it('starts a new session within a minute of a world hop, on another world', () => {
    const accounts = byAccount(seed().events);
    let hops = 0;
    for (const [, events] of accounts) {
      events.forEach((event, index) => {
        if (event.type !== 'session.end' || event.payload.reason !== 'hop') return;
        hops += 1;
        const next = events.slice(index + 1).find((e) => e.type === 'session.start');
        const previousStart = ofType(events.slice(0, index), 'session.start').at(-1);
        expect(next?.type).toBe('session.start');
        if (next?.type !== 'session.start' || !previousStart) return;
        expect(ms(next.occurredAt) - ms(event.occurredAt)).toBeLessThan(MINUTE);
        expect(next.payload.world).not.toBe(previousStart.payload.world);
      });
    }
    expect(hops).toBeGreaterThan(0);
  });

  it('changes the iron’s name and back, and its account type once', () => {
    const iron = seed().accounts.find((a) => a.profile === 'iron');
    const starts = ofType(seed().events, 'session.start').filter(
      (e) => e.accountHash === iron?.accountHash,
    );
    expect(runs(starts.map((s) => s.payload.displayName))).toEqual([
      'Seed Iron',
      'Iron Seedling',
      'Seed Iron',
    ]);
    expect(runs(starts.map((s) => s.payload.accountType))).toEqual(['HARDCORE_IRONMAN', 'IRONMAN']);
  });

  it('uses canonical boss names, some aliases or other casing, and one unknown boss', () => {
    const canonical = new Set(BOSS_ALIASES.map((b) => b.name));
    const names = ofType(seed().events, 'kc').map((kc) => kc.payload.boss);
    const known = names.filter((name) => canonical.has(name));
    const aliased = names.filter(
      (name) => !canonical.has(name) && canonical.has(normalizeBossName(name)),
    );
    const unknown = new Set(names.filter((name) => !canonical.has(normalizeBossName(name))));
    expect(known.length).toBeGreaterThan(aliased.length);
    expect(aliased.length).toBeGreaterThan(0);
    expect(unknown).toEqual(new Set(['Seed Unknown Boss']));
  });

  it('has NPC, PLAYER, CLUE and EVENT loot', () => {
    const types = new Set(ofType(seed().events, 'loot').map((l) => l.payload.source.type));
    for (const type of ['NPC', 'PLAYER', 'CLUE', 'EVENT'] as const) expect(types).toContain(type);
  });

  it('has heartbeats with and without a loaded world list', () => {
    const beats = ofType(seed().events, 'session.heartbeat');
    expect(
      beats.some((b) => b.payload.worldLocation === null && b.payload.worldActivity === null),
    ).toBe(true);
    expect(beats.some((b) => b.payload.worldLocation !== null)).toBe(true);
    expect(beats.some((b) => b.payload.worldTypes.length === 0) || options.accounts === 2).toBe(
      true,
    );
  });

  it('has sessions across midnight and across the DST change, and two clients at once', () => {
    const sessions = seed().sessions;
    const localDay = (iso: string) => {
      const l = toLocal(ms(iso), options.timeZone);
      return `${String(l.year)}-${String(l.month)}-${String(l.day)}`;
    };
    expect(sessions.some((s) => localDay(s.startedAt) !== localDay(s.endedAt))).toBe(true);

    const [change] = offsetChanges(seed().from.getTime(), seed().until.getTime(), options.timeZone);
    expect(change).toBeDefined();
    expect(
      sessions.some((s) => ms(s.startedAt) < (change ?? 0) && ms(s.endedAt) > (change ?? 0)),
    ).toBe(true);

    const overlapping = sessions.some((a) =>
      sessions.some(
        (b) =>
          a.accountHash !== b.accountHash &&
          ms(a.startedAt) < ms(b.endedAt) &&
          ms(b.startedAt) < ms(a.endedAt),
      ),
    );
    expect(overlapping).toBe(true);
  });

  it('has a session still open at the end of the window', () => {
    const open = seed().sessions.filter((s) => s.end === 'open');
    expect(open).toHaveLength(1);
    expect(seed().until.getTime() - ms(open[0]?.endedAt ?? '')).toBeLessThan(MINUTE);
  });

  it('delivers an offline backlog late and out of order, with a session.end after the timeout', () => {
    const { deliveries, backlog } = seed();
    expect(backlog).not.toBeNull();
    const late = deliveries.filter((d) => !d.live);
    expect(late).toHaveLength(1);
    const batch = late[0]?.events ?? [];
    expect(batch.every((e) => e.accountHash === backlog?.accountHash)).toBe(true);
    const ids = batch.map((e) => e.eventId);
    expect(ids).not.toEqual([...ids].sort());

    // A session that was live until the drop, then ended inside the backlog.
    const liveBefore = deliveries.filter(
      (d) => d.live && d.sendAt < (late[0]?.sendAt ?? new Date(0)),
    );
    const ended = ofType(batch, 'session.end').find((end) =>
      liveBefore.some((d) =>
        d.events.some((e) => e.sessionId === end.sessionId && e.type === 'session.heartbeat'),
      ),
    );
    expect(ended?.payload.reason).toBe('logout');
    const lastLiveBeat = Math.max(
      ...liveBefore.flatMap((d) =>
        d.events.filter((e) => e.sessionId === ended?.sessionId).map((e) => ms(e.occurredAt)),
      ),
    );
    expect((late[0]?.sendAt.getTime() ?? 0) - lastLiveBeat).toBeGreaterThan(TIMEOUT_MS);
  });

  it('reports stats that match the events', () => {
    const { events, stats, sessions } = seed();
    expect(Object.values(stats.eventsByType).reduce((a, b) => a + b, 0)).toBe(events.length);
    expect(stats.sessions).toBe(sessions.length);
    expect(stats.playSeconds).toBeGreaterThan(stats.afkSeconds);
    expect(stats.xpGained).toBeGreaterThan(0);
    expect(stats.lootGeValue).toBeGreaterThan(0);
    expect(stats.raids.completions).toBe(raidKc(events).length);
    expect(Object.values(stats.raids.byMode).reduce((a, b) => a + b, 0)).toBe(
      stats.raids.completions,
    );
    expect(stats.raids.specialLoot.SELF + stats.raids.specialLoot.TEAMMATE).toBe(
      stats.eventsByType['raid.special_loot'],
    );
  });

  // --- Raids ------------------------------------------------------

  it('has raid completions with KC strictly increasing per mode, and a team size on each', () => {
    const completions = raidKc(seed().events);
    expect(completions.length).toBeGreaterThan(0);
    for (const [, events] of byAccount(seed().events)) {
      const last = new Map<string, number>();
      for (const kc of raidKc(events)) {
        const mode = normalizeBossName(kc.payload.boss);
        expect(kc.payload.killCount).toBeGreaterThan(last.get(mode) ?? 0);
        last.set(mode, kc.payload.killCount);

        const teamSize = kc.payload.teamSize;
        expect(teamSize).toBeDefined();
        expect(teamSize).toBeGreaterThanOrEqual(1);
        const max = { 'Theatre of Blood': 5, 'Tombs of Amascut': 8 }[raidOf(mode)?.name ?? ''];
        expect(teamSize).toBeLessThanOrEqual(max ?? 100);
        expect(kc.payload.timeSeconds).toBeGreaterThan(0);
      }
    }
  });

  it('sends the PB after each timed kill, per boss, or per raid mode and team size', () => {
    for (const [, events] of byAccount(seed().events)) {
      const best = new Map<string, number>();
      for (const kc of ofType(events, 'kc')) {
        const { timeSeconds, personalBest, personalBestSeconds, teamSize } = kc.payload;
        if (timeSeconds === undefined) {
          expect(personalBestSeconds).toBeUndefined();
          continue;
        }
        if (personalBestSeconds === undefined) throw new Error('a timed kill has a PB');
        const key = `${normalizeBossName(kc.payload.boss)}|${String(teamSize)}`;
        const previous = best.get(key);
        expect(personalBestSeconds).toBeLessThanOrEqual(timeSeconds);
        if (previous !== undefined) {
          expect(personalBestSeconds).toBe(Math.min(previous, timeSeconds));
        }
        // A new PB when the kill sets it: the first kill without an older PB,
        // or one faster than the PB before.
        expect(personalBest).toBe(
          personalBestSeconds === timeSeconds && (previous === undefined || timeSeconds < previous),
        );
        best.set(key, personalBestSeconds);
      }
    }
  });

  it('has PBs from before the tracker, lower than every kill sent', () => {
    let older = 0;
    for (const [, events] of byAccount(seed().events)) {
      const fastest = new Map<string, number>();
      const pb = new Map<string, number>();
      for (const kc of ofType(events, 'kc')) {
        const { timeSeconds, personalBestSeconds, teamSize } = kc.payload;
        if (timeSeconds === undefined || personalBestSeconds === undefined) continue;
        const key = `${normalizeBossName(kc.payload.boss)}|${String(teamSize)}`;
        fastest.set(key, Math.min(fastest.get(key) ?? Infinity, timeSeconds));
        pb.set(key, Math.min(pb.get(key) ?? Infinity, personalBestSeconds));
      }
      for (const [key, seconds] of pb) if (seconds < (fastest.get(key) ?? 0)) older++;
    }
    expect(older).toBeGreaterThan(0);
  });

  it('sends a chest loot event with the same kill count for every raid completion', () => {
    const loot = new Set(
      ofType(seed().events, 'loot').map(
        (l) =>
          `${l.sessionId}|${l.occurredAt}|${l.payload.source.name ?? ''}|${String(l.payload.killCount)}`,
      ),
    );
    for (const kc of raidKc(seed().events)) {
      const mode = normalizeBossName(kc.payload.boss);
      expect(
        loot.has(`${kc.sessionId}|${kc.occurredAt}|${mode}|${String(kc.payload.killCount)}`),
      ).toBe(true);
    }
  });

  it('puts every own purple in the chest loot too, and never a teammate’s', () => {
    const groupOf = (name: string) => raidOf(normalizeBossName(name));
    for (const [, events] of bySession(seed().events)) {
      // Purple items in this session's chest loot, not yet matched.
      const chest = ofType(events, 'loot').flatMap((loot) => {
        const raid = groupOf(loot.payload.source.name ?? '');
        if (!raid) return [];
        return loot.payload.items
          .filter((item) => isRaidPurple(raid, item.itemId))
          .map((item) => ({ loot, item, raid, matched: false }));
      });
      for (const special of ofType(events, 'raid.special_loot')) {
        const raid = groupOf(special.payload.raid);
        expect(raid).toBeDefined();
        const { itemId } = special.payload.item;
        const sameTime = chest.filter(
          (c) => c.loot.occurredAt === special.occurredAt && c.item.itemId === itemId,
        );
        if (special.payload.recipient === 'TEAMMATE') {
          expect(sameTime).toEqual([]);
          continue;
        }
        const match = chest.find((c) => !c.matched && c.raid === raid && c.item.itemId === itemId);
        expect(match, `SELF purple ${String(itemId)} without chest loot`).toBeDefined();
        if (!match) continue;
        match.matched = true;
        expect(match.loot.occurredAt).toBe(special.occurredAt);
        expect(match.loot.payload.killCount).toBe(special.payload.killCount);
        expect(match.item.gePrice).toBe(special.payload.item.gePrice);
      }
      // No purple in your loot without your own special loot event.
      expect(chest.filter((c) => !c.matched)).toEqual([]);
    }
  });

  it('never names a teammate: special loot has only the contract fields', () => {
    const specials = ofType(seed().events, 'raid.special_loot');
    const recipients = new Set(specials.map((s) => s.payload.recipient));
    expect(recipients).toEqual(new Set(['SELF', 'TEAMMATE']));
    for (const special of specials) {
      expect(Object.keys(special.payload).sort()).toEqual([
        'item',
        'killCount',
        'raid',
        'recipient',
        'teamSize',
      ]);
      expect(Object.keys(special.payload.item).sort()).toEqual([
        'gePrice',
        'itemId',
        'name',
        'quantity',
      ]);
      const raid = raidOf(normalizeBossName(special.payload.raid));
      expect(raid && isRaidPurple(raid, special.payload.item.itemId)).toBe(true);
      if (special.payload.recipient === 'TEAMMATE') {
        expect(special.payload.teamSize).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('keeps raids to the right accounts and modes', () => {
    const { accounts, events } = seed();
    const modesOf = (profile: string) => {
      const hash = accounts.find((a) => a.profile === profile)?.accountHash;
      return new Set(
        raidKc(events.filter((e) => e.accountHash === hash)).map((kc) =>
          normalizeBossName(kc.payload.boss),
        ),
      );
    };
    // The alt is free-to-play: no raids.
    expect(modesOf('alt')).toEqual(new Set());
    // The iron does no Challenge, Hard or Expert Mode.
    for (const mode of modesOf('iron')) expect(mode).not.toMatch(/Challenge|Hard|Expert/);
    // The Fractured Archive only after its release.
    for (const kc of raidKc(events)) {
      if (raidOf(normalizeBossName(kc.payload.boss))?.name === 'The Fractured Archive') {
        expect(ms(kc.occurredAt)).toBeGreaterThanOrEqual(ms('2026-10-20T10:00:00.000Z'));
      }
    }
  });
});
