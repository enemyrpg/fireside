import type { AccountScope, Event, WeeklyResponse } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { accounts, weeklySummaries } from '../db/schema.js';
import type { Queryable as Db } from '../db/index.js';
import { ownedAccountIds } from '../read/accounts.js';
import { localUserId } from '../users/users.js';
import { weeklySummary } from '../read/weekly.js';
import { PROJECTIONS, rebuildProjections } from './index.js';
import {
  emptyRun,
  eventFactory,
  expectOrderIndependent,
  ingestBatch,
  runRebuild,
  seededRandom,
  sessionIdOf,
  shuffled,
  type TestRun,
} from './testing.js';
import { earliestAffected } from './weekly-summaries.js';

// Weekly summaries are stored when a completed week is first read, and the
// projection deletes stored weeks an event can change. Whatever order events
// arrive in, and whenever weeks are read in between, the answers must be the
// same as computing everything from scratch after a rebuild.

const TZ = 'Europe/Oslo';
/** All weeks below are complete at this time. */
const NOW = new Date('2027-01-20T12:00:00.000Z');
const WEEKS = ['2026-W51', '2026-W52', '2026-W53', '2027-W01', '2027-W02'];

const f = eventFactory();
const HASHES = ['1111111111', '2222222222'];

/** Two accounts, a session every ~2 days from 14 Dec to 12 Jan, crossing week and year boundaries. */
function buildEvents(): Event[] {
  const events: Event[] = [];
  const random = seededRandom(7);
  let session = 0;
  for (const [index, accountHash] of HASHES.entries()) {
    let xp = 1000;
    let level = 10;
    let kc = 5;
    for (let day = 0; day < 30; day += 2 + index) {
      session += 1;
      const options = { accountHash, sessionId: sessionIdOf(session) };
      // 22:50 UTC: sessions run across local midnight (23:50 local).
      const startMs = Date.parse('2026-12-14T22:50:00.000Z') + day * 86_400_000;
      const at = (minute: number) => new Date(startMs + minute * 60_000).toISOString();
      if (session % 3 !== 0) events.push(f.sessionStart(at(0), options));
      for (let minute = 1; minute <= 20; minute++) {
        events.push(
          f.heartbeat(at(minute), {
            ...options,
            payload: { world: 300 + ((session + minute) % 3), worldTypes: [] },
          }),
        );
      }
      events.push(f.afk(at(3), at(8), options));
      xp += Math.floor(random() * 5000);
      if (random() < 0.5) level += 1;
      events.push(f.xpSnapshot(at(2), { SLAYER: { xp, level }, MAGIC: xp % 700 }, options));
      events.push(
        f.xpSnapshot(at(15), { SLAYER: { xp: xp + 400, level }, MAGIC: xp % 700 }, options),
      );
      kc += 1 + Math.floor(random() * 3);
      events.push(f.kc(at(5), { killCount: kc, boss: day % 4 ? 'Vorkath' : 'Zulrah', ...options }));
      events.push(
        f.loot(at(10), {
          geValue: 1000 + Math.floor(random() * 9000),
          killCount: kc + 1,
          ...options,
        }),
      );
      if (session % 4 === 0) {
        events.push(
          f.loot(at(12), { source: { type: 'PLAYER', name: null }, geValue: 777, ...options }),
        );
      }
      // Bank, quests, diaries and pets. The second account is a minute later,
      // so no two entries of different accounts tie on time.
      events.push(
        f.bankSnapshot(at(16 + index), {
          ...options,
          payload: {
            items: [
              {
                itemId: 995,
                name: 'Coins',
                quantity: 1000 + Math.floor(random() * 9000),
                placeholder: false,
                gePrice: 1,
                haPrice: 1,
              },
            ],
          },
        }),
      );
      if (session % 3 === 1) events.push(f.potionStorage(at(17 + index), options));
      const finished = Math.floor(day / 5);
      events.push(
        f.questsSnapshot(at(18 + index), {
          ...options,
          questPoints: finished * 2,
          quests: Object.fromEntries(
            [0, 1, 2, 3, 4, 5].map((n) => [
              `QUEST_${String(n)}`,
              n < finished ? 'FINISHED' : 'NOT_STARTED',
            ]),
          ),
        }),
      );
      events.push(
        f.diariesSnapshot(at(19 + index), {
          ...options,
          diaries: {
            ARDOUGNE: (['EASY', 'MEDIUM', 'HARD'] as const).slice(0, Math.floor(day / 8)),
          },
        }),
      );
      if (session % 6 === 2) events.push(f.petDrop(at(9 + index), options));
      if (session % 5 !== 0) events.push(f.sessionEnd(at(21), options));
    }
  }
  return events;
}

const events = buildEvents();

/**
 * Every week for every account and `all`, keyed by account hash (account IDs
 * depend on arrival order), without `computedAt` or loot event IDs.
 */
function readAll(run: TestRun): Record<string, unknown> {
  const db = run.database.db;
  const hashOf = new Map(
    db
      .select({ id: accounts.id, hash: accounts.accountHash })
      .from(accounts)
      .all()
      .map((row) => [row.id, row.hash]),
  );
  const scopes: AccountScope[] = [...allIds(db), 'all'];
  const result: Record<string, unknown> = {};
  for (const scope of scopes) {
    for (const week of WEEKS) {
      const body: Partial<WeeklyResponse> = weeklySummary(
        db,
        idsOf(db, scope),
        week,
        TZ,
        NOW.getTime(),
      );
      delete body.computedAt;
      const key = scope === 'all' ? 'all' : (hashOf.get(scope) ?? '?');
      result[`${key} ${week}`] = comparable(body, hashOf);
    }
  }
  return result;
}

/** The body with every `accountId` as the account's hash, and no loot event IDs. */
function comparable(value: unknown, hashOf: ReadonlyMap<number, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => comparable(item, hashOf));
  if (value === null || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === 'lootEventId') continue;
    if (key === 'accountId') copy.account = hashOf.get(field as number);
    else copy[key] = comparable(field, hashOf);
  }
  return copy;
}

/** The (single test) user's account IDs: what `all` reads. */
function allIds(db: Db): number[] {
  return ownedAccountIds(db, localUserId(db));
}

/** The account IDs a route would pass for `scope`. */
function idsOf(db: Db, scope: AccountScope): number[] {
  return scope === 'all' ? allIds(db) : [scope];
}

describe('weekly summaries projection', () => {
  it('deletes from the earliest instant an event can change', () => {
    const afk = f.afk('2027-01-03T22:58:00.000Z', '2027-01-03T23:01:00.000Z');
    expect(earliestAffected(afk)).toBe('2027-01-03T22:58:00.000Z');
    const kc = f.kc('2027-01-03T22:59:00.000Z');
    expect(earliestAffected(kc)).toBe('2027-01-03T22:59:00.000Z');
  });

  it('keeps the derived tables order independent', () => {
    expectOrderIndependent(events.slice(0, 120), { shuffles: 5 });
  });

  it('gives the same weeks however events arrive and whenever weeks are read', () => {
    const expected = readAll(runRebuild(events, PROJECTIONS, NOW));
    // Sanity: the data has content in every section somewhere.
    expect(JSON.stringify(expected)).toContain('"mostPlayedWorld"');
    expect(JSON.stringify(expected)).toContain('"bosses"');
    expect(JSON.stringify(expected)).toContain('"PLAYER"');
    for (const section of ['"pets":{', '"bank":{', '"quests":{', '"diaries":[{']) {
      expect(JSON.stringify(expected)).toContain(section);
    }

    for (const seed of [1, 2, 3]) {
      const random = seededRandom(seed);
      const run = emptyRun();
      const order = shuffled(events, random);
      for (let start = 0; start < order.length;) {
        const size = 1 + Math.floor(random() * 40);
        ingestBatch(run, order.slice(start, start + size), PROJECTIONS, NOW);
        start += size;
        // Read (and so store) a few weeks between batches, like a dashboard
        // open while the plugin sends its backlog.
        const db = run.database.db;
        const scopes: AccountScope[] = [...allIds(db), 'all'];
        for (let i = 0; i < 3; i++) {
          const scope = scopes[Math.floor(random() * scopes.length)] ?? 'all';
          const week = WEEKS[Math.floor(random() * WEEKS.length)] ?? '2026-W53';
          weeklySummary(db, idsOf(db, scope), week, TZ, NOW.getTime());
        }
      }
      expect(run.failed).toEqual([]);
      expect(readAll(run), `seed ${String(seed)}`).toEqual(expected);

      // Rebuild empties the table; reading fills it again with the same weeks.
      expect(run.database.db.select().from(weeklySummaries).all().length).toBeGreaterThan(0);
      rebuildProjections(run.database.db, { projections: PROJECTIONS, now: () => NOW });
      expect(run.database.db.select().from(weeklySummaries).all()).toEqual([]);
      expect(readAll(run), `seed ${String(seed)} after rebuild`).toEqual(expected);
    }
  }, 30_000);
});
