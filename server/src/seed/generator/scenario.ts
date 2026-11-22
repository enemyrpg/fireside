import {
  fromLocal,
  HOUR_MS,
  MINUTE_MS,
  offsetChanges,
  toLocal,
  type AccountType,
} from '@fireside/shared';
import type { Profile } from './profiles.js';
import { ARCHIVE_RELEASE_MS } from './raids.js';
import type { Rng } from './rng.js';
import { blockEndMs, mergeBlocks, type Block } from './schedule.js';

// Scripted edge cases, placed at fractions of the window so that even a
// short run (two weeks) has them.

export interface Backlog {
  account: number;
  /** Events of the account in [fromMs, toMs) are delivered at `toMs`, shuffled. */
  fromMs: number;
  toMs: number;
}

export interface Scenario {
  blocks: Block[][];
  backlog: Backlog | null;
  nameAt: (account: number, ms: number) => string;
  typeAt: (account: number, ms: number) => AccountType;
}

/** How long the backlog account is offline. */
const BACKLOG_MS = 26 * HOUR_MS;
/** Length of the session that is still running at `until`. */
const OPEN_SESSION_MINUTES = 40;

export function buildScenario(
  profiles: readonly Profile[],
  planned: readonly Block[][],
  fromMs: number,
  untilMs: number,
  timeZone: string,
  rng: Rng,
): Scenario {
  const at = (fraction: number) => fromMs + Math.round((untilMs - fromMs) * fraction);
  const blocks = planned.map((list) => [...list]);
  const mainIndex = profiles.findIndex((profile) => profile.key === 'main');
  const ironIndex = profiles.findIndex((profile) => profile.key === 'iron');
  const evening = (fraction: number, hour: number, minute: number) =>
    fromLocal(toLocal(at(fraction), timeZone), hour, minute, timeZone) + rng.int(0, 59_999);

  if (mainIndex >= 0) {
    const forced: Block[] = [];
    // A session that starts before midnight and ends after it.
    forced.push({ startMs: evening(0.25, 23, 20), minutes: 100, end: 'normal' });
    // A wilderness trip with a player kill, and a world hop.
    forced.push({
      startMs: evening(0.15, 19, 0),
      minutes: 90,
      end: 'normal',
      activity: 'calvarion',
      forcePvp: true,
    });
    forced.push({ startMs: evening(0.4, 19, 30), minutes: 120, end: 'normal', forceHop: true });
    // The boss that is not in the alias table.
    forced.push({
      startMs: evening(0.6, 20, 0),
      minutes: 60,
      end: 'normal',
      activity: 'seedUnknownBoss',
    });
    // A session across each DST change (e.g. 03:00 → 02:00 in late October).
    for (const change of offsetChanges(fromMs + 2 * HOUR_MS, untilMs - 4 * HOUR_MS, timeZone)) {
      forced.push({
        startMs: change - HOUR_MS + rng.int(0, 59_999),
        minutes: 150,
        end: 'normal',
        noHop: true,
      });
    }
    // Still playing at `until`: the last heartbeat is under a minute old.
    forced.push({
      startMs: untilMs - OPEN_SESSION_MINUTES * MINUTE_MS - 30_000,
      minutes: OPEN_SESSION_MINUTES,
      end: 'open',
      noHop: true,
    });
    // A raid evening with your own purple and a teammate's, so even a short
    // run has raids. Its own fork keeps the times above unchanged.
    const raidDay = toLocal(at(0.08), timeZone);
    forced.push({
      startMs: fromLocal(raidDay, 19, 0, timeZone) + rng.fork('raid-block').int(0, 59_999),
      minutes: 150,
      end: 'normal',
      noHop: true,
      endReason: 'logout',
      activity: 'toa',
      forcePurples: ['SELF', 'TEAMMATE'],
    });
    // The evening after The Fractured Archive came out, if the window has it.
    const releaseEvening =
      fromLocal(toLocal(ARCHIVE_RELEASE_MS + 24 * HOUR_MS, timeZone), 19, 30, timeZone) +
      rng.fork('archive-block').int(0, 59_999);
    if (releaseEvening > fromMs && releaseEvening + 3 * HOUR_MS < untilMs) {
      forced.push({
        startMs: releaseEvening,
        minutes: 120,
        end: 'normal',
        noHop: true,
        endReason: 'logout',
        activity: 'tfa',
      });
    }
    blocks[mainIndex] = mergeBlocks(blocks[mainIndex] ?? [], forced);
  }

  // The iron plays while it has its other name (see `nameAt`).
  if (ironIndex >= 0) {
    const forced: Block[] = [
      {
        startMs: evening(0.52, 20, 0),
        minutes: 75,
        end: 'normal',
        noHop: true,
        endReason: 'client_closed',
      },
      // Minigame loot (EVENT source).
      { startMs: evening(0.3, 19, 0), minutes: 60, end: 'normal', activity: 'wintertodt' },
    ];
    blocks[ironIndex] = mergeBlocks(blocks[ironIndex] ?? [], forced);
  }

  // Offline backlog: the alt (or the iron with two accounts) loses its
  // connection mid-session. The rest of that session and everything in the
  // next 26 hours arrives late, out of order, after the server has timed the
  // session out. Its session.end then replaces the timeout.
  let backlog: Backlog | null = null;
  const backlogIndex = profiles.findIndex((p) => p.key === (profiles.length >= 3 ? 'alt' : 'iron'));
  if (backlogIndex >= 0) {
    const block: Block = {
      startMs: evening(0.65, 19, 30),
      minutes: 45,
      end: 'normal',
      noHop: true,
      endReason: 'logout',
    };
    blocks[backlogIndex] = mergeBlocks(blocks[backlogIndex] ?? [], [block]);
    const dropMs = block.startMs + Math.floor(block.minutes / 2) * MINUTE_MS + 30_000;
    const toMs = Math.min(dropMs + BACKLOG_MS, untilMs - MINUTE_MS);
    if (toMs > blockEndMs(block) + MINUTE_MS) {
      backlog = { account: backlogIndex, fromMs: dropMs, toMs };
    }
  }

  // A few crashed clients: heartbeats just stop, the server times them out.
  // Blocks with a scripted end are left alone.
  const inBacklog = (index: number, block: Block) =>
    backlog?.account === index &&
    blockEndMs(block) >= backlog.fromMs &&
    block.startMs < backlog.toMs;
  const crashes: Record<Profile['key'], number[]> = { main: [0.2, 0.8], iron: [0.45], alt: [0.3] };
  profiles.forEach((profile, index) => {
    for (const fraction of crashes[profile.key]) {
      const block = blocks[index]?.find(
        (b) => b.end === 'normal' && b.endReason === undefined && b.startMs >= at(fraction),
      );
      if (block && !inBacklog(index, block)) block.end = 'crash';
    }
  });

  // Name change and back, and an account type change (hardcore status lost).
  const renameFrom = at(0.35);
  const renameTo = at(0.7);
  const typeChange = at(0.5);
  return {
    blocks,
    backlog,
    nameAt: (account, ms) => {
      const profile = profiles[account];
      if (!profile) throw new RangeError(`No account ${String(account)}`);
      return profile.otherName !== undefined && ms >= renameFrom && ms < renameTo
        ? profile.otherName
        : profile.displayName;
    },
    typeAt: (account, ms) => {
      const profile = profiles[account];
      if (!profile) throw new RangeError(`No account ${String(account)}`);
      return profile.laterAccountType !== undefined && ms >= typeChange
        ? profile.laterAccountType
        : profile.accountType;
    },
  };
}
