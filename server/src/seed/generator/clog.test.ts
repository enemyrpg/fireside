import { describe, expect, it } from 'vitest';
import { parseActivities, parseCollectionLog } from '../../clog/runeprofile.js';
import { CLOG_LAYOUT, simulateCollectionLog, type ClogSeedSession } from './clog.js';
import { generateSeed } from './generate.js';
import { PROFILES } from './profiles.js';
import { createRng } from './rng.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// The seed's collection logs. Bodies in the shape of RuneProfile's public API,
// the same for the same seed, and never part of the events.

const OPTIONS = {
  seed: 5,
  accounts: 3,
  months: 3,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

describe('the collection log layout', () => {
  it('has the five tabs of the game, and pages with unique names and items', () => {
    expect(CLOG_LAYOUT.map((tab) => tab.name)).toEqual([
      'Bosses',
      'Raids',
      'Clues',
      'Minigames',
      'Other',
    ]);
    const pages = CLOG_LAYOUT.flatMap((tab) => tab.pages);
    expect(new Set(pages.map((page) => page.name)).size).toBe(pages.length);
    for (const page of pages) {
      expect(page.items.length, page.name).toBeGreaterThan(0);
      expect(new Set(page.items.map(([id]) => id)).size, page.name).toBe(page.items.length);
    }
  });

  it('gives an item the same name on every page', () => {
    const names = new Map<number, string>();
    for (const [id, name] of CLOG_LAYOUT.flatMap((tab) => tab.pages.flatMap((p) => p.items))) {
      expect(names.get(id) ?? name, String(id)).toBe(name);
      names.set(id, name);
    }
  });

  it('repeats every pet on "All Pets"', () => {
    const pages = CLOG_LAYOUT.flatMap((tab) => tab.pages);
    const allPets = pages.find((page) => page.name === 'All Pets');
    const elsewhere = new Set(
      pages.filter((page) => page !== allPets).flatMap((page) => page.items.map(([id]) => id)),
    );
    expect(allPets?.items.filter(([id]) => elsewhere.has(id)).length).toBeGreaterThan(10);
  });
});

describe('seed collection logs', () => {
  const data = generateSeed(OPTIONS);

  it('gives the main and the iron a collection log, and the third account none', () => {
    const profiles = data.collectionLogs.map(
      (log) => data.accounts.find((account) => account.accountHash === log.accountHash)?.profile,
    );
    expect(profiles).toEqual(['main', 'iron']);
  });

  it('is the same for the same seed and until, and differs with the seed', () => {
    expect(generateSeed(OPTIONS).collectionLogs).toEqual(data.collectionLogs);
    expect(generateSeed({ ...OPTIONS, seed: 6 }).collectionLogs).not.toEqual(data.collectionLogs);
  });

  it('has bodies the RuneProfile parsers read, inside the window and in time order', () => {
    for (const log of data.collectionLogs) {
      expect(log.snapshots[0]?.kind).toBe('COLLECTION_LOG');
      expect(log.snapshots.some((snapshot) => snapshot.kind === 'ACTIVITIES')).toBe(true);
      let previous = data.from.toISOString();
      for (const snapshot of log.snapshots) {
        const json = JSON.parse(snapshot.body) as unknown;
        if (snapshot.kind === 'COLLECTION_LOG') expect(parseCollectionLog(json)).toHaveLength(5);
        else expect(parseActivities(json).entries.length).toBeGreaterThan(0);
        expect(snapshot.fetchedAt >= previous).toBe(true);
        expect(snapshot.fetchedAt <= data.until.toISOString()).toBe(true);
        previous = snapshot.fetchedAt;
      }
    }
  });

  it('only ever gains items, and ends at the counts it reports', () => {
    for (const log of data.collectionLogs) {
      const counts = log.snapshots
        .filter((snapshot) => snapshot.kind === 'COLLECTION_LOG')
        .map((snapshot) => JSON.parse(snapshot.body) as { obtained: number; total: number });
      expect(counts.length).toBeGreaterThan(3);
      counts.forEach((count, index) => {
        expect(count.total).toBe(log.total);
        if (index > 0) expect(count.obtained).toBeGreaterThan(counts[index - 1]?.obtained ?? 0);
      });
      expect(counts.at(-1)?.obtained).toBe(log.obtained);
      expect(log.obtained).toBeLessThan(log.total);
    }
  });

  /** Two-hour sessions every evening, some ending with a hop or a crash. */
  function evenings(fromMs: number, untilMs: number, seed: number): ClogSeedSession[] {
    const rng = createRng(seed).fork('evenings');
    const out: ClogSeedSession[] = [];
    for (let dayMs = fromMs; dayMs < untilMs - DAY_MS; dayMs += DAY_MS) {
      const startMs = dayMs + 18 * HOUR_MS;
      const roll = rng.float(0, 1);
      if (roll < 0.15) {
        // A world hop: two parts 30 seconds apart.
        out.push({ startMs, endMs: startMs + HOUR_MS, end: 'hop' });
        out.push({
          startMs: startMs + HOUR_MS + 30_000,
          endMs: startMs + 2 * HOUR_MS,
          end: 'logout',
        });
      } else {
        out.push({ startMs, endMs: startMs + 2 * HOUR_MS, end: roll < 0.25 ? 'crash' : 'logout' });
      }
    }
    return out;
  }

  it('dates an item after the read before it, and reads after sessions end', () => {
    const untilMs = OPTIONS.until.getTime();
    const fromMs = untilMs - 90 * DAY_MS;
    let failed = 0;
    let inHopGap = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const sessions = evenings(fromMs, untilMs, seed);
      const logs = PROFILES.flatMap((profile) => {
        const rng = createRng(seed).fork(`clog:${profile.key}`);
        return simulateCollectionLog(profile, 'hash', fromMs, untilMs, sessions, rng) ?? [];
      });
      expect(logs).toHaveLength(2);
      for (const log of logs) {
        const reads = log.reads.map(Date.parse);
        // Every read is 2–3 minutes after a session closed (crash: +10 minutes).
        for (const read of reads) {
          expect(
            sessions.some((s) => {
              if (s.end === 'hop') return false;
              const closed = s.endMs + (s.end === 'crash' ? 10 * MINUTE_MS : 0);
              return read >= closed + 2 * MINUTE_MS && read <= closed + 3 * MINUTE_MS;
            }),
          ).toBe(true);
        }
        // A session after the first read without its read: that read failed.
        failed += sessions.filter((s) => {
          if (s.end === 'hop') return false;
          const closed = s.endMs + (s.end === 'crash' ? 10 * MINUTE_MS : 0);
          if (closed < (reads[0] ?? Infinity) || closed + 3 * MINUTE_MS > untilMs) return false;
          return !reads.some(
            (read) => read >= closed + 2 * MINUTE_MS && read <= closed + 3 * MINUTE_MS,
          );
        }).length;
        for (const snapshot of log.snapshots) {
          const at = Date.parse(snapshot.fetchedAt);
          expect(reads).toContain(at);
          if (snapshot.kind === 'COLLECTION_LOG') continue;
          const before = reads.filter((read) => read < at).at(-1) ?? Number.NaN;
          for (const entry of parseActivities(JSON.parse(snapshot.body) as unknown).entries) {
            const obtained = Date.parse(entry.obtainedAt);
            expect(obtained).toBeLessThan(at);
            expect(obtained).toBeGreaterThan(before);
            const inSession = sessions.some((s) => obtained >= s.startMs && obtained <= s.endMs);
            if (!inSession) inHopGap++;
          }
        }
      }
    }
    // Some reads fail, and some items drop between two hop parts.
    expect(failed).toBeGreaterThan(0);
    expect(inHopGap).toBeGreaterThan(0);
  });

  it('never has more than one of a pet', () => {
    const pets = new Set(
      CLOG_LAYOUT.flatMap((tab) => tab.pages)
        .find((page) => page.name === 'All Pets')
        ?.items.map(([id]) => id),
    );
    for (const log of data.collectionLogs) {
      const last = log.snapshots.findLast((snapshot) => snapshot.kind === 'COLLECTION_LOG');
      const tabs = parseCollectionLog(JSON.parse(last?.body ?? '{}'));
      const owned = tabs
        .flatMap((tab) => tab.pages.flatMap((page) => page.items))
        .filter((item) => pets.has(item.itemId) && item.quantity > 0);
      expect(owned.length).toBeGreaterThan(0);
      expect(owned.every((item) => item.quantity === 1)).toBe(true);
    }
  });

  it('has no account name, image or link in a body', () => {
    const names = ['Seed Main', 'Seed Iron', 'Iron Seedling', 'Seed Alt'];
    for (const snapshot of data.collectionLogs.flatMap((log) => log.snapshots)) {
      for (const name of names) expect(snapshot.body.includes(name)).toBe(false);
      expect(/https?:|data:|\.png|base64/i.test(snapshot.body)).toBe(false);
    }
  });
});
