import {
  addDays,
  daysBetween,
  fromLocal,
  MINUTE_MS,
  toLocal,
  weekdayOf,
  type LocalDate,
  type RaidLootRecipient,
} from '@fireside/shared';
import type { Profile } from './profiles.js';
import type { Rng } from './rng.js';

// When an account plays: blocks of continuous play, planned in local time.
// A block becomes one session, or several when the player hops worlds.

export type BlockEnd = 'normal' | 'crash' | 'open';

export interface Block {
  startMs: number;
  /** Heartbeat minutes in the block. */
  minutes: number;
  /** `normal` = logout or client_closed (decided later), `crash` = no session.end, `open` = still playing at `until`. */
  end: BlockEnd;
  /** Never split by world hops (scripted blocks that must stay one session). */
  noHop?: boolean;
  /** Fixed end reason for a `normal` block, instead of a random one. */
  endReason?: 'logout' | 'client_closed';
  /** Always has one world hop (needs at least 20 minutes). */
  forceHop?: boolean;
  /** Activity for the whole block instead of a random one. */
  activity?: string;
  /** Always has a player kill (wilderness activity). */
  forcePvp?: boolean;
  /** Raid blocks: the first purples go to these recipients, in order. */
  forcePurples?: readonly RaidLootRecipient[];
}

/** Windows shorter than this get no holiday, so short runs keep every edge case. */
const MIN_DAYS_FOR_HOLIDAY = 42;

/** Smallest gap between two blocks of the same account. */
export const MIN_GAP_MS = 5 * MINUTE_MS;

export function blockEndMs(block: Block): number {
  // A minute per heartbeat plus a little slack for logout.
  return block.startMs + (block.minutes + 1) * MINUTE_MS;
}

function hourToMinutes(hour: number): [number, number] {
  const total = Math.round(hour * 60);
  return [Math.floor(total / 60), total % 60];
}

/** Plans play blocks in [fromMs, untilMs) for one account. */
export function planBlocks(
  profile: Profile,
  fromMs: number,
  untilMs: number,
  timeZone: string,
  rng: Rng,
): Block[] {
  const pattern = profile.pattern;
  const first: LocalDate = toLocal(fromMs, timeZone);
  const last: LocalDate = toLocal(untilMs, timeZone);
  const days = daysBetween(first, last);

  // One holiday in the middle half of the window.
  const holidayLength = days >= MIN_DAYS_FOR_HOLIDAY ? rng.int(...pattern.holidayDays) : 0;
  const holidayStart = Math.floor(days * rng.float(0.25, 0.6));

  const blocks: Block[] = [];
  const add = (date: LocalDate, hour: number, minutes: number) => {
    const [h, m] = hourToMinutes(hour);
    const startMs = fromLocal(date, h, m, timeZone) + rng.int(0, 59_999);
    blocks.push({ startMs, minutes: Math.max(5, Math.round(minutes)), end: 'normal' });
  };

  for (let index = 0; index <= days; index++) {
    if (index >= holidayStart && index < holidayStart + holidayLength) continue;
    const date = addDays(first, index);
    const weekend = weekdayOf(date) >= 6;
    if (!rng.chance(weekend ? pattern.playChance.weekend : pattern.playChance.weekday)) continue;

    const range = weekend ? pattern.blockMinutes.weekend : pattern.blockMinutes.weekday;
    if (weekend && rng.chance(pattern.weekendDayBlockChance)) {
      add(date, rng.float(10.5, 13.5), rng.int(...range));
    }
    if (rng.chance(pattern.lateNightChance)) {
      // Starts late, runs past midnight.
      add(date, rng.float(22.75, 23.6), rng.int(Math.max(range[0], 60), Math.max(range[1], 120)));
    } else {
      add(date, rng.float(...pattern.eveningStart), rng.int(...range));
    }
  }

  return blocks
    .sort((a, b) => a.startMs - b.startMs)
    .filter((block) => block.startMs >= fromMs && blockEndMs(block) < untilMs);
}

/**
 * Adds `forced` blocks and drops planned blocks that would overlap them (or
 * come closer than `MIN_GAP_MS`). Earlier entries win: a forced block that
 * clashes with an earlier forced block is dropped too, and so is a planned
 * block that clashes with an earlier planned one.
 */
export function mergeBlocks(planned: readonly Block[], forced: readonly Block[]): Block[] {
  const clashes = (a: Block, b: Block) =>
    a.startMs < blockEndMs(b) + MIN_GAP_MS && b.startMs < blockEndMs(a) + MIN_GAP_MS;
  const kept: Block[] = [];
  for (const block of [...forced, ...planned]) {
    if (!kept.some((other) => clashes(block, other))) kept.push(block);
  }
  return kept.sort((a, b) => a.startMs - b.startMs);
}
