import {
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  normalizeBossName,
  RAID_LOOT_RECIPIENTS,
  raidOf,
  RAIDS,
  SKILLS,
  type Event,
  type EventType,
  type RaidLootRecipient,
  type Skill,
} from '@fireside/shared';
import { BankSim } from './bank.js';
import { PROFILES, type Profile } from './profiles.js';
import { QuestSim } from './quests.js';
import { simulateCollectionLog, type SeedCollectionLog } from './clog.js';
import { petDropDrafts } from './pets.js';
import { createRng, type Rng } from './rng.js';
import { buildScenario, type Backlog } from './scenario.js';
import { planBlocks } from './schedule.js';
import {
  simulateBlock,
  type AccountState,
  type Draft,
  type SessionEnd,
  type SessionRecord,
  type SimOutput,
} from './session.js';
import { MonotonicUuidV7 } from './uuid.js';
import { xpForLevel } from './xp-table.js';

// Generates realistic simulated plugin events for `pnpm seed`.
// A pure function of its options: the same options give the same events,
// IDs included.

export const MIN_ACCOUNTS = 2;
export const MAX_ACCOUNTS = 3;

export interface SeedOptions {
  seed: number;
  /** 2 or 3 accounts (main, iron, alt). */
  accounts: number;
  /** Length of the window, in months before `until`. */
  months: number;
  /** End of the window. No event is later than this. */
  until: Date;
  /** IANA time zone for play patterns (TZ from .env). */
  timeZone: string;
}

/** Events the plugin would send in one request, and when. */
export interface Delivery {
  sendAt: Date;
  /** `false` for the offline backlog, which arrives late and shuffled. */
  live: boolean;
  events: Event[];
}

export interface SeedAccount {
  accountHash: string;
  /** Name and type at the end of the window. */
  displayName: string;
  accountType: string;
  profile: Profile['key'];
}

export interface SeedSession {
  sessionId: string;
  accountHash: string;
  startedAt: string;
  /** `session.end` time, or the last heartbeat for crashed and open sessions. */
  endedAt: string;
  end: SessionEnd;
  world: number;
  afkSeconds: number;
}

export interface SeedRaidStats {
  /** Raid KC messages, all accounts. */
  completions: number;
  /** Completions per normalized mode, in `RAIDS` order; modes without any are left out. */
  byMode: Record<string, number>;
  /** `raid.special_loot` events per recipient. */
  specialLoot: Record<RaidLootRecipient, number>;
}

export interface SeedStats {
  sessions: number;
  sessionsByEnd: Record<SessionEnd, number>;
  eventsByType: Record<EventType, number>;
  /** Sum of session lengths (start to end or last heartbeat). */
  playSeconds: number;
  afkSeconds: number;
  /** XP gained in the window, all accounts. */
  xpGained: number;
  /** GE value of all loot. */
  lootGeValue: number;
  raids: SeedRaidStats;
}

export interface SeedData {
  from: Date;
  until: Date;
  accounts: SeedAccount[];
  /** All events in game order (`occurredAt`, then `eventId`). */
  events: Event[];
  /** In send order. Each event is in exactly one delivery. */
  deliveries: Delivery[];
  sessions: SeedSession[];
  backlog: { accountHash: string; from: string; to: string } | null;
  /**
   * Collection logs as an external source would give them. Not events: they
   * never go through ingest (see `generator/clog.ts` and `seed/clog.ts`).
   */
  collectionLogs: SeedCollectionLog[];
  stats: SeedStats;
}

/** The plugin flushes its queue every 30 seconds. */
const FLUSH_MS = 30_000;

export function validateSeedOptions(options: SeedOptions): void {
  const { seed, accounts, months, until } = options;
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError('seed must be an integer >= 0');
  if (!Number.isInteger(accounts) || accounts < MIN_ACCOUNTS || accounts > MAX_ACCOUNTS) {
    throw new RangeError(`accounts must be ${String(MIN_ACCOUNTS)}–${String(MAX_ACCOUNTS)}`);
  }
  if (!(months > 0 && months <= 24)) throw new RangeError('months must be > 0 and at most 24');
  if (Number.isNaN(until.getTime())) throw new RangeError('until must be a valid date');
}

/** Start of the window: `months` calendar months before `until` (fractions in 30-day steps). */
export function windowStart(until: Date, months: number): Date {
  const whole = Math.floor(months);
  const start = new Date(until.getTime());
  start.setUTCMonth(start.getUTCMonth() - whole);
  return new Date(start.getTime() - Math.round((months - whole) * 30 * 86_400_000));
}

function accountHash(rng: Rng, negative: boolean): string {
  const digits = `${String(rng.int(100_000_000, 999_999_999))}${String(rng.int(1_000_000_000, 9_999_999_999))}`;
  return negative ? `-${digits}` : digits;
}

function startXp(profile: Profile, rng: Rng): Record<Skill, number> {
  return Object.fromEntries(
    SKILLS.map((skill) => {
      const level = Math.max(skill === 'HITPOINTS' ? 10 : 1, profile.startLevels[skill] ?? 1);
      if (level === 1) return [skill, 0];
      const span = level >= 99 ? 4_000_000 : xpForLevel(level + 1) - xpForLevel(level) - 1;
      return [skill, xpForLevel(level) + rng.int(0, span)];
    }),
  ) as Record<Skill, number>;
}

function compareDrafts(a: Draft, b: Draft): number {
  return a.ms - b.ms || a.account - b.account || a.seq - b.seq;
}

export function generateSeed(options: SeedOptions): SeedData {
  validateSeedOptions(options);
  const { seed, accounts, timeZone } = options;
  const untilMs = options.until.getTime();
  const fromMs = windowStart(options.until, options.months).getTime();
  const root = createRng(seed);
  const profiles = PROFILES.slice(0, accounts);

  const planned = profiles.map((profile) =>
    planBlocks(profile, fromMs, untilMs, timeZone, root.fork(`schedule:${profile.key}`)),
  );
  const scenario = buildScenario(
    profiles,
    planned,
    fromMs,
    untilMs,
    timeZone,
    root.fork('scenario'),
  );

  // --- Simulate ------------------------------------------------------------
  const out: SimOutput = { drafts: [], sessions: [], seq: 0 };
  const states: AccountState[] = profiles.map((profile, index) => {
    const rng = root.fork(`account:${profile.key}`);
    return {
      index,
      profile,
      accountHash: accountHash(rng, profile.key === 'main'),
      rng,
      xp: startXp(profile, rng),
      kc: new Map(),
      bestSeconds: new Map(),
      sessions: 0,
      nameAt: (ms) => scenario.nameAt(index, ms),
      typeAt: (ms) => scenario.typeAt(index, ms),
      bank: new BankSim(profile, root.fork(`bank:${profile.key}`)),
      quests: new QuestSim(profile, root.fork(`quests:${profile.key}`)),
    };
  });
  const startTotals = states.map((state) => SKILLS.reduce((sum, s) => sum + state.xp[s], 0));
  states.forEach((state, index) => {
    for (const block of scenario.blocks[index] ?? []) simulateBlock(state, block, out);
  });

  // Pet drops: own random streams and (below) own IDs, so every other event
  // is the same with or without them.
  const simulated = out.drafts.filter((draft) => draft.ms <= untilMs).sort(compareDrafts);
  const takenMs = new Set(simulated.map((draft) => draft.ms));
  const petDrops = states.flatMap((state) =>
    petDropDrafts(
      state.profile,
      simulated.filter((draft) => draft.account === state.index),
      root.fork(`pets:${state.profile.key}`),
      takenMs,
      untilMs,
      () => out.seq++,
    ),
  );

  // --- IDs: one monotonic generator in game order --------------------------
  const drafts = [...simulated, ...petDrops].sort(compareDrafts);
  const ids = new MonotonicUuidV7(root.fork('ids'));
  const petIds = new MonotonicUuidV7(root.fork('ids:pets'));
  const sessionIds = new Map<string, string>();
  const events: Event[] = drafts.map((draft) => {
    let sessionId = sessionIds.get(draft.sessionKey);
    if (sessionId === undefined) {
      // The plugin makes the session ID at login, just before the first event.
      sessionId = ids.next(draft.ms);
      sessionIds.set(draft.sessionKey, sessionId);
    }
    const state = states[draft.account];
    if (!state) throw new Error(`No account ${String(draft.account)}`);
    // The envelope is the same for every type; TypeScript can't pair `type`
    // and `payload` through the spread, hence the cast.
    return {
      eventId: (draft.body.type === 'pet.drop' ? petIds : ids).next(draft.ms),
      schemaVersion: EVENT_SCHEMA_VERSION,
      type: draft.body.type,
      accountHash: state.accountHash,
      occurredAt: new Date(draft.ms).toISOString(),
      sessionId,
      payload: draft.body.payload,
    } as Event;
  });

  const deliveries = planDeliveries(
    events,
    drafts,
    scenario.backlog,
    untilMs,
    root.fork('deliveries'),
  );
  const sessions = out.sessions.flatMap((record) => toSeedSession(record, sessionIds, states));

  const accountsOut: SeedAccount[] = states.map((state) => ({
    accountHash: state.accountHash,
    displayName: scenario.nameAt(state.index, untilMs),
    accountType: scenario.typeAt(state.index, untilMs),
    profile: state.profile.key,
  }));
  const xpGained = states.reduce(
    (sum, state, index) =>
      sum + SKILLS.reduce((s, skill) => s + state.xp[skill], 0) - (startTotals[index] ?? 0),
    0,
  );

  // Its own random streams, so the events above are the same with or without it.
  const collectionLogs = states.flatMap((state) => {
    const log = simulateCollectionLog(
      state.profile,
      state.accountHash,
      fromMs,
      untilMs,
      out.sessions.filter((record) => record.account === state.index),
      root.fork(`clog:${state.profile.key}`),
    );
    return log ? [log] : [];
  });

  const backlogAccount = scenario.backlog ? states[scenario.backlog.account] : undefined;
  return {
    from: new Date(fromMs),
    until: new Date(untilMs),
    accounts: accountsOut,
    events,
    deliveries,
    sessions,
    backlog:
      scenario.backlog && backlogAccount
        ? {
            accountHash: backlogAccount.accountHash,
            from: new Date(scenario.backlog.fromMs).toISOString(),
            to: new Date(scenario.backlog.toMs).toISOString(),
          }
        : null,
    collectionLogs,
    stats: computeStats(events, sessions, xpGained),
  };
}

function toSeedSession(
  record: SessionRecord,
  sessionIds: ReadonlyMap<string, string>,
  states: readonly AccountState[],
): SeedSession[] {
  const sessionId = sessionIds.get(record.key);
  const state = states[record.account];
  if (sessionId === undefined || !state) return [];
  return [
    {
      sessionId,
      accountHash: state.accountHash,
      startedAt: new Date(record.startMs).toISOString(),
      endedAt: new Date(record.endMs).toISOString(),
      end: record.end,
      world: record.world,
      afkSeconds: Math.floor(record.afkMs / 1000),
    },
  ];
}

/**
 * Live events go out at the next 30-second flush after they happen. The
 * backlog account's events in the offline period go out together when it
 * reconnects, in shuffled order.
 */
function planDeliveries(
  events: readonly Event[],
  drafts: readonly Draft[],
  backlog: Backlog | null,
  untilMs: number,
  rng: Rng,
): Delivery[] {
  const live: Delivery[] = [];
  const late: Event[] = [];
  let current: Delivery | undefined;
  events.forEach((event, index) => {
    const draft = drafts[index];
    if (!draft) return;
    if (
      backlog?.account === draft.account &&
      draft.ms >= backlog.fromMs &&
      draft.ms < backlog.toMs
    ) {
      late.push(event);
      return;
    }
    const sendAt = Math.min(untilMs, (Math.floor(draft.ms / FLUSH_MS) + 1) * FLUSH_MS);
    if (current?.sendAt.getTime() !== sendAt) {
      current = { sendAt: new Date(sendAt), live: true, events: [] };
      live.push(current);
    }
    current.events.push(event);
  });
  if (!backlog || late.length === 0) return live;

  const delivery: Delivery = {
    sendAt: new Date(backlog.toMs),
    live: false,
    events: rng.shuffle(late),
  };
  const at = live.findIndex((d) => d.sendAt.getTime() > backlog.toMs);
  return at < 0 ? [...live, delivery] : [...live.slice(0, at), delivery, ...live.slice(at)];
}

function computeStats(
  events: readonly Event[],
  sessions: readonly SeedSession[],
  xpGained: number,
): SeedStats {
  const eventsByType = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])) as Record<
    EventType,
    number
  >;
  let lootGeValue = 0;
  const modeCounts = new Map<string, number>();
  const specialLoot = Object.fromEntries(RAID_LOOT_RECIPIENTS.map((r) => [r, 0])) as Record<
    RaidLootRecipient,
    number
  >;
  for (const event of events) {
    eventsByType[event.type] += 1;
    if (event.type === 'loot') {
      for (const item of event.payload.items) lootGeValue += item.quantity * item.gePrice;
    } else if (event.type === 'kc') {
      const mode = normalizeBossName(event.payload.boss);
      if (raidOf(mode)) modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);
    } else if (event.type === 'raid.special_loot') {
      specialLoot[event.payload.recipient] += 1;
    }
  }
  const byMode: Record<string, number> = {};
  for (const mode of RAIDS.flatMap((raid) => raid.modes)) {
    const count = modeCounts.get(mode.name);
    if (count !== undefined) byMode[mode.name] = count;
  }
  const raids: SeedRaidStats = {
    completions: [...modeCounts.values()].reduce((sum, n) => sum + n, 0),
    byMode,
    specialLoot,
  };
  const sessionsByEnd: Record<SessionEnd, number> = {
    logout: 0,
    client_closed: 0,
    hop: 0,
    crash: 0,
    open: 0,
  };
  let playSeconds = 0;
  let afkSeconds = 0;
  for (const session of sessions) {
    sessionsByEnd[session.end] += 1;
    playSeconds += Math.floor((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000);
    afkSeconds += session.afkSeconds;
  }
  return {
    sessions: sessions.length,
    sessionsByEnd,
    eventsByType,
    playSeconds,
    afkSeconds,
    xpGained,
    lootGeValue,
    raids,
  };
}
