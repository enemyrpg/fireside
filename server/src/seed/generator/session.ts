import {
  MINUTE_MS,
  normalizeBossName,
  PB_RECORDS_OVERALL,
  SKILLS,
  type AccountType,
  type Event,
  type LootItem,
  type LootSource,
  type PbRecord,
  type RaidLootRecipient,
  type Skill,
  type SkillValue,
} from '@fireside/shared';
import {
  activity as activityById,
  CLUE_TABLES,
  PVP_LOOT,
  type Activity,
  type DropTable,
  type Range,
} from './activities.js';
import type { BankSim } from './bank.js';
import type { QuestSim } from './quests.js';
import type { Item } from './items.js';
import type { Profile } from './profiles.js';
import { purpleTable, teamTimeFactor, type RaidSpec } from './raids.js';
import type { Rng } from './rng.js';
import type { Block } from './schedule.js';
import { FREE_WORLDS, MEMBERS_WORLDS, type World } from './worlds.js';
import { levelForXp, MAX_XP } from './xp-table.js';

// Simulates sessions minute by minute, the way the plugin reports them:
// heartbeat every 60 s, AFK periods per the AFK rule, XP snapshots at login,
// logout and every 5 minutes if XP changed, loot and KC per kill.

export const PLUGIN_VERSION = '0.1.0';
/** The plugin's AFK threshold: an AFK period is at least this long. */
export const AFK_THRESHOLD_MS = 5 * MINUTE_MS;
const SNAPSHOT_EVERY_MINUTES = 5;

/** `type` + `payload` of an event, before IDs and envelope are added. */
export type EventBody = Event extends infer E
  ? E extends Event
    ? { type: E['type']; payload: E['payload'] }
    : never
  : never;

export interface Draft {
  ms: number;
  account: number;
  /** Emission order: game order for events in the same millisecond. */
  seq: number;
  sessionKey: string;
  body: EventBody;
}

export type SessionEnd = 'logout' | 'client_closed' | 'hop' | 'crash' | 'open';

export interface SessionRecord {
  key: string;
  account: number;
  startMs: number;
  /** `session.end` time, or the last heartbeat if there is none. */
  endMs: number;
  end: SessionEnd;
  world: number;
  afkMs: number;
}

export interface AccountState {
  index: number;
  profile: Profile;
  accountHash: string;
  rng: Rng;
  xp: Record<Skill, number>;
  /** KC per normalized boss name. */
  kc: Map<string, number>;
  /** Best time per normalized boss; for raids per `${mode}|${teamSize}`. */
  bestSeconds: Map<string, number>;
  sessions: number;
  nameAt: (ms: number) => string;
  typeAt: (ms: number) => AccountType;
  /** Bank, inventory, equipment and potion storage (own RNG). */
  bank: BankSim;
  /** Quest and diary progress (own RNG). */
  quests: QuestSim;
}

export interface SimOutput {
  drafts: Draft[];
  sessions: SessionRecord[];
  seq: number;
}

function emit(out: SimOutput, state: AccountState, key: string, ms: number, body: EventBody) {
  out.drafts.push({ ms, account: state.index, seq: out.seq++, sessionKey: key, body });
}

function skillsPayload(xp: Record<Skill, number>): Record<Skill, SkillValue> {
  return Object.fromEntries(
    SKILLS.map((skill) => [skill, { xp: xp[skill], level: levelForXp(xp[skill]) }]),
  ) as Record<Skill, SkillValue>;
}

function totalXp(xp: Record<Skill, number>): number {
  return SKILLS.reduce((sum, skill) => sum + xp[skill], 0);
}

/** Rolls a drop table. Same items are merged, in first-seen order. Never empty. */
export function rollDrops(table: DropTable, rng: Rng): LootItem[] {
  const items = new Map<number, LootItem>();
  const add = (item: Item, quantity: number) => {
    const existing = items.get(item.id);
    if (existing) existing.quantity += quantity;
    else
      items.set(item.id, {
        itemId: item.id,
        name: item.name,
        quantity,
        gePrice: item.ge,
        haPrice: item.ha,
      });
  };
  for (const drop of table.always ?? []) add(drop.item, rng.int(...drop.quantity));
  const rolls = table.common.length > 0 ? rng.int(...table.rolls) : 0;
  for (let i = 0; i < rolls; i++) {
    const drop = rng.weighted(table.common.map((entry) => [entry, entry.weight] as const));
    add(drop.item, rng.int(...drop.quantity));
  }
  for (const rare of table.rare ?? []) {
    if (rng.chance(1 / rare.oneIn)) add(rare.item, rng.int(...rare.quantity));
  }
  if (items.size === 0) {
    // Zero rolls and no "always" items: drop the first common item.
    const fallback = table.common[0];
    if (!fallback) throw new Error('Drop table without items');
    add(fallback.item, fallback.quantity[0]);
  }
  return [...items.values()];
}

/** A weighted activity that fits a block of `minutes` starting at `ms`. */
function pickActivity(state: AccountState, minutes: number, ms: number): Activity {
  const fits = state.profile.activities.filter(([id]) => {
    const candidate = activityById(id);
    return (
      (candidate.minBlockMinutes ?? 0) <= minutes && (candidate.availableFrom ?? -Infinity) <= ms
    );
  });
  return activityById(state.rng.weighted(fits));
}

function pickWorld(state: AccountState, activity: Activity, not?: World): World {
  const pool = (state.profile.members && activity.members ? MEMBERS_WORLDS : FREE_WORLDS).filter(
    (world) => world.number !== not?.number,
  );
  return state.rng.pick(pool);
}

/** Simulates one block: one session, or several with world hops in between. */
export function simulateBlock(state: AccountState, block: Block, out: SimOutput): void {
  const rng = state.rng;
  const cuts: number[] = [];
  if (
    !block.noHop &&
    block.minutes >= 20 &&
    (block.forceHop || rng.chance(state.profile.hopChance))
  ) {
    cuts.push(rng.int(8, block.minutes - 8));
  }
  const bounds = [0, ...cuts, block.minutes];

  let activity =
    block.activity === undefined
      ? pickActivity(state, block.minutes, block.startMs)
      : activityById(block.activity);
  // Forced purples are used up over the whole block.
  const purples = [...(block.forcePurples ?? [])];
  let world = pickWorld(state, activity);
  let startMs = block.startMs;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const minutes = (bounds[i + 1] ?? 0) - (bounds[i] ?? 0);
    const last = i + 2 === bounds.length;
    let end: SessionEnd;
    if (!last) end = 'hop';
    else if (block.end === 'crash' || block.end === 'open') end = block.end;
    else if (block.endReason) end = block.endReason;
    else end = rng.chance(state.profile.clientClosedChance) ? 'client_closed' : 'logout';

    const forcePvp = block.forcePvp === true && i === 0;
    const endMs = simulateSession(state, startMs, minutes, world, activity, end, forcePvp, out, {
      purples,
    });
    if (!last) {
      // The new session starts within a minute of the hop.
      startMs = endMs + rng.int(3_000, 20_000);
      if (block.activity === undefined && rng.chance(0.3)) {
        activity = pickActivity(state, block.minutes - (bounds[i + 1] ?? 0), startMs);
      }
      world = pickWorld(state, activity, world);
    }
  }
}

interface Interval {
  from: number;
  to: number;
}

interface RaidContext {
  /** Recipients of the next forced purples (shared by the sessions of a block). */
  purples: RaidLootRecipient[];
}

/** The next raid completion: team and raid time, rolled before it starts. */
interface RaidRun {
  teamSize: number;
  timeSeconds: number;
}

/** Same team most of the time; a forced teammate purple needs a team. */
function rollRaidRun(
  rng: Rng,
  raid: RaidSpec,
  killSeconds: Range,
  previous: RaidRun | undefined,
  purples: readonly RaidLootRecipient[],
): RaidRun {
  let teamSize =
    previous !== undefined && !rng.chance(0.15) ? previous.teamSize : rng.weighted(raid.teamSizes);
  if (purples[0] === 'TEAMMATE' && teamSize < 2) {
    const teams = raid.teamSizes.filter(([size]) => size >= 2);
    teamSize = teams.length > 0 ? rng.weighted(teams) : 2;
  }
  // Game ticks are 0.6 s.
  const ticks = Math.round((rng.float(...killSeconds) * teamTimeFactor(teamSize)) / 0.6);
  return { teamSize, timeSeconds: Math.round(ticks * 6) / 10 };
}

/** Simulates one session. Returns the time it ended (or the last heartbeat). */
function simulateSession(
  state: AccountState,
  startMs: number,
  minutes: number,
  world: World,
  activity: Activity,
  end: SessionEnd,
  forcePvp: boolean,
  out: SimOutput,
  raidContext: RaidContext,
): number {
  const rng = state.rng;
  const profile = state.profile;
  const afkPerMinute = profile.afkPerMinute * (activity.afkFactor ?? 1);
  const key = `${String(state.index)}:${String(state.sessions++)}`;
  /** Loot of this session, deposited when the bank closes at the end. */
  const loot: LootItem[] = [];
  const send = (ms: number, body: EventBody) => {
    if (body.type === 'loot') loot.push(...body.payload.items);
    emit(out, state, key, ms, body);
  };
  // Banking uses the bank's own RNG, so it never changes the other events.
  const closeBank = (ms: number) => {
    const { bank, potionStorage } = state.bank.close(ms);
    if (bank) send(ms, { type: 'bank.snapshot', payload: bank });
    if (potionStorage) send(ms, { type: 'potion_storage.snapshot', payload: potionStorage });
  };
  // Quests and diaries use their own RNG too. Sent only when changed.
  const sendQuests = (ms: number) => {
    const { quests, diaries } = state.quests.changed();
    if (quests) send(ms, { type: 'quests.snapshot', payload: quests });
    if (diaries) send(ms, { type: 'diaries.snapshot', payload: diaries });
  };
  const questMinute = state.quests.planSession(minutes);
  const pvm = activity.kills !== undefined;

  send(startMs, {
    type: 'session.start',
    payload: {
      displayName: state.nameAt(startMs),
      accountType: state.typeAt(startMs),
      world: world.number,
      pluginVersion: PLUGIN_VERSION,
    },
  });
  send(startMs, {
    type: 'xp.snapshot',
    payload: { reason: 'login', skills: skillsPayload(state.xp) },
  });
  let snapshotTotal = totalXp(state.xp);
  // After login: only if something changed since the account's last snapshot.
  sendQuests(startMs + 2_000);
  if (pvm) {
    state.bank.startTrip(true);
    closeBank(startMs + 20_000);
  }

  // Sometimes the world list isn't loaded yet for the first heartbeats.
  const unloadedMinutes = rng.chance(0.25) ? rng.int(1, 2) : 0;
  let region = rng.pick(activity.regions);
  const kills = activity.kills;
  const raid = kills?.raid;
  const rollRun = (previous: RaidRun | undefined): RaidRun | undefined =>
    raid && kills.killSeconds
      ? rollRaidRun(rng, raid, kills.killSeconds, previous, raidContext.purples)
      : undefined;
  // A raid completion takes its raid time plus lobby and banking.
  let run = rollRun(undefined);
  const killMs = (): number =>
    raid && run
      ? (run.timeSeconds + rng.float(...raid.overheadMinutes) * 60) * 1000
      : rng.float(...(kills?.minutes ?? [1, 1])) * MINUTE_MS;
  let killLeftMs = kills ? killMs() : Infinity;
  let pvpMinute =
    activity.pvpLootChance !== undefined && (forcePvp || rng.chance(activity.pvpLootChance))
      ? rng.int(1, Math.max(1, minutes - 1))
      : -1;

  let afk: Interval | null = null;
  let afkMs = 0;
  let previousHb = startMs;

  for (let minute = 1; minute <= minutes; minute++) {
    const hb = startMs + minute * MINUTE_MS + rng.int(0, 400);

    // AFK starts at the last activity and lasts at least the threshold. It
    // always ends before the session does.
    if (afk === null && rng.chance(afkPerMinute)) {
      const length = rng.int(...profile.afkMinutes) * MINUTE_MS + rng.int(0, 59_000);
      const from = previousHb + rng.int(1_000, 50_000);
      if (from + length < startMs + (minutes - 1) * MINUTE_MS) afk = { from, to: from + length };
    }

    // Active time this minute: (previousHb, hb] minus the AFK period.
    const active: Interval[] = [];
    if (afk === null || afk.from >= hb || afk.to <= previousHb) {
      active.push({ from: previousHb, to: hb });
    } else {
      if (afk.from > previousHb) active.push({ from: previousHb, to: afk.from });
      if (afk.to < hb) active.push({ from: afk.to, to: hb });
    }
    const activeMs = active.reduce((sum, part) => sum + part.to - part.from, 0);

    // XP for the active part of the minute.
    if (activeMs > 0) {
      for (const [skill, perHour] of Object.entries(activity.xpPerHour) as [Skill, number][]) {
        const gain = Math.round(((perHour * activeMs) / 3_600_000) * rng.float(0.8, 1.2));
        state.xp[skill] = Math.min(MAX_XP, state.xp[skill] + gain);
      }
    }

    // Kills happen during active time only.
    for (const part of active) {
      let cursor = part.from;
      while (kills && cursor + killLeftMs <= part.to) {
        cursor += killLeftMs;
        const at = Math.max(Math.round(cursor), part.from + 1);
        if (run) {
          recordRaid(state, activity, at, send, run, raidContext.purples);
          run = rollRun(run);
        } else {
          recordKill(state, activity, at, send);
        }
        killLeftMs = killMs();
      }
      if (kills) killLeftMs -= part.to - cursor;
    }

    // Clues and player kills, at a random active moment.
    const activeAt = (): number | undefined => {
      const part = active.find((p) => p.to - p.from > 2);
      return part ? rng.int(part.from + 1, part.to) : undefined;
    };
    if (
      activity.clue &&
      activeMs > 0 &&
      rng.chance((activity.clue.perHour * activeMs) / 3_600_000)
    ) {
      const at = activeAt();
      if (at !== undefined) {
        const tier = activity.clue.tier;
        sendLoot(
          send,
          at,
          { type: 'CLUE', name: `Clue Scroll (${capitalize(tier)})` },
          rollDrops(CLUE_TABLES[tier], rng),
        );
      }
    }
    if (minute === pvpMinute) {
      const at = activeAt();
      // Away from the keyboard: the fight happens in the next active minute.
      if (at === undefined) pvpMinute += 1;
      else sendLoot(send, at, { type: 'PLAYER', name: null }, rollDrops(PVP_LOOT, rng));
    }

    // The AFK event is sent when the period is over.
    if (afk !== null && afk.to <= hb) {
      send(afk.to, { type: 'session.afk', payload: afkPayload(afk) });
      afkMs += afk.to - afk.from;
      afk = null;
    }

    if (rng.chance(0.08)) region = rng.pick(activity.regions);
    const loaded = minute > unloadedMinutes;
    send(hb, {
      type: 'session.heartbeat',
      payload: {
        regionId: region,
        world: world.number,
        worldTypes: [...world.types],
        worldLocation: loaded ? world.location : null,
        worldActivity: loaded ? world.activity : null,
        idle: afk !== null && afk.from <= hb,
      },
    });

    if (minute % SNAPSHOT_EVERY_MINUTES === 0 && totalXp(state.xp) !== snapshotTotal) {
      send(hb, {
        type: 'xp.snapshot',
        payload: { reason: 'interval', skills: skillsPayload(state.xp) },
      });
      snapshotTotal = totalXp(state.xp);
    }
    if (minute === questMinute) {
      state.quests.advance();
      sendQuests(hb + 3_000);
    }
    previousHb = hb;
  }

  // A change just before the client closes may not be sent until the next login.
  if (end === 'client_closed') state.quests.advanceUnsent();

  // A last bank visit before logging out (crashed sessions too).
  if (minutes >= 2) {
    state.bank.endTrip(loot, pvm);
    closeBank(previousHb - 15_000);
  }

  let endMs = previousHb;
  if (end === 'logout' || end === 'client_closed' || end === 'hop') {
    endMs = previousHb + rng.int(2_000, 40_000);
    if (end !== 'client_closed') {
      send(endMs, {
        type: 'xp.snapshot',
        payload: { reason: 'logout', skills: skillsPayload(state.xp) },
      });
    }
    send(endMs, { type: 'session.end', payload: { reason: end } });
  }
  out.sessions.push({ key, account: state.index, startMs, endMs, end, world: world.number, afkMs });
  return endMs;
}

function afkPayload(afk: Interval) {
  return { startedAt: new Date(afk.from).toISOString(), endedAt: new Date(afk.to).toISOString() };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function sendLoot(
  send: (ms: number, body: EventBody) => void,
  at: number,
  source: LootSource,
  items: LootItem[],
  killCount?: number,
) {
  send(at, {
    type: 'loot',
    payload: { source, items, ...(killCount === undefined ? {} : { killCount }) },
  });
}

/** A time in seconds, rounded to whole game ticks (0.6 s). */
function toTicks(seconds: number): number {
  return Math.round(Math.round(seconds / 0.6) * 6) / 10;
}

/**
 * The PB an account with kills from before the tracker already has: a bit
 * under the fastest time the activity rolls, so the seed has PBs lower than
 * any kill it sends (the case `kc.personalBestSeconds` exists for).
 */
function olderPb(fastestSeconds: number): number {
  return toTicks(fastestSeconds * 0.9);
}

interface KillTiming {
  timeSeconds: number;
  personalBest: boolean;
  /** The PB after this kill, as the game reports it (contract 1.14.0). */
  personalBestSeconds: number;
}

/**
 * Timing of one kill, and updates the best time for `key`. The PB starts at
 * `oldBest` (kills from before the tracker) the first time `key` is seen.
 * Without one, the first kill is a new PB, as in the game.
 */
function killTiming(
  state: AccountState,
  key: string,
  timeSeconds: number,
  oldBest: number | undefined,
): KillTiming {
  const best = state.bestSeconds.get(key) ?? oldBest;
  const personalBest = best === undefined || timeSeconds < best;
  const personalBestSeconds = personalBest ? timeSeconds : best;
  state.bestSeconds.set(key, personalBestSeconds);
  return { timeSeconds, personalBest, personalBestSeconds };
}

/** One kill: a KC message (bosses) and maybe loot, with the same kill count. */
function recordKill(
  state: AccountState,
  activity: Activity,
  at: number,
  send: (ms: number, body: EventBody) => void,
) {
  const kills = activity.kills;
  if (!kills) return;
  const rng = state.rng;
  let killCount: number | undefined;
  if (kills.kcNames) {
    const name = rng.weighted(kills.kcNames);
    const boss = normalizeBossName(name);
    const previousKc = state.kc.get(boss) ?? startingKc(state, activity);
    killCount = previousKc + 1;
    state.kc.set(boss, killCount);

    let timing: KillTiming | undefined;
    if (kills.killSeconds) {
      const timeSeconds = toTicks(rng.float(...kills.killSeconds));
      const oldBest = previousKc > 0 ? olderPb(kills.killSeconds[0]) : undefined;
      timing = killTiming(state, boss, timeSeconds, oldBest);
    }
    send(at, { type: 'kc', payload: { boss: name, killCount, ...timing } });
  }
  if (rng.chance(kills.lootChance)) {
    sendLoot(send, at, kills.source, rollDrops(kills.drops, rng), killCount);
  }
}

/**
 * One raid completion: KC with time and team size, the chest loot with the
 * same kill count, and maybe a purple. Your own purple is in the chest loot
 * and in a `raid.special_loot` (SELF); a teammate's purple is only a
 * `raid.special_loot` (TEAMMATE), never in your loot, and never with a name.
 */
function recordRaid(
  state: AccountState,
  activity: Activity,
  at: number,
  send: (ms: number, body: EventBody) => void,
  run: RaidRun,
  purples: RaidLootRecipient[],
) {
  const kills = activity.kills;
  const raid = kills?.raid;
  if (!kills?.kcNames || !raid) return;
  const rng = state.rng;
  const name = rng.weighted(kills.kcNames);
  const mode = normalizeBossName(name);
  const previousKc = state.kc.get(mode) ?? startingKc(state, activity);
  const killCount = previousKc + 1;
  state.kc.set(mode, killCount);

  // Raid PBs are per mode and team size, as in the game.
  const { teamSize, timeSeconds } = run;
  const oldBest =
    previousKc > 0 && kills.killSeconds
      ? olderPb(kills.killSeconds[0] * teamTimeFactor(teamSize))
      : undefined;
  const timing = killTiming(state, `${mode}|${String(teamSize)}`, timeSeconds, oldBest);
  send(at, { type: 'kc', payload: { boss: name, killCount, ...timing, teamSize } });

  const items = rollDrops(kills.drops, rng);
  let recipient: RaidLootRecipient | undefined = purples.shift();
  if (recipient === undefined && rng.chance(1 / raid.purpleOneIn)) {
    recipient = teamSize === 1 || rng.chance(1 / teamSize) ? 'SELF' : 'TEAMMATE';
  }
  const purple = recipient === undefined ? undefined : rng.weighted(purpleTable(raid.raid));
  if (purple && recipient === 'SELF') {
    items.push({
      itemId: purple.id,
      name: purple.name,
      quantity: 1,
      gePrice: purple.ge,
      haPrice: purple.ha,
    });
  }
  sendLoot(send, at, kills.source, items, killCount);
  if (purple && recipient) {
    send(at, {
      type: 'raid.special_loot',
      payload: {
        raid: name,
        item: { itemId: purple.id, name: purple.name, quantity: 1, gePrice: purple.ge },
        recipient,
        teamSize,
        killCount,
      },
    });
  }
  // After a new PB the player opens the records table: every team size's
  // overall PB so far (no RNG draws, so the rest of the seed is unchanged).
  if (raid.recordsTable && timing.personalBest) {
    send(at, { type: 'pb.records', payload: { boss: name, records: overallRecords(state, mode) } });
  }
}

/** Overall PB per team size for a raid mode, from the best times so far, by team size. */
function overallRecords(state: AccountState, mode: string): PbRecord[] {
  const records: PbRecord[] = [];
  for (const [key, seconds] of state.bestSeconds) {
    const [keyMode, size] = key.split('|');
    if (keyMode === mode && size !== undefined) {
      records.push({ scope: PB_RECORDS_OVERALL, teamSize: Number(size), seconds });
    }
  }
  return records.sort((a, b) => a.teamSize - b.teamSize);
}

/**
 * KC before the first kill seen in the window: the main has history. Content
 * released during the window starts at zero.
 */
function startingKc(state: AccountState, activity?: Activity): number {
  if (activity?.availableFrom !== undefined) return 0;
  switch (state.profile.key) {
    case 'main':
      return state.rng.int(50, 900);
    case 'iron':
      return state.rng.int(0, 120);
    case 'alt':
      return 0;
  }
}
